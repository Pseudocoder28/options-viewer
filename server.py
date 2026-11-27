# /// script
# requires-python = ">=3.10"
# dependencies = ["yfinance"]
# ///
"""Options Terminal: local data server and web app.

    uv run server.py                 # opens http://127.0.0.1:8765
    uv run server.py --port 9000 --no-browser

On a Mac, `python3 make_app.py` builds a double-click app that runs this for you.

Data sources (free, no key, about 15 minutes delayed):
  option chains   Nasdaq public API: the complete listing for US stocks and ETFs.
                  Yahoo Finance is the fallback: indexes (SPX, VIX, NDX, RUT) and anything Nasdaq lacks.
  quotes, price history, ticker search, risk-free rate   Yahoo Finance (through yfinance)
  what a holding is (sector, country) and what a fund holds inside   Yahoo Finance (through yfinance)
  holdings at your brokerage (optional, only once you link it)   SnapTrade, read-only

To add a real-time source, write one more chain_<name>(symbol, kind) that returns the same
row dicts as chain_nasdaq and put it first in get_chain().
"""
import argparse
import base64
import datetime as dt
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf

STATIC = (Path(__file__).parent / "static").resolve()
NY = ZoneInfo("America/New_York")
SYMBOL = re.compile(r"[A-Z0-9.^=\-]{1,20}")                      # a ticker as Yahoo writes it; used with fullmatch
LOCAL_HOSTS = {"127.0.0.1", "localhost"}                          # the only names this server answers to
CACHE_MAX = 200                                                   # entries kept in memory before the oldest is dropped
OCC_URL = re.compile(r"([a-z0-9.]+?)-*(\d{6})[cp](\d{8})$")      # tail of a Nasdaq contract link
OCC_SYM = re.compile(r"^([A-Z0-9.]+?)(\d{6})[CP]\d{8}$")          # Yahoo contract symbol
NASDAQ_URL = ("https://api.nasdaq.com/api/quote/{sym}/option-chain?assetclass={cls}&limit=50000"
              "&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all")
HEADERS = {"User-Agent": "options-terminal/1.0 (personal research tool)", "Accept": "application/json"}
# Index options with these roots settle at the open (the last trade is the day before).
AM_SETTLED = {"SPX", "NDX", "RUT", "VIX", "VIXW"}
RANGES = {"1D": ("1d", "5m"), "5D": ("5d", "15m"), "1M": ("1mo", "1h"), "3M": ("3mo", "1d"),
          "6M": ("6mo", "1d"), "YTD": ("ytd", "1d"), "1Y": ("1y", "1d"), "2Y": ("2y", "1d"),
          "5Y": ("5y", "1wk"), "MAX": ("max", "1mo")}
CHAIN_FIELDS = ["e", "strike", "put", "bid", "ask", "last", "chg", "vol", "oi", "lastTrade"]
# Yahoo names a fund's sectors in its own shorthand. These are the names it uses for single stocks.
SECTORS = {"technology": "Technology", "financial_services": "Financial Services", "healthcare": "Healthcare",
           "consumer_cyclical": "Consumer Cyclical", "consumer_defensive": "Consumer Defensive",
           "communication_services": "Communication Services", "industrials": "Industrials", "energy": "Energy",
           "utilities": "Utilities", "realestate": "Real Estate", "basic_materials": "Basic Materials"}
# What a fund is made of, grouped the way the Portfolio view shows it (keys are Yahoo's).
ASSETS = {"Stocks": ("stockPosition",), "Bonds": ("bondPosition", "convertiblePosition"),
          "Cash": ("cashPosition",), "Other": ("preferredPosition", "otherPosition")}
# The optional brokerage link. Its keys live outside this folder, so they can never end up in git.
CONFIG = Path(os.environ.get("OPTIONS_TERMINAL_CONFIG") or Path.home() / ".config" / "options-terminal")
SNAPTRADE_KEYS = CONFIG / "snaptrade.json"
SNAPTRADE_URL = os.environ.get("SNAPTRADE_URL", "https://api.snaptrade.com")       # another address only in tests
UUID = re.compile(r"[0-9a-fA-F-]{8,64}")                           # an account id as SnapTrade writes it
FUND_LIKE = re.compile(r"\b(ETF|Fund|Index|Portfolio|Trust)\b", re.I)      # a fund inside another fund, by its name


class ApiError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


# In-memory cache: key -> (expiry time, value). Expired values are kept so that a failing source
# can still be answered with the last good data; the oldest entries go once there are CACHE_MAX.
_cache = {}
_locks = {}
_locks_guard = threading.Lock()
_last_request = [time.time()]      # read by the idle watchdog (see --idle-exit)


def cached(key, ttl, fn):
    """Return a fresh value, or the last good one (marked stale) when the source fails.

    Requests for the same key that arrive together wait for one fetch instead of each making
    their own (the page asks for a quote and a chain at once, and the chain needs the quote).
    """
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        try:
            value = fn()
        except Exception:
            if hit and isinstance(hit[1], dict):
                return {**hit[1], "stale": True}
            raise
        _cache.pop(key, None)                    # re-inserting moves the key to the "newest" end
        _cache[key] = (time.time() + ttl, value)
        while len(_cache) > CACHE_MAX:
            oldest = next(iter(_cache))
            del _cache[oldest]
            _locks.pop(oldest, None)
        return value


def clean(x, digits=None):
    """Float or None. NaN, blanks and Nasdaq's '--' all become None."""
    if x is None or x == "" or x == "--" or x == "N/A":
        return None
    try:
        v = float(str(x).replace(",", "").replace("$", "").replace("%", "")) if isinstance(x, str) else float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return round(v, digits) if digits is not None else v


def price_of(x):
    """A price as a float or None: four decimals, or eight for the tiny prices some coins trade at."""
    v = clean(x)
    return None if v is None else round(v, 4 if abs(v) >= 1 else 8)


def http_json(url, timeout=25):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    return json.loads(raw)


# ---------------------------------------------------------------- quotes

def risk_free_rate():
    def fetch():
        percent = clean(yf.Ticker("^IRX").fast_info.last_price)      # 13-week Treasury bill yield, e.g. 3.6
        if percent is None:
            raise ValueError("no Treasury bill yield")
        return {"rate": round(percent / 100, 5)}
    try:
        return cached("rate", 3600, fetch)["rate"]
    except Exception:
        return 0.04


def get_quote(symbol):
    def fetch():
        tk = yf.Ticker(symbol)
        try:
            info = tk.info or {}
        except Exception:
            info = {}
        try:
            fast = tk.fast_info
            fast_price, fast_prev = clean(fast.last_price), clean(fast.previous_close)
        except Exception:
            fast, fast_price, fast_prev = None, None, None
        price = clean(info.get("regularMarketPrice")) or fast_price
        if price is None:
            raise ApiError(f"No quote found for {symbol}. Check the ticker.", 404)
        prev = clean(info.get("regularMarketPreviousClose")) or clean(info.get("previousClose")) or fast_prev
        now = time.time()
        earnings = [clean(info.get(k)) for k in ("earningsTimestampStart", "earningsTimestamp", "earningsTimestampEnd")]
        earnings = sorted(e for e in earnings if e and e > now - 86400)
        div = clean(info.get("dividendYield"))  # yfinance reports percent units, e.g. 1.0 for 1%
        return {
            "symbol": symbol,
            "name": info.get("shortName") or info.get("longName") or symbol,
            "type": (info.get("quoteType") or (fast.quote_type if fast else "") or "").upper(),
            "exchange": info.get("fullExchangeName") or info.get("exchange") or "",
            "currency": info.get("currency") or "USD",
            "price": price, "prevClose": prev,
            "change": round(price - prev, 4) if prev else None,
            "changePct": round((price / prev - 1) * 100, 3) if prev else None,
            "open": clean(info.get("regularMarketOpen")) or clean(info.get("open")),
            "dayHigh": clean(info.get("regularMarketDayHigh")) or clean(info.get("dayHigh")),
            "dayLow": clean(info.get("regularMarketDayLow")) or clean(info.get("dayLow")),
            "volume": clean(info.get("regularMarketVolume")) or clean(info.get("volume")),
            "avgVolume": clean(info.get("averageVolume")),
            "marketCap": clean(info.get("marketCap")),
            "yearHigh": clean(info.get("fiftyTwoWeekHigh")), "yearLow": clean(info.get("fiftyTwoWeekLow")),
            "marketState": info.get("marketState") or "",
            "extPrice": clean(info.get("postMarketPrice")) or clean(info.get("preMarketPrice")),
            "extChangePct": clean(info.get("postMarketChangePercent")) or clean(info.get("preMarketChangePercent")),
            "time": clean(info.get("regularMarketTime")),
            "dividendYield": (div or 0) / 100,
            "beta": clean(info.get("beta")),
            "shortPctFloat": clean(info.get("shortPercentOfFloat")),
            "pe": clean(info.get("trailingPE")),
            "sector": info.get("sector") or "", "industry": info.get("industry") or "",
            "earnings": earnings[0] if earnings else None,
            "rate": risk_free_rate(),
        }
    return cached(("quote", symbol), 20, fetch)


def get_quotes(symbols):
    """Light quotes for the watchlist and the portfolio: price, currency and the day's change."""
    def one(symbol):
        def fetch():
            fast = yf.Ticker(symbol).fast_info
            price, prev = price_of(fast.last_price), price_of(fast.previous_close)
            return {"symbol": symbol, "price": price, "currency": fast.currency or None,
                    "changePct": round((price / prev - 1) * 100, 2) if price and prev else None}
        try:
            return cached(("lite", symbol), 30, fetch)
        except Exception:
            return {"symbol": symbol, "price": None, "currency": None, "changePct": None}
    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(one, symbols))


def fund_makeup(sectors, assets):
    """A fund's sector and asset split with our names, as shares of the fund that add up to about 1."""
    share = lambda value: clean(value, 4) or 0
    return ({SECTORS.get(key, key): share(v) for key, v in (sectors or {}).items() if share(v) > 0},
            {name: round(sum(share((assets or {}).get(key)) for key in keys), 4) for name, keys in ASSETS.items()})


def get_profile(symbol):
    """What a holding is: type, currency, sector and country. For a fund, also what it holds inside."""
    def fetch():
        tk = yf.Ticker(symbol)
        info = tk.info or {}
        kind = (info.get("quoteType") or "").upper()
        if not kind:
            raise ApiError(f"Yahoo has no description of {symbol}.", 404)
        out = {"symbol": symbol, "name": info.get("longName") or info.get("shortName") or symbol, "type": kind,
               "currency": info.get("currency") or None, "sector": info.get("sector") or None,
               "industry": info.get("industry") or None, "country": info.get("country") or None}
        if kind in ("ETF", "MUTUALFUND"):
            try:
                fund = tk.funds_data
                out["sectors"], out["assets"] = fund_makeup(fund.sector_weightings, fund.asset_classes)
                out["top"] = [[str(sym), str(row["Name"]), clean(row["Holding Percent"], 4)]
                              for sym, row in fund.top_holdings.iterrows()]
            except Exception:       # Yahoo describes the fund but not its insides: it is shown as one block
                out["sectors"], out["assets"], out["top"] = {}, {}, []
            out["expense"] = clean(info.get("netExpenseRatio"))       # percent a year, e.g. 0.2
        return out
    return cached(("profile", symbol), 86400, fetch)


def fund_insides(symbol, depth=2, seen=()):
    """A fund's largest holdings as [symbol, name, share of the fund], with any fund among them opened up too.

    A Canadian fund is often a wrapper around one US fund, or a basket of other funds, so its own
    list names no companies. Yahoo lists ten holdings per fund, so the shares cover only part of it.
    """
    found = {}
    for sym, name, share in get_profile(symbol).get("top") or []:
        inner = []
        if depth and share and sym not in seen and FUND_LIKE.search(name or ""):
            try:
                inner = fund_insides(sym, depth - 1, seen + (symbol,))
            except Exception:       # it cannot be opened: it stays in the list as itself
                inner = []
        for inner_sym, inner_name, part in inner or [[sym, name, 1]]:
            entry = found.setdefault(inner_sym, [inner_sym, inner_name, 0])
            entry[2] = round(entry[2] + (share or 0) * part, 5)
    return sorted(found.values(), key=lambda entry: -entry[2])[:25]


def get_profiles(symbols):
    """Profiles for several tickers. One that fails is reported in place, so the rest still arrive."""
    def one(symbol):
        try:
            profile = get_profile(symbol)
            return {**profile, "top": fund_insides(symbol)} if profile.get("top") else profile
        except Exception as exc:
            return {"symbol": symbol, "error": str(exc) or type(exc).__name__}
    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(one, symbols))


_download_lock = threading.Lock()      # yfinance's bulk download keeps its results in one shared place


def get_closes(symbols, rng):
    """Daily closes for several tickers on one shared calendar, for measuring how they move together.

    Weekdays only (a coin's weekend move lands on Monday), adjusted for splits and dividends. A day
    one market was shut repeats its last close; days before a ticker first traded are None.
    """
    if not symbols:
        raise ApiError("No tickers given.", 400)

    def fetch():
        with _download_lock:
            frame = yf.download(symbols, period=RANGES[rng][0], interval="1d", auto_adjust=True,
                                progress=False, threads=True)["Close"]
        frame = frame[frame.index.dayofweek < 5].dropna(how="all").ffill()
        closes = {s: [None if v != v else float(f"{v:.8g}") for v in frame[s]]
                  for s in symbols if s in frame and frame[s].notna().any()}
        if not closes:
            raise ApiError("No price history for these tickers.", 404)
        return {"range": rng, "dates": [day.strftime("%Y-%m-%d") for day in frame.index], "closes": closes}
    return cached(("closes", rng, tuple(sorted(symbols))), 900, fetch)


def get_history(symbol, rng):
    period, interval = RANGES[rng]

    def fetch():
        h = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=False)
        h = h.dropna(subset=["Close"])
        if h.empty:
            raise ApiError(f"No price history for {symbol}.", 404)
        col = lambda name: [clean(v, 4) for v in h[name]]
        return {"symbol": symbol, "range": rng, "interval": interval, "t": [int(ts.timestamp()) for ts in h.index],
                "o": col("Open"), "h": col("High"), "l": col("Low"), "c": col("Close"), "v": col("Volume")}
    return cached(("hist", symbol, rng), 60 if interval.endswith("m") or interval == "1h" else 600, fetch)


def search(query):
    def fetch():
        hits = yf.Search(query, max_results=12, news_count=0).quotes
        return {"results": [{"symbol": h["symbol"], "name": h.get("shortname") or h.get("longname") or "",
                             "type": (h.get("quoteType") or "").upper(), "exchange": h.get("exchDisp") or ""}
                            for h in hits if h.get("symbol")]}
    return cached(("search", query.lower()), 3600, fetch)


# ---------------------------------------------------------------- option chains

def chain_nasdaq(symbol, kind):
    cls = {"EQUITY": "stocks", "ETF": "etf", "INDEX": "index"}.get(kind)
    if not cls:
        return None
    # Nasdaq writes share classes with a dot (BRK.B) where Yahoo, whose spelling the page uses, has a dash (BRK-B).
    url = NASDAQ_URL.format(sym=urllib.parse.quote(symbol.lstrip("^").replace("-", ".")), cls=cls)
    table = (http_json(url).get("data") or {}).get("table") or {}
    rows = []
    for r in table.get("rows") or []:
        m = OCC_URL.search(r.get("drillDownURL") or "")
        if not m or not r.get("strike"):
            continue
        root, ymd, strike = m.group(1).upper().replace(".", ""), m.group(2), int(m.group(3)) / 1000
        exp = f"20{ymd[:2]}-{ymd[2:4]}-{ymd[4:]}"
        for put, p in ((0, "c_"), (1, "p_")):
            rows.append({"root": root, "exp": exp, "put": put, "strike": strike,
                         "bid": clean(r.get(p + "Bid")), "ask": clean(r.get(p + "Ask")),
                         "last": clean(r.get(p + "Last")), "chg": clean(r.get(p + "Change")),
                         "vol": clean(r.get(p + "Volume")), "oi": clean(r.get(p + "Openinterest")),
                         "lastTrade": None})
    return rows or None


def chain_yahoo(symbol, kind):
    tk = yf.Ticker(symbol)
    expiries = tk.options
    if not expiries:
        return None

    def one(exp):
        try:
            chain = tk.option_chain(exp)
        except Exception:      # Yahoo drops the odd request when asked for dozens of expiries at once: ask once more
            chain = tk.option_chain(exp)
        rows = []
        for put, frame in ((0, chain.calls), (1, chain.puts)):
            for r in frame.itertuples():
                m = OCC_SYM.match(r.contractSymbol)
                traded = r.lastTradeDate
                rows.append({"root": m.group(1) if m else symbol.lstrip("^"), "exp": exp, "put": put,
                             "strike": float(r.strike), "bid": clean(r.bid), "ask": clean(r.ask),
                             "last": clean(r.lastPrice), "chg": clean(r.change),
                             "vol": clean(r.volume), "oi": clean(r.openInterest),
                             "lastTrade": int(traded.timestamp()) if traded == traded else None})
        return rows
    with ThreadPoolExecutor(6) as pool:
        return [row for part in pool.map(one, expiries) for row in part] or None


def pack_chain(symbol, kind, source, rows):
    """Group rows into expiries and pack them as compact arrays (see CHAIN_FIELDS)."""
    adjusted = 0
    if kind != "INDEX":
        # Roots other than the ticker itself are contracts adjusted for a split or merger.
        # They do not deliver 100 plain shares, so the pricing math would be wrong for them.
        base = re.sub(r"[^A-Z0-9]", "", symbol)
        standard = [r for r in rows if r["root"] == base]
        if standard:
            adjusted, rows = len(rows) - len(standard), standard
    groups = sorted({(r["exp"], r["root"]) for r in rows})
    per_date = Counter(exp for exp, _ in groups)
    expiries, index = [], {}
    for exp, root in groups:
        am = kind == "INDEX" and root in AM_SETTLED
        day = dt.datetime.fromisoformat(exp).replace(tzinfo=NY)
        close = day.replace(hour=9, minute=30) if am else day.replace(hour=16)
        index[(exp, root)] = len(expiries)
        expiries.append({"date": exp, "root": root, "am": am, "close": int(close.timestamp()),
                         "label": f"{exp} {root}" if per_date[exp] > 1 else exp})
    packed = [[index[(r["exp"], r["root"])], r["strike"], r["put"], r["bid"] or 0, r["ask"] or 0, r["last"], r["chg"],
               r["vol"] or 0, r["oi"] or 0, r["lastTrade"]] for r in rows]
    return {"symbol": symbol, "source": source, "asOf": int(time.time()), "adjustedDropped": adjusted,
            "expiries": expiries, "fields": CHAIN_FIELDS, "rows": packed}


def get_chain(symbol):
    def fetch():
        kind = get_quote(symbol)["type"]
        errors = []
        for source, fn in (("Nasdaq", chain_nasdaq), ("Yahoo", chain_yahoo)):
            try:
                rows = fn(symbol, kind)
                if rows:
                    return pack_chain(symbol, kind, source, rows)
            except Exception as exc:  # try the next source
                errors.append(f"{source}: {exc}")
        if errors:
            raise ApiError("Could not load the option chain. " + " | ".join(errors))
        return {"symbol": symbol, "source": None, "asOf": int(time.time()), "adjustedDropped": 0,
                "expiries": [], "fields": CHAIN_FIELDS, "rows": []}
    return cached(("chain", symbol), 60, fetch)


# ---------------------------------------------------------------- brokerage link (SnapTrade)
# Optional. With a personal SnapTrade key saved on this machine, the Portfolio view reads holdings
# straight from the brokerage instead of from a file. Every call made here only reads: accounts,
# positions, cash and the state of the connection. Nothing in this file can place an order.

def snaptrade_keys():
    """The saved keys as (client id, consumer key), or None when the link has not been set up."""
    try:
        saved = json.loads(SNAPTRADE_KEYS.read_text())
        return str(saved["clientId"]), str(saved["consumerKey"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def snaptrade_signature(consumer_key, path, query, body=None):
    """What SnapTrade expects in the Signature header: an HMAC of the request's body, path and query string."""
    signed = json.dumps({"content": body or None, "path": path, "query": query}, separators=(",", ":"), sort_keys=True)
    return base64.b64encode(hmac.new(consumer_key.encode(), signed.encode(), hashlib.sha256).digest()).decode()


def snaptrade(method, path, body=None, keys=None):
    """One signed call to SnapTrade. When it refuses, the ApiError carries SnapTrade's own explanation."""
    keys = keys or snaptrade_keys()
    if not keys:
        raise ApiError("The live link is not set up.", 409)
    query = urllib.parse.urlencode({"clientId": keys[0], "timestamp": int(time.time())})
    req = urllib.request.Request(
        f"{SNAPTRADE_URL}{path}?{query}", method=method,
        data=json.dumps(body, separators=(",", ":"), sort_keys=True).encode() if body else None,
        headers={**HEADERS, "Content-Type": "application/json",
                 "Signature": snaptrade_signature(keys[1], path, query, body)})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        try:
            said = json.loads(exc.read())
            said = said if isinstance(said, dict) else {}
            detail = said.get("detail") or said.get("message") or said.get("error")
        except ValueError:
            detail = None
        if exc.code == 429:
            raise ApiError("SnapTrade asks for a pause between requests. Try again in a minute.", 429)
        hint = " Check that both key values were pasted in full." if exc.code in (401, 403) else ""
        raise ApiError(f"SnapTrade refused the request ({exc.code}): {detail or exc.reason}.{hint}")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise ApiError(f"SnapTrade could not be reached: {getattr(exc, 'reason', exc)}")


def snaptrade_status():
    """Whether the link is set up, and the brokerage connections behind it. Never includes the keys."""
    if not snaptrade_keys():
        return {"linked": False, "connections": []}
    try:
        found = snaptrade("GET", "/authorizations") or []
    except ApiError as exc:
        return {"linked": True, "connections": [], "error": str(exc)}
    return {"linked": True, "connections": [
        {"name": (c.get("brokerage") or {}).get("display_name") or c.get("name") or "Brokerage",
         "canTrade": c.get("type") == "trade", "broken": bool(c.get("disabled")),
         "delayed": (c.get("data_freshness_mode") or {}).get("snaptrade") == "delayed"}
        for c in found if isinstance(c, dict)]}


def snaptrade_holdings():
    """Positions and cash of every open investment account, as SnapTrade reports them.

    Account numbers are left behind: the page gets each account's name and what is in it.
    """
    def fetch():
        accounts = [a for a in (snaptrade("GET", "/accounts/all") or {}).get("results") or []
                    if a.get("kind") == "investment" and a.get("status") not in ("closed", "archived")
                    and UUID.fullmatch(str(a.get("id")))]
        if not accounts:      # an error is never cached, so the next try after connecting sees the new accounts
            raise ApiError("SnapTrade reports no investment accounts yet. Connect your brokerage first. "
                           "Right after connecting, the first read can take a minute.", 409)

        def one(account):
            held = snaptrade("GET", f"/accounts/{account['id']}/positions/all") or {}
            try:
                cash = snaptrade("GET", f"/accounts/{account['id']}/balances") or []
            except ApiError:      # positions matter more: an account whose cash cannot be read still shows
                cash = []
            return {"name": account.get("display_name") or account.get("raw_type") or "Account",
                    "asOf": (held.get("data_freshness") or {}).get("as_of"),
                    "positions": held.get("results") or [],
                    "cash": [{"currency": (b.get("currency") or {}).get("code"), "amount": clean(b.get("cash"))}
                             for b in cash if isinstance(b, dict)]}
        with ThreadPoolExecutor(3) as pool:
            return {"accounts": list(pool.map(one, accounts)), "fetchedAt": int(time.time())}
    return cached(("snaptrade", "holdings"), 120, fetch)


def snaptrade_portal():
    """A one-time address at SnapTrade for connecting a brokerage. It asks for data access only."""
    url = (snaptrade("POST", "/snapTrade/login", {"connectionType": "read"}) or {}).get("redirectURI") or ""
    host = urllib.parse.urlsplit(url).hostname or ""
    if not (host.endswith(".snaptrade.com") or host == urllib.parse.urlsplit(SNAPTRADE_URL).hostname):
        raise ApiError("SnapTrade did not return a connection page.")
    return {"url": url}


def snaptrade_save(client_id, consumer_key):
    """Keep the keys on this machine, readable by this user only. A pair that SnapTrade rejects is not kept."""
    keys = (str(client_id or "").strip(), str(consumer_key or "").strip())
    if not all(keys) or max(map(len, keys)) > 300:
        raise ApiError("Paste both the client ID and the consumer key.", 400)
    snaptrade("GET", "/authorizations", keys=keys)
    CONFIG.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(SNAPTRADE_KEYS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
        json.dump({"clientId": keys[0], "consumerKey": keys[1]}, out)
    os.chmod(SNAPTRADE_KEYS, 0o600)       # the mode above only applies to a file that is new
    _cache.pop(("snaptrade", "holdings"), None)
    return snaptrade_status()


def snaptrade_forget():
    """Remove the keys from this machine. The connection itself is removed in SnapTrade's dashboard."""
    SNAPTRADE_KEYS.unlink(missing_ok=True)
    _cache.pop(("snaptrade", "holdings"), None)
    return {"linked": False, "connections": []}


# ---------------------------------------------------------------- http

class Server(ThreadingHTTPServer):
    # The default of 5 turns away a burst of connections (a page load opens several at once).
    request_queue_size = 128


class Handler(BaseHTTPRequestHandler):
    server_version = "OptionsTerminal/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_body(self, body, content_type, status=200):
        if len(body) > 1500 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, 5)
            encoding = "gzip"
        else:
            encoding = None
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        try:
            body = json.dumps(obj, separators=(",", ":"), allow_nan=False)
        except ValueError:
            # A NaN or infinity slipped through from a data source: say so rather than drop the connection.
            body, status = json.dumps({"error": "The data source sent a number that cannot be shown. Try again."}), 502
        self.send_body(body.encode(), "application/json", status)

    def from_this_app(self):
        """True for a request made by the app's own page, or by a local tool such as curl.

        The server listens on this machine only, but any web page open in the browser can still ask
        the browser to call it. Two checks keep other sites away from the data endpoints: the Host
        header must name this machine (a site that points its own domain at 127.0.0.1 fails that),
        and the browser must not have marked the request as coming from another site.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in LOCAL_HOSTS and self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    def do_GET(self):
        _last_request[0] = time.time()
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path.startswith("/api/") and not self.from_this_app():
                self.send_json({"error": "This server only answers its own page."}, 403)
            elif url.path == "/api/ping":       # the page's heartbeat: keeps an idle-exit server alive
                self.send_json({"ok": True})
            elif url.path.startswith("/api/"):
                self.api(url.path[5:], urllib.parse.parse_qs(url.query))
            else:
                self.static(url.path)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        """The few requests that change something: saving or removing the brokerage keys, opening a connection page."""
        _last_request[0] = time.time()
        name = urllib.parse.urlsplit(self.path).path.removeprefix("/api/")
        length = self.headers.get("Content-Length") or "0"
        size = int(length) if length.isdigit() else -1
        try:
            # A page on another site can post a plain form without asking first, but not JSON: so JSON is required.
            if not self.from_this_app() or not (self.headers.get("Content-Type") or "").startswith("application/json"):
                self.close_connection = True
                return self.send_json({"error": "This server only answers its own page."}, 403)
            if not 0 <= size <= 4096:
                self.close_connection = True
                return self.send_json({"error": "That request is too large."}, 413)
            try:
                body = json.loads(self.rfile.read(size) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("not an object")
                if name == "snaptrade/keys":
                    out = snaptrade_save(body.get("clientId"), body.get("consumerKey"))
                elif name == "snaptrade/portal":
                    out = snaptrade_portal()
                elif name == "snaptrade/forget":
                    out = snaptrade_forget()
                else:
                    raise ApiError("Unknown endpoint.", 404)
                status = 200
            except ApiError as exc:
                out, status = {"error": str(exc)}, exc.status
            except ValueError:
                out, status = {"error": "That request could not be read."}, 400
            except Exception as exc:
                out, status = {"error": f"{type(exc).__name__}: {exc}"}, 502
            self.send_json(out, status)
            # The body is never logged: it can hold the keys.
            print(f"{status} POST /api/{name}" + (f" error={out['error']}" if status != 200 else ""),
                  file=sys.stderr, flush=True)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def api(self, name, query):
        started = time.time()
        arg = lambda key, default="": (query.get(key) or [default])[0].strip()

        def symbol():
            s = arg("symbol").upper()
            if not SYMBOL.fullmatch(s):
                raise ApiError("That does not look like a ticker.", 400)
            return s

        def symbols(limit=40):
            """The tickers of a comma-separated list: the valid ones, no repeats, at most `limit`."""
            wanted = [s.strip() for s in arg("symbols").upper().split(",")]
            return list(dict.fromkeys(s for s in wanted if SYMBOL.fullmatch(s)))[:limit]
        try:
            if name == "quote":
                out = get_quote(symbol())
            elif name == "chain":
                out = get_chain(symbol())
            elif name == "history":
                rng = arg("range", "1Y").upper()
                if rng not in RANGES:
                    raise ApiError("Unknown range.", 400)
                out = get_history(symbol(), rng)
            elif name == "quotes":
                out = {"quotes": get_quotes(symbols())}
            elif name == "profiles":
                out = {"profiles": get_profiles(symbols())}
            elif name == "closes":
                rng = arg("range", "1Y").upper()
                if RANGES.get(rng, ("", ""))[1] != "1d":
                    raise ApiError("Unknown range.", 400)
                out = get_closes(symbols(60), rng)
            elif name == "search":
                q = arg("q")[:50]
                out = search(q) if q else {"results": []}
            elif name == "snaptrade":
                out = snaptrade_status()
            elif name == "snaptrade/holdings":
                out = snaptrade_holdings()
            else:
                raise ApiError("Unknown endpoint.", 404)
            status = 200
        except ApiError as exc:
            out, status = {"error": str(exc)}, exc.status
        except Exception as exc:
            out, status = {"error": f"{type(exc).__name__}: {exc}"}, 502
        self.send_json(out, status)
        print(f"{status} /api/{name} {dict((k, v[0]) for k, v in query.items())} {time.time() - started:.1f}s"
              + (f" source={out.get('source')}" if name == "chain" and status == 200 else "")
              + (f" error={out['error']}" if status != 200 else ""), file=sys.stderr, flush=True)

    def static(self, path):
        try:
            target = (
                STATIC / ("index.html" if path in ("/", "") else path.removeprefix("/static/").lstrip("/"))
            ).resolve()
            # resolve() first, so ".." cannot climb out of static/
            found = STATIC in target.parents and target.is_file()
        except (OSError, ValueError):  # a name too long or otherwise impossible for the file system
            found = False
        if not found:
            return self.send_body(b"Not found", "text/plain", 404)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        self.send_body(target.read_bytes(), ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))


def _check():
    """Quick self-test of the parsing rules, run at every start. A failure here stops the server with a traceback."""
    assert clean("--") is None and clean("1,234.5") == 1234.5 and clean(float("nan")) is None and clean("0.30") == 0.3
    assert price_of(716.70321) == 716.7032 and price_of(0.0000123456789) == 0.00001235 and price_of("--") is None
    # SnapTrade's signature: the example from its documentation, checked against openssl.
    assert snaptrade_signature("secret", "/symbols", "clientId=YOUR_CLIENT_ID&timestamp=1715123456",
                               {"substring": "AAPL"}) == "NDXBE2rcbQ4APOILcfKnkSW4ZZm5uRQ+HKvYzj6CRC0="
    assert snaptrade_signature("secret", "/accounts/all", "clientId=abc&timestamp=1") == (
        "2mYwtnJQ0o8xYMp1EldIPmAJUOKglETjgGwLV4QMI0k=")
    sectors, assets = fund_makeup({"technology": 0.58, "energy": 0.0, "made_up": 0.1},
                                  {"stockPosition": 0.6, "bondPosition": 0.3, "convertiblePosition": 0.05,
                                   "cashPosition": float("nan")})
    assert sectors == {"Technology": 0.58, "made_up": 0.1}
    assert assets == {"Stocks": 0.6, "Bonds": 0.35, "Cash": 0, "Other": 0}
    assert (SYMBOL.fullmatch("BRK-B") and SYMBOL.fullmatch("^SPX")
            and not SYMBOL.fullmatch("AA\n") and not SYMBOL.fullmatch("../X"))
    m = OCC_URL.search("/market-activity/stocks/gemi/option-chain/call-put-options/gemi--261204c00001500")
    assert m.groups() == ("gemi", "261204", "00001500")
    assert OCC_SYM.match("SPXW261120C07335000").group(1) == "SPXW"
    row = lambda root, exp: {"root": root, "exp": exp, "put": 1, "strike": 2.0, "bid": 0.3, "ask": 0.4, "last": None,
                             "chg": None, "vol": None, "oi": 5, "lastTrade": None}
    packed = pack_chain("GEMI", "EQUITY", "test", [row("GEMI", "2026-12-04"), row("GEMI1", "2026-12-04")])
    assert (packed["adjustedDropped"] == 1 and len(packed["rows"]) == 1
            and packed["rows"][0][:5] == [0, 2.0, 1, 0.3, 0.4])
    index = pack_chain("^SPX", "INDEX", "test", [row("SPX", "2026-12-18"), row("SPXW", "2026-12-18")])
    assert [e["am"] for e in index["expiries"]] == [True, False] and index["expiries"][0]["label"].endswith("SPX")
    assert index["expiries"][1]["close"] - index["expiries"][0]["close"] == 6.5 * 3600


def main():
    _check()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser")
    ap.add_argument("--idle-exit", type=int, default=0, metavar="SECONDS",
                    help="stop after this long without a request "
                         "(the app launcher uses it, so no server is left running)")
    args = ap.parse_args()
    try:
        httpd = Server(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit(f"Could not start on port {args.port}: {exc}. Try --port with another number.")
    url = f"http://127.0.0.1:{args.port}"
    print(f"Options Terminal running at {url}  (Ctrl+C to stop)", flush=True)
    # Open the Yahoo session now, so the first ticker does not pay for it.
    threading.Thread(target=risk_free_rate, daemon=True).start()
    if args.idle_exit:
        def watchdog():
            while time.time() - _last_request[0] < args.idle_exit:
                time.sleep(5)
            print(f"No requests for {args.idle_exit} seconds: stopping.", flush=True)
            httpd.shutdown()
        threading.Thread(target=watchdog, daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

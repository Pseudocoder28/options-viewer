# /// script
# requires-python = ">=3.10"
# dependencies = ["yfinance"]
# ///
"""Options Terminal: local data server and web app.

    uv run server.py                 # opens http://127.0.0.1:8765
    uv run server.py --port 9000 --no-browser

Data sources (free, no key, about 15 minutes delayed):
  option chains   Nasdaq public API: the complete listing for US stocks and ETFs.
                  Yahoo Finance is the fallback: indexes (SPX, VIX, NDX, RUT) and anything Nasdaq lacks.
  quotes, price history, ticker search, risk-free rate   Yahoo Finance (through yfinance)

To add a real-time source, write one more chain_<name>(symbol, kind) that returns the same
row dicts as chain_nasdaq and put it first in get_chain().
"""
import argparse
import datetime as dt
import gzip
import json
import mimetypes
import os
import re
import sys
import threading
import time
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
SYMBOL = re.compile(r"^[A-Z0-9.^=\-]{1,20}$")
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


class ApiError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


# ponytail: in-memory cache with no eviction. Fine for one person; restart the server to clear it.
_cache = {}


def cached(key, ttl, fn):
    """Return a fresh value, or the last good one (marked stale) when the source fails."""
    now = time.time()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    try:
        value = fn()
    except Exception:
        if hit and isinstance(hit[1], dict):
            return {**hit[1], "stale": True}
        raise
    _cache[key] = (now + ttl, value)
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
        return {"rate": round(float(yf.Ticker("^IRX").fast_info.last_price) / 100, 5)}  # 13-week T-bill
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
    """Light quotes for the watchlist."""
    def one(symbol):
        def fetch():
            fast = yf.Ticker(symbol).fast_info
            price, prev = clean(fast.last_price), clean(fast.previous_close)
            return {"symbol": symbol, "price": price, "changePct": round((price / prev - 1) * 100, 2) if price and prev else None}
        try:
            return cached(("lite", symbol), 30, fetch)
        except Exception:
            return {"symbol": symbol, "price": None, "changePct": None}
    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(one, symbols))


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
    url = NASDAQ_URL.format(sym=urllib.parse.quote(symbol.lstrip("^")), cls=cls)
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
                         "bid": clean(r.get(p + "Bid")), "ask": clean(r.get(p + "Ask")), "last": clean(r.get(p + "Last")),
                         "chg": clean(r.get(p + "Change")), "vol": clean(r.get(p + "Volume")),
                         "oi": clean(r.get(p + "Openinterest")), "lastTrade": None})
    return rows or None


def chain_yahoo(symbol, kind):
    tk = yf.Ticker(symbol)
    expiries = tk.options
    if not expiries:
        return None

    def one(exp):
        chain = tk.option_chain(exp)
        rows = []
        for put, frame in ((0, chain.calls), (1, chain.puts)):
            for r in frame.itertuples():
                m = OCC_SYM.match(r.contractSymbol)
                traded = r.lastTradeDate
                rows.append({"root": m.group(1) if m else symbol.lstrip("^"), "exp": exp, "put": put, "strike": float(r.strike),
                             "bid": clean(r.bid), "ask": clean(r.ask), "last": clean(r.lastPrice), "chg": clean(r.change),
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


# ---------------------------------------------------------------- http

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
        self.send_body(json.dumps(obj, separators=(",", ":"), allow_nan=False).encode(), "application/json", status)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            if url.path.startswith("/api/"):
                self.api(url.path[5:], urllib.parse.parse_qs(url.query))
            else:
                self.static(url.path)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def api(self, name, query):
        started = time.time()
        arg = lambda key, default="": (query.get(key) or [default])[0].strip()

        def symbol():
            s = arg("symbol").upper()
            if not SYMBOL.match(s):
                raise ApiError("That does not look like a ticker.", 400)
            return s
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
                symbols = [s for s in arg("symbols").upper().split(",") if SYMBOL.match(s)][:40]
                out = {"quotes": get_quotes(symbols)}
            elif name == "search":
                q = arg("q")[:50]
                out = search(q) if q else {"results": []}
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
        target = (STATIC / ("index.html" if path in ("/", "") else path.removeprefix("/static/").lstrip("/"))).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self.send_body(b"Not found", "text/plain", 404)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        self.send_body(target.read_bytes(), ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))


def _check():
    assert clean("--") is None and clean("1,234.5") == 1234.5 and clean(float("nan")) is None and clean("0.30") == 0.3
    m = OCC_URL.search("/market-activity/stocks/gemi/option-chain/call-put-options/gemi--261204c00001500")
    assert m.groups() == ("gemi", "261204", "00001500")
    assert OCC_SYM.match("SPXW261120C07335000").group(1) == "SPXW"
    row = lambda root, exp: {"root": root, "exp": exp, "put": 1, "strike": 2.0, "bid": 0.3, "ask": 0.4, "last": None,
                             "chg": None, "vol": None, "oi": 5, "lastTrade": None}
    packed = pack_chain("GEMI", "EQUITY", "test", [row("GEMI", "2026-12-04"), row("GEMI1", "2026-12-04")])
    assert packed["adjustedDropped"] == 1 and len(packed["rows"]) == 1 and packed["rows"][0][:5] == [0, 2.0, 1, 0.3, 0.4]
    index = pack_chain("^SPX", "INDEX", "test", [row("SPX", "2026-12-18"), row("SPXW", "2026-12-18")])
    assert [e["am"] for e in index["expiries"]] == [True, False] and index["expiries"][0]["label"].endswith("SPX")
    assert index["expiries"][1]["close"] - index["expiries"][0]["close"] == 6.5 * 3600


def main():
    _check()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser")
    args = ap.parse_args()
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit(f"Could not start on port {args.port}: {exc}. Try --port with another number.")
    url = f"http://127.0.0.1:{args.port}"
    print(f"Options Terminal running at {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

// Portfolio maths: reads a holdings file, values the holdings, splits them by sector, country,
// currency and asset type, and measures how diversified they are.
// Pure functions: no DOM, no network. Checked by tests-portfolio.mjs.
//
// The shapes this file works with:
//
//   holding   { id, symbol, raw, name, kind, qty, currency, cost, costCAD, filePrice, fileValue, account, option,
//               source }
//               symbol                the ticker as Yahoo writes it (SHOP.TO, BTC-CAD); null when it has no live price
//               raw                   the symbol as the file wrote it
//               kind                  'stock' | 'fund' | 'crypto' | 'option' | 'cash' | 'other'
//               qty                   shares, coins or contracts; negative for a short position
//               cost, costCAD         what the whole position cost (its book value): in `currency`, and in
//                                     Canadian dollars when the file says so
//               filePrice, fileValue  the price and value the file stated: used when there is no live price
//               option                { underlying, expiry: 'YYYY-MM-DD', strike, put, occ } for an option, else null
//               source                'file' (imported) | 'hand' (typed in) | 'broker' (read from the brokerage link)
//
//   market    { quotes: { SYM: { price, changePct, currency } }, usdcad, usdcadChangePct,
//               options: { OCC: { mark, chg, delta, gamma, theta, vega, spot, iv } } }
//               usdcad                Canadian dollars for one US dollar
//
//   profile   what /api/profiles says about a ticker: { type, sector, country, sectors, assets, top }
import { occSymbol, MULT } from './model.js';

export const KINDS = ['stock', 'fund', 'crypto', 'option', 'cash', 'other'];
export const SOURCES = ['file', 'hand', 'broker']; // where a holding came from
export const BASES = ['CAD', 'USD'];
export const FX = 'CAD=X'; // Yahoo's ticker for Canadian dollars per US dollar
export const BENCHMARKS = { 'S&P 500': '^GSPC', TSX: '^GSPTSE' }; // the yardsticks a portfolio is compared with
export const BENCHMARK_CURRENCY = { '^GSPC': 'USD', '^GSPTSE': 'CAD' };
const TRADING_DAYS = 252;
const TICKER = /^[A-Z0-9.^=-]{1,20}$/; // the rule the server applies
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const sum = list => list.reduce((a, b) => a + b, 0);
const nyDate = epoch => new Date(epoch * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ---------------------------------------------------------------- reading a holdings file

/** Split CSV text into rows of cells. Handles quoted cells, doubled quotes, and files that use ; or tabs. */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/).find(line => line.trim()) || '';
  const count = sep => firstLine.split(sep).length;
  const sep = [',', ';', '\t'].reduce((best, s) => (count(s) > count(best) ? s : best));
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      rows.push([...row, cell]);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// The column names a holdings file may use. Wealthsimple's own come first in each list.
const COLUMNS = {
  symbol: ['symbol', 'ticker'],
  name: ['name', 'securityname', 'description'],
  type: ['securitytype', 'assettype', 'type'],
  qty: ['quantity', 'qty', 'shares', 'units'],
  direction: ['positiondirection', 'direction'],
  exchange: ['exchange'],
  mic: ['mic'],
  price: ['marketprice', 'price', 'lastprice'],
  currency: ['marketpricecurrency', 'marketvaluecurrency', 'currency'],
  cost: ['bookvaluemarket', 'bookvalue', 'bookcost', 'costbasis', 'cost'],
  costCAD: ['bookvaluecad'],
  value: ['marketvalue', 'value'],
  account: ['accountname', 'account'],
};
const plain = text =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
/** "1,234.50", "$12" or "(40)" as a number; null when the cell holds no number. */
const amount = text => {
  const t = String(text ?? '').replace(/[$,\s]/g, '');
  if (!t) return null;
  const v = Number(/^\(.*\)$/.test(t) ? '-' + t.slice(1, -1) : t);
  return Number.isFinite(v) ? v : null;
};

function kindOf(type, raw) {
  const t = type.toUpperCase();
  if (/OPTION/.test(t)) return 'option';
  if (/CRYPTO/.test(t)) return 'crypto';
  if (/FUND|ETF/.test(t)) return 'fund';
  if (/EQUITY|STOCK|SHARE|RECEIPT|UNIT|TRUST/.test(t)) return 'stock';
  if (!t) return parseOption(raw) ? 'option' : 'stock'; // a hand-made file with no type column
  return 'other';
}

// Exchange names and codes (MIC) of the Canadian markets, and the ending Yahoo gives their tickers.
const CANADIAN = [
  [/^XTSX$|TSX.?V|VENTURE/, '.V'],
  [/^XTSE$|TSX|TORONTO/, '.TO'],
  [/^NEOE$|NEO|CBOE CA|AEQUITAS/, '.NE'],
  [/^XCNQ$|CSE|CNSX|CANADIAN SEC/, '.CN'],
];
/**
 * The ticker as Yahoo writes it: SHOP on the TSX is SHOP.TO, BRK.B is BRK-B, Bitcoin held in
 * Canadian dollars is BTC-CAD. With no exchange given, the symbol is taken as already written
 * Yahoo's way. Returns null when the result could not be a ticker.
 */
export function yahooSymbol(raw, { exchange = '', mic = '', kind = 'stock', currency = null } = {}) {
  let s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!s) return null;
  if (kind === 'crypto') s = /-[A-Z]{3}$/.test(s) ? s : `${s}-${currency || 'CAD'}`;
  else if (mic || exchange) {
    const venue = `${mic} ${exchange}`.toUpperCase();
    const ending = CANADIAN.find(([pattern]) => mic.toUpperCase().match(pattern) || venue.match(pattern))?.[1] ?? '';
    // Share classes and units use a dash at Yahoo (RCI.B -> RCI-B.TO);
    // preferred shares drop the R as well (BCE.PR.A -> BCE-PA.TO).
    s = s.replace(/\.PR\.([A-Z])$/, '-P$1').replaceAll('.', '-') + ending;
  }
  return TICKER.test(s) ? s : null;
}

/** An option contract's details. occ is the code the option chain knows it by. */
export function makeOption(underlying, expiry, strike, put) {
  const root = String(underlying ?? '')
    .trim()
    .toUpperCase();
  const day = new Date(expiry + 'T12:00:00Z');
  const realDate = /^\d{4}-\d{2}-\d{2}$/.test(expiry) && !Number.isNaN(+day) && day.toISOString().startsWith(expiry);
  if (!/^[A-Z]{1,6}\d?$/.test(root) || !realDate || !(strike > 0) || !Number.isFinite(strike)) return null;
  return { underlying: root, expiry, strike, put: !!put, occ: occSymbol(root, expiry, !!put, strike) };
}
/** Find an option's exchange code (GEMI261204P00002000, with or without a space) in a piece of text. */
export function parseOption(text) {
  const m = String(text ?? '')
    .toUpperCase()
    .match(/(?:^|[^A-Z0-9])([A-Z]{1,6}\d?)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})(?![0-9])/);
  return m ? makeOption(m[1], `20${m[2]}-${m[3]}-${m[4]}`, +m[6] / 1000, m[5] === 'P') : null;
}

/**
 * Read a holdings file: Wealthsimple's holdings report, or any CSV with a symbol and a quantity column.
 * Returns { holdings, skipped: [{ text, reason }], asOf: 'YYYY-MM-DD' | null }.
 * Account numbers in the file are not kept. Throws when the file is not a holdings list at all.
 */
export function readHoldings(text) {
  const rows = parseCsv(text);
  const has = (names, options) => options.some(option => names.includes(option));
  const headAt = rows.findIndex(r => has(r.map(plain), COLUMNS.symbol) && has(r.map(plain), COLUMNS.qty));
  if (headAt < 0)
    throw new Error('This file has no "Symbol" and "Quantity" columns, so it does not look like a list of holdings.');
  const names = rows[headAt].map(plain);
  const col = Object.fromEntries(
    Object.entries(COLUMNS).map(([field, options]) => [field, options.map(o => names.indexOf(o)).find(i => i >= 0)]),
  );
  const holdings = [],
    skipped = [];
  let asOf = null;
  for (const r of rows.slice(headAt + 1)) {
    const at = field => (col[field] === undefined ? '' : (r[col[field]] ?? '').trim());
    const filled = r.filter(c => c.trim());
    const stamp = filled.length === 1 && filled[0].match(/as of\s+(\d{4}-\d{2}-\d{2})/i);
    if (stamp) {
      asOf = stamp[1]; // the report's last line: "As of 2026-10-20 16:30 GMT-04:00"
      continue;
    }
    const raw = at('symbol').toUpperCase();
    if (plain(raw) === 'symbol') continue; // the heading again, as in a file of several reports glued together
    // Named by its symbol and description only: the row's other cells include the account number.
    const skip = reason =>
      skipped.push({ text: [raw, at('name')].filter(Boolean).join(' ').slice(0, 90) || 'A row', reason });
    const size = amount(at('qty'));
    if (!raw) skip('It has no symbol.');
    else if (!size) skip('It has no quantity.');
    else {
      const kind = kindOf(at('type'), raw);
      const currency = /^[A-Za-z]{3}$/.test(at('currency')) ? at('currency').toUpperCase() : null;
      const option = kind === 'option' ? parseOption(raw) || parseOption(at('name')) : null;
      const venue = { exchange: at('exchange'), mic: at('mic'), kind, currency };
      holdings.push({
        id: 'h' + (holdings.length + 1),
        symbol: option ? option.underlying : kind === 'option' || kind === 'other' ? null : yahooSymbol(raw, venue),
        raw,
        name: at('name') || raw,
        kind,
        qty: /short/i.test(at('direction')) ? -Math.abs(size) : size,
        currency,
        cost: amount(at('cost')),
        costCAD: amount(at('costCAD')),
        filePrice: amount(at('price')),
        fileValue: amount(at('value')),
        account: at('account') || null,
        option,
        source: 'file',
      });
    }
  }
  return { holdings, skipped, asOf };
}

/** A holding as it is kept in the browser: the known fields only, each of the right type. null when it is not one. */
export function cleanHolding(h) {
  if (!h || typeof h !== 'object' || !isNum(h.qty) || h.qty === 0 || !KINDS.includes(h.kind)) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const number = v => (isNum(v) ? v : null);
  const symbol = text(h.symbol, 20)?.toUpperCase() ?? null;
  const o = h.option && typeof h.option === 'object' ? h.option : null;
  const option = h.kind === 'option' && o ? makeOption(o.underlying, o.expiry, o.strike, o.put) : null;
  const raw = text(h.raw, 40) ?? symbol;
  if (!raw || !text(h.id, 40) || (symbol && !TICKER.test(symbol))) return null;
  return {
    id: text(h.id, 40),
    symbol,
    raw,
    name: text(h.name, 120) ?? raw,
    kind: h.kind,
    qty: h.qty,
    currency: /^[A-Z]{3}$/.test(h.currency) ? h.currency : null,
    cost: number(h.cost),
    costCAD: number(h.costCAD),
    filePrice: number(h.filePrice),
    fileValue: number(h.fileValue),
    account: text(h.account, 60),
    option,
    source: SOURCES.includes(h.source) ? h.source : 'file',
  };
}
// ---------------------------------------------------------------- holdings from a brokerage link

// SnapTrade's names for what a position is, and ours.
const BROKER_KINDS = {
  stock: 'stock',
  adr: 'stock',
  preferred_stock: 'stock',
  etf: 'fund',
  mutualfund: 'fund',
  cef: 'fund',
  crypto: 'crypto',
  option: 'option',
};
/**
 * The option contract described somewhere inside a position's instrument. The exchange code
 * (AAPL  261218C00200000) is looked for in every piece of text, whatever its field is called;
 * failing that, separate strike, expiry, type and underlying fields are put together.
 */
function findOption(instrument) {
  const texts = [],
    fields = {};
  (function walk(node, depth) {
    if (depth > 4 || node == null) return;
    if (typeof node === 'string') texts.push(node);
    else if (typeof node === 'object')
      for (const [key, value] of Object.entries(node)) {
        if (value != null && typeof value !== 'object') fields[key.toLowerCase()] ??= value;
        walk(value, depth + 1);
      }
  })(instrument, 0);
  for (const text of texts) {
    const found = parseOption(text);
    if (found) return found;
  }
  const pick = pattern => Object.entries(fields).find(([key]) => pattern.test(key))?.[1];
  const type = String(pick(/option_?type|put_?call|^right$/) ?? '').toUpperCase();
  const underlying =
    instrument?.underlying_symbol?.raw_symbol || instrument?.underlying_symbol?.symbol || pick(/underlying/);
  if (!/^(P|C|PUT|CALL)$/.test(type) || typeof underlying !== 'string') return null;
  return makeOption(underlying, String(pick(/expir/) ?? '').slice(0, 10), Number(pick(/strike/)), type[0] === 'P');
}

/**
 * Holdings read from a brokerage link: what /api/snaptrade/holdings sends, which is
 * { accounts: [{ name, asOf, positions, cash: [{ currency, amount }] }] } with positions as SnapTrade
 * writes them. Returns what readHoldings returns: { holdings, skipped, asOf }.
 * A position's cost comes per share from the brokerage and is kept here as a total, like a file's.
 */
export function fromBroker(data) {
  const holdings = [],
    skipped = [];
  let asOf = null;
  const add = holding =>
    holdings.push({ id: 'h' + (holdings.length + 1), costCAD: null, source: 'broker', ...holding });
  const number = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const code = v => (/^[A-Za-z]{3}$/.test(v ?? '') ? v.toUpperCase() : null);
  for (const account of data?.accounts || []) {
    const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim() : null;
    if (typeof account.asOf === 'string' && account.asOf.slice(0, 10) > (asOf || '')) asOf = account.asOf.slice(0, 10);
    for (const p of account.positions || []) {
      const ins = p?.instrument || {},
        kind = BROKER_KINDS[ins.kind] || 'other';
      if (ins.kind === 'cash') continue; // cash is read from the account's balances below
      const raw = String(ins.raw_symbol || ins.symbol || '')
        .trim()
        .toUpperCase();
      const units = number(p.units),
        price = number(p.price),
        each = number(p.cost_basis);
      const label = [raw, ins.description].filter(Boolean).join(' ').slice(0, 90) || 'A position';
      if (!raw && kind !== 'option') skipped.push({ text: label, reason: 'It has no symbol.' });
      else if (!units) skipped.push({ text: label, reason: 'It has no quantity.' });
      else {
        const currency = code(p.currency) || code(ins.currency);
        const option = kind === 'option' ? findOption(ins) : null;
        const mult = kind === 'option' ? MULT : 1;
        // The brokerage's own exchange code decides the ticker. Without one, its formatted symbol is used as it is.
        const ticker = ins.exchange
          ? yahooSymbol(raw, { mic: String(ins.exchange), kind, currency })
          : yahooSymbol(ins.symbol || raw, { kind, currency });
        const shown = option ? option.occ : raw || 'OPTION'; // what the row is called when there is no description
        add({
          symbol: option ? option.underlying : kind === 'option' || kind === 'other' ? null : ticker,
          raw: shown,
          name: typeof ins.description === 'string' && ins.description.trim() ? ins.description.trim() : shown,
          kind,
          qty: units,
          currency,
          cost: each == null ? null : each * units * mult,
          filePrice: price,
          fileValue: price == null ? null : price * units * mult,
          account: name,
          option,
        });
      }
    }
    for (const c of account.cash || []) {
      const amount = number(c?.amount),
        currency = code(c?.currency);
      if (amount && currency)
        add({
          symbol: null,
          raw: 'CASH ' + currency,
          name: 'Cash',
          kind: 'cash',
          qty: amount,
          currency,
          cost: null,
          filePrice: 1,
          fileValue: amount,
          account: name,
          option: null,
        });
    }
  }
  return { holdings, skipped, asOf };
}

/**
 * The holdings after a sync: everything the brokerage reported, plus the ones added by hand that
 * it did not report (an option it could not describe, something held elsewhere). Holdings that
 * came from a file are dropped: the brokerage is now the record.
 */
export function afterSync(synced, current) {
  const key = h => (h.option ? h.option.occ : h.symbol || h.raw);
  const reported = new Set(synced.map(key));
  return [...synced, ...current.filter(h => h.source === 'hand' && !reported.has(key(h)))];
}

// ---------------------------------------------------------------- valuing

/** What one unit of a currency is worth in another. Only Canadian and US dollars are handled. */
const fxRate = (from, to, usdcad) =>
  from === to
    ? 1
    : !(usdcad > 0)
      ? null
      : from === 'USD' && to === 'CAD'
        ? usdcad
        : from === 'CAD' && to === 'USD'
          ? 1 / usdcad
          : null;

/**
 * Value every holding in the base currency ('CAD' or 'USD').
 * Returns { rows, base, total, day, dayPct, cost, gain, gainPct }. Each row is one holding with:
 *   price, currency, live (priced by the market, not from the file), value (in its own currency),
 *   valueBase, weight, dayBase (today's change), costBase, gainBase,
 *   exposureBase   what it moves like: its value, or for an option the value of the shares it behaves like
 *   shares, thetaBase, iv   for an option: shares it behaves like, value lost per day, implied volatility
 *   why            the reason there is no value, when there is none
 * Totals count only the rows that could be valued.
 */
export function valuePortfolio(holdings, market = {}, base = 'CAD', now = Date.now() / 1000) {
  const { quotes = {}, options = {}, usdcad = null, usdcadChangePct = null } = market;
  const today = nyDate(now);
  const usdcadBefore = isNum(usdcadChangePct) && usdcadChangePct > -100 ? usdcad / (1 + usdcadChangePct / 100) : usdcad;
  const rows = holdings.map(hd => {
    const isOption = hd.kind === 'option',
      isCash = hd.kind === 'cash',
      mult = isOption ? MULT : 1;
    const quote = (hd.symbol && quotes[hd.symbol]) || null;
    const opt = (isOption && hd.option && options[hd.option.occ]) || null;
    const expired = isOption && !!hd.option && hd.option.expiry < today;
    const livePrice = isCash ? 1 : isOption ? opt?.mark : quote?.price; // a dollar of cash is worth a dollar
    const stated = hd.filePrice ?? (isNum(hd.fileValue) ? hd.fileValue / (hd.qty * mult) : null);
    const price = expired ? null : (livePrice ?? stated);
    const currency = (isOption ? hd.currency || quote?.currency : quote?.currency || hd.currency) || base;
    const fx = fxRate(currency, base, usdcad);
    const value = isNum(price) ? hd.qty * price * mult : null;
    const valueBase = value != null && fx != null ? value * fx : null;
    // Today's change: the security's own move, plus the exchange rate's when it is held in the other currency.
    const pct = quote?.changePct;
    const move = !isNum(livePrice)
      ? null
      : isCash
        ? 0
        : isOption
          ? isNum(opt.chg)
            ? opt.chg * mult * hd.qty
            : null
          : isNum(pct) && pct > -100
            ? value - value / (1 + pct / 100)
            : null;
    const fxBefore = fxRate(currency, base, usdcadBefore);
    const costBase =
      base === 'CAD' && isNum(hd.costCAD) ? hd.costCAD : isNum(hd.cost) && fx != null ? hd.cost * fx : null;
    const shares = opt && isNum(opt.delta) ? opt.delta * mult * hd.qty : null;
    return {
      holding: hd,
      id: hd.id,
      symbol: hd.symbol,
      name: hd.name,
      kind: hd.kind,
      qty: hd.qty,
      price,
      currency,
      live: !expired && isNum(livePrice),
      value,
      valueBase,
      weight: null,
      dayBase: move != null && valueBase != null && fxBefore != null ? valueBase - (value - move) * fxBefore : null,
      costBase,
      gainBase: valueBase != null && costBase != null ? valueBase - costBase : null,
      exposureBase: !isOption
        ? valueBase
        : shares != null && isNum(opt.spot) && fx != null
          ? shares * opt.spot * fx
          : null,
      shares,
      thetaBase: opt && isNum(opt.theta) && fx != null ? opt.theta * mult * hd.qty * fx : null,
      iv: opt?.iv ?? null,
      why: expired
        ? 'It has expired.'
        : value == null
          ? 'No price is available for it.'
          : fx == null
            ? `There is no exchange rate for ${currency}.`
            : null,
    };
  });
  const valued = rows.filter(r => r.valueBase != null);
  const total = sum(valued.map(r => r.valueBase));
  for (const r of valued) r.weight = total ? r.valueBase / total : null;
  const moved = valued.filter(r => r.dayBase != null),
    bought = valued.filter(r => r.gainBase != null);
  const day = moved.length ? sum(moved.map(r => r.dayBase)) : null;
  const before = sum(moved.map(r => r.valueBase - r.dayBase));
  const cost = bought.length ? sum(bought.map(r => r.costBase)) : null;
  const gain = bought.length ? sum(bought.map(r => r.gainBase)) : null;
  return {
    rows,
    base,
    total,
    day,
    dayPct: day != null && before > 0 ? day / before : null,
    cost,
    gain,
    gainPct: gain != null && cost > 0 ? gain / cost : null,
  };
}

// ---------------------------------------------------------------- where the money is

const sorted = (map, total) =>
  [...map]
    .map(([label, value]) => ({ label, value, share: total ? value / total : null }))
    .sort((a, b) => b.value - a.value);
/** Is this row a fund, a single company, a coin, an option or cash? Yahoo's word wins over the file's. */
const natureOf = (row, profile) =>
  row.kind === 'option'
    ? 'option'
    : { ETF: 'fund', MUTUALFUND: 'fund', CRYPTOCURRENCY: 'crypto', EQUITY: 'stock' }[profile?.type] || row.kind;

/**
 * Split the portfolio's value four ways: by sector, asset type, currency and country.
 * Each is a list of { label, value, share }, largest first, adding up to the whole portfolio.
 * A fund is spread over what it holds inside (its sectors, and its stocks, bonds and cash).
 * Yahoo gives no country split for funds, so they appear under one "Inside funds" line there.
 * An option counts at what it is worth today, under "Options". Cash is its own line everywhere.
 */
export function breakdown(rows, profiles = {}) {
  const sector = new Map(),
    asset = new Map(),
    currency = new Map(),
    country = new Map();
  const add = (map, label, value) => value && map.set(label, (map.get(label) || 0) + value);
  let total = 0;
  for (const r of rows) {
    if (r.valueBase == null) continue;
    const v = r.valueBase,
      p = profiles[r.symbol],
      nature = natureOf(r, p);
    total += v;
    add(currency, r.currency, v);
    const apart = { option: 'Options', crypto: 'Crypto', cash: 'Cash' }[nature];
    if (apart) {
      for (const map of [sector, asset, country]) add(map, apart, v);
    } else if (nature === 'fund') {
      const parts = Object.entries(p?.assets || {}).filter(([, share]) => share > 0),
        whole = sum(parts.map(([, share]) => share));
      add(country, 'Inside funds', v);
      if (!whole) {
        add(asset, 'Funds, contents unknown', v);
        add(sector, 'Funds, contents unknown', v);
        continue;
      }
      const sectors = Object.entries(p.sectors || {}),
        named = sum(sectors.map(([, share]) => share));
      for (const [label, share] of parts) {
        const part = (v * share) / whole;
        add(asset, label, part);
        if (label !== 'Stocks') add(sector, label, part);
        else if (!named) add(sector, 'Stocks, sector unknown', part);
        else for (const [name, weight] of sectors) add(sector, name, (part * weight) / named);
      }
    } else {
      add(asset, nature === 'stock' ? 'Stocks' : 'Other', v);
      add(sector, p?.sector || 'Unknown', v);
      add(country, p?.country || 'Unknown', v);
    }
  }
  return {
    sector: sorted(sector, total),
    asset: sorted(asset, total),
    currency: sorted(currency, total),
    country: sorted(country, total),
  };
}

/**
 * The biggest single positions once funds are opened up: what is held directly plus what each
 * fund holds of it (from the fund's ten largest holdings, which is all Yahoo lists).
 * Returns [{ symbol, name, direct, inFunds, value, share }], largest first.
 */
export function lookThrough(rows, profiles = {}, limit = 12) {
  const found = new Map();
  const firstWord = name =>
    String(name ?? '')
      .toLowerCase()
      .replace(/^the\s+/, '')
      .match(/[a-z0-9&]+/)?.[0] || '';
  // One company can trade on both sides of the border (SHOP and SHOP.TO), and a fund's list may use
  // either ticker. Tickers alone can clash (T is AT&T in New York and Telus in Toronto), so two
  // entries are the same company only when the first word of their names agrees as well.
  const entry = (symbol, name) => {
    const key = symbol.replace(/\.(TO|NE|V|CN)$/, '') + '|' + firstWord(name);
    if (!found.has(key)) found.set(key, { symbol, name, direct: 0, inFunds: 0 });
    return found.get(key);
  };
  const valued = rows.filter(r => r.valueBase != null).map(r => ({ r, p: profiles[r.symbol] }));
  for (const { r, p } of valued)
    if (natureOf(r, p) === 'stock' && r.symbol) entry(r.symbol, p?.name || r.name).direct += r.valueBase;
  for (const { r, p } of valued)
    if (natureOf(r, p) === 'fund')
      for (const [symbol, name, weight] of p?.top || [])
        if (weight > 0 && symbol) entry(String(symbol), name || symbol).inFunds += r.valueBase * weight;
  const total = sum(valued.map(({ r }) => r.valueBase));
  return [...found.values()]
    .map(x => ({ ...x, value: x.direct + x.inFunds, share: total ? (x.direct + x.inFunds) / total : null }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// ---------------------------------------------------------------- diversification

/**
 * How much of the money sits in a few holdings. Lots of one ticker count as one holding.
 * effective is the number of equal-sized holdings that would be exactly as concentrated
 * (1 / the sum of squared weights): 10 holdings with one at 70% behave like about 2.
 */
export function concentration(rows) {
  const merged = new Map();
  for (const r of rows) {
    if (!(r.valueBase > 0)) continue;
    const cash = r.kind === 'cash' ? `Cash (${r.currency})` : null; // cash in several accounts is one holding
    const key = cash || (r.kind === 'option' ? r.id : r.symbol || r.id);
    const item = merged.get(key) || { name: cash || (r.kind === 'option' ? r.name : r.symbol || r.name), value: 0 };
    item.value += r.valueBase;
    merged.set(key, item);
  }
  const total = sum([...merged.values()].map(x => x.value));
  if (!total) return null;
  const list = [...merged.values()].map(x => ({ ...x, share: x.value / total })).sort((a, b) => b.value - a.value);
  return {
    count: list.length,
    largest: list[0],
    top5: sum(list.slice(0, 5).map(x => x.share)),
    effective: 1 / sum(list.map(x => x.share ** 2)),
    list,
  };
}

/**
 * Holdings merged by what they move with, for the risk maths: every lot of a ticker together,
 * and each option as the shares of its underlying it behaves like (so a put pulls the other way).
 * Returns [{ symbol, name, exposure, option }] in the base currency; option says an option is part of it.
 */
export function positions(rows) {
  const merged = new Map();
  for (const r of rows) {
    if (!r.symbol || r.exposureBase == null) continue;
    const item = merged.get(r.symbol) || { symbol: r.symbol, name: r.symbol, exposure: 0, option: false };
    item.exposure += r.exposureBase;
    if (r.kind === 'option') item.option = true;
    else item.name = r.name;
    merged.set(r.symbol, item);
  }
  return [...merged.values()].filter(p => p.exposure !== 0);
}

/**
 * How the positions have moved, alone and together, over the price history given.
 *   positions   from positions()
 *   history     { dates, closes: { SYM: [...] } } as /api/closes sends it; it must include the
 *               exchange rate (FX) when positions are in both currencies
 *   opts        { base, total: the portfolio's value, currencies: { SYM: 'USD' | 'CAD' },
 *                 benchmarks: { label: SYM }, minDays: history a position needs to be counted }
 * Everything is measured in the base currency, so a US share held from Canada carries the exchange
 * rate's moves too. Returns null when no position has enough history. Otherwise:
 *   from, to, days       the stretch measured
 *   vol                  how much the whole portfolio swings in a year (one standard deviation)
 *   alone                what that would be if every position moved in step with the others
 *   parts                per position: weight, vol, and share of the portfolio's risk (they add up to 1)
 *   corr                 { symbols, matrix }: how each pair moved together, from -1 to 1
 *   avgCorr              the average of those among the positions held long, weighted by size
 *   path                 { dates, values }: growth of 1 held in today's mix
 *   drawdown             { depth, from, to }: the deepest fall from a high along that path
 *   worstDay             { date, move }
 *   betas                { label: { beta, corr } | null }: movement per 1% move of each benchmark
 *   left, covered        positions without enough history, and the share of exposure that is counted
 */
export function riskModel(positions, history, opts = {}) {
  const { base = 'CAD', total, currencies = {}, benchmarks = BENCHMARKS, minDays = 120 } = opts;
  const dates = history?.dates || [],
    closes = history?.closes || {},
    n = dates.length;
  const rate = closes[FX];
  const inBase = symbol => {
    const series = closes[symbol],
      currency = currencies[symbol] || base;
    if (!series || currency === base) return series || null;
    if (!rate || !BASES.includes(currency)) return null;
    return series.map((p, i) => (p == null || rate[i] == null ? null : currency === 'USD' ? p * rate[i] : p / rate[i]));
  };
  const firstAt = series => series.findIndex(p => p != null);
  const included = [],
    left = [];
  for (const p of positions) {
    const series = inBase(p.symbol);
    if (series && firstAt(series) >= 0 && n - 1 - firstAt(series) >= minDays) included.push({ ...p, series });
    else left.push(p.symbol);
  }
  if (!included.length || !(total > 0)) return null;

  const start = Math.max(...included.map(p => firstAt(p.series)));
  const returns = series => {
    const out = [];
    for (let t = start + 1; t < n; t++)
      out.push(series[t - 1] > 0 && series[t] != null ? series[t] / series[t - 1] - 1 : 0);
    return out;
  };
  const R = included.map(p => returns(p.series)),
    m = n - 1 - start,
    w = included.map(p => p.exposure / total);
  const mean = r => sum(r) / m;
  const covariance = (a, b) => {
    const ma = mean(a),
      mb = mean(b);
    let s = 0;
    for (let t = 0; t < m; t++) s += (a[t] - ma) * (b[t] - mb);
    return s / (m - 1);
  };
  const C = R.map(() => []);
  for (let i = 0; i < R.length; i++) for (let j = i; j < R.length; j++) C[i][j] = C[j][i] = covariance(R[i], R[j]);
  const sd = C.map((row, i) => Math.sqrt(row[i]));
  const pull = C.map(row => sum(row.map((c, j) => c * w[j]))); // each position's covariance with the whole portfolio
  const variance = Math.max(sum(pull.map((x, i) => x * w[i])), 0);
  const yearly = Math.sqrt(TRADING_DAYS);
  const corr = C.map((row, i) => row.map((c, j) => (i === j ? 1 : sd[i] && sd[j] ? c / (sd[i] * sd[j]) : 0)));
  let together = 0,
    pairs = 0;
  for (let i = 0; i < R.length; i++)
    for (let j = i + 1; j < R.length; j++) {
      if (!(w[i] > 0 && w[j] > 0)) continue; // a position held the other way round (a hedge) is no part of this average
      together += w[i] * w[j] * corr[i][j];
      pairs += w[i] * w[j];
    }

  // The portfolio's own daily moves with today's mix, and the path they trace.
  const daily = Array.from({ length: m }, (_, t) => sum(R.map((r, i) => r[t] * w[i])));
  const values = [1];
  let peak = 1,
    peakAt = 0,
    worst = { depth: 0, from: 0, to: 0 };
  daily.forEach((r, t) => {
    const level = values[t] * (1 + r);
    values.push(level);
    if (level > peak) [peak, peakAt] = [level, t + 1];
    if (level / peak - 1 < worst.depth) worst = { depth: level / peak - 1, from: peakAt, to: t + 1 };
  });
  const lowest = daily.indexOf(Math.min(...daily));
  const betas = Object.fromEntries(
    Object.entries(benchmarks).map(([label, symbol]) => {
      const series = inBase(symbol);
      if (!series || firstAt(series) < 0 || firstAt(series) > start) return [label, null];
      const moves = returns(series),
        spread = covariance(moves, moves);
      if (!(spread > 0)) return [label, null];
      const shared = covariance(daily, moves);
      return [label, { beta: shared / spread, corr: variance > 0 ? shared / Math.sqrt(spread * variance) : 0 }];
    }),
  );
  const size = list => sum(list.map(p => Math.abs(p.exposure)));
  return {
    from: dates[start],
    to: dates[n - 1],
    days: m,
    vol: Math.sqrt(variance) * yearly,
    alone: sum(w.map((x, i) => Math.abs(x) * sd[i])) * yearly,
    parts: included
      .map((p, i) => ({
        symbol: p.symbol,
        name: p.name,
        option: !!p.option,
        weight: w[i],
        vol: sd[i] * yearly,
        share: variance > 0 ? (w[i] * pull[i]) / variance : null,
      }))
      .sort((a, b) => b.share - a.share),
    corr: { symbols: included.map(p => p.symbol), matrix: corr },
    avgCorr: pairs ? together / pairs : null,
    path: { dates: dates.slice(start), values },
    drawdown: { depth: worst.depth, from: dates[start + worst.from], to: dates[start + worst.to] },
    worstDay: { date: dates[start + 1 + lowest], move: daily[lowest] },
    betas,
    left,
    covered: size(included) / size(positions),
  };
}

// ---------------------------------------------------------------- a sample to try

/** A made-up portfolio in the layout of Wealthsimple's holdings report, for trying the view and for the tests. */
export const SAMPLE = `Account Name,Account Type,Account Classification,Account Number,Symbol,Exchange,MIC,Name,Security Type,Quantity,Position Direction,Market Price,Market Price Currency,Book Value (CAD),Book Value Currency (CAD),Book Value (Market),Book Value Currency (Market),Market Value,Market Value Currency,Market Unrealized Returns,Market Unrealized Returns Currency
"TFSA","TFSA","Trade","SAMPLE0001CAD","XEQT","TSX","XTSE","iShares Core Equity ETF Portfolio","EXCHANGE_TRADED_FUND","420","LONG","43.49","CAD","14700","CAD","14700","CAD","18265.8","CAD","3565.8","CAD"
"TFSA","TFSA","Trade","SAMPLE0001CAD","VFV","TSX","XTSE","Vanguard S&P 500 Index ETF","EXCHANGE_TRADED_FUND","60.5","LONG","187.77","CAD","9000","CAD","9000","CAD","11360.085","CAD","2360.085","CAD"
"TFSA","TFSA","Trade","SAMPLE0001CAD","ZAG","TSX","XTSE","BMO Aggregate Bond Index ETF","EXCHANGE_TRADED_FUND","300","LONG","13.6","CAD","4200","CAD","4200","CAD","4080","CAD","-120","CAD"
"RRSP","RRSP","Trade","SAMPLE0002CAD","SHOP","TSX","XTSE","Shopify Inc.","EQUITY","25","LONG","150","CAD","2500","CAD","2500","CAD","3750","CAD","1250","CAD"
"RRSP","RRSP","Trade","SAMPLE0002CAD","XEQT","TSX","XTSE","iShares Core Equity ETF Portfolio","EXCHANGE_TRADED_FUND","100","LONG","43.49","CAD","3900","CAD","3900","CAD","4349","CAD","449","CAD"
"Non-registered","Non-registered","Trade","SAMPLE0003USD","AAPL","NASDAQ","XNAS","Apple Inc.","EQUITY","15","LONG","355.58","USD","5600","CAD","4000","USD","5333.7","USD","1333.7","USD"
"Non-registered","Non-registered","Trade","SAMPLE0003USD","NVDA","NASDAQ","XNAS","NVIDIA Corporation","EQUITY","40","LONG","149.36","USD","6300","CAD","4500","USD","5974.4","USD","1474.4","USD"
"Non-registered","Non-registered","Trade","SAMPLE0003USD","SPY271217P00600000","","","SPY 2027-12-17 600.00 Put","OPTION","1","LONG","18.5","USD","2660","CAD","1900","USD","1850","USD","-50","USD"
"Crypto","Crypto","Trade","SAMPLE0004CAD","BTC","","","Bitcoin","CRYPTOCURRENCY","0.02","LONG","87500","CAD","1500","CAD","1500","CAD","1750","CAD","250","CAD"

"As of 2026-11-26 16:30 GMT-05:00"
`;

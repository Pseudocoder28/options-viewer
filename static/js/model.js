// Turns the raw API data into an analysed option chain, and prices multi-leg positions.
// Pure functions: no DOM, no network. Smoke-tested on live data by tests-model.mjs.
import * as Q from './quant.js';

export const YEAR = 365 * 86400;
export const MULT = 100;          // shares per standard contract
const MAX_IV = 10;                // ignore solved vols above 1000%
const usable = c => c && c.iv != null && c.ivQ !== 'wide';

// ---------------------------------------------------------------- chain

/**
 * raw: the /api/chain payload.  quote: the /api/quote payload.
 * Returns { expiries: [...], contracts: [...], spot, rate, ... } with implied vol, Greeks and
 * per-expiry statistics filled in. Expired expiries are dropped.
 */
export function buildChain(raw, quote, now = Date.now() / 1000) {
  const S = quote.price, r = quote.rate ?? 0.04, q0 = quote.dividendYield || 0;
  const f = Object.fromEntries(raw.fields.map((name, i) => [name, i]));
  const expiries = raw.expiries.map(e => ({ ...e, T: (e.close - now) / YEAR, days: (e.close - now) / 86400, calls: [], puts: [] }));
  for (const row of raw.rows) {
    const exp = expiries[row[f.e]];
    if (!exp || !(exp.T > 0)) continue;
    const put = row[f.put] === 1, bid = row[f.bid] || 0, ask = row[f.ask] || 0, two = bid > 0 && ask >= bid;
    const c = { exp, put, strike: row[f.strike], bid, ask, last: row[f.last], chg: row[f.chg], vol: row[f.vol] || 0,
                oi: row[f.oi] || 0, lastTrade: row[f.lastTrade], two, mid: two ? (bid + ask) / 2 : null };
    c.id = `${exp.label}|${put ? 'P' : 'C'}|${c.strike}`;
    c.symbol = occSymbol(exp.root, exp.date, put, c.strike);
    (put ? exp.puts : exp.calls).push(c);
  }
  const live = expiries.filter(e => e.T > 0 && e.calls.length + e.puts.length);
  // A last trade counts as fresh when it happened in the most recent session (sources without
  // trade times cannot be checked, so their last prices are taken as they are).
  const latest = Math.max(0, ...raw.rows.map(row => row[f.lastTrade] || 0));
  const fresh = c => c.last > 0 && (c.lastTrade == null || c.lastTrade >= latest - 8 * 3600);
  live.forEach((e, i) => { e.i = i; analyseExpiry(e, S, r, q0, fresh); });

  // Expiries with no usable quotes borrow a flat volatility from the nearest expiry that has one.
  const fitted = live.filter(e => e.atmIV != null);
  for (const e of live) {
    if (e.atmIV == null && fitted.length) {
      const donor = fitted.reduce((a, b) => (Math.abs(b.T - e.T) < Math.abs(a.T - e.T) ? b : a));
      e.atmIV = donor.atmIV; e.ivAt = () => donor.atmIV; e.smileSrc = 'borrowed';
    }
    finishExpiry(e, S, r);
  }
  const contracts = live.flatMap(e => [...e.calls, ...e.puts]);
  const total = key => Q.sum(contracts.map(c => c[key]));
  const tot = put => key => Q.sum(contracts.filter(c => c.put === put).map(c => c[key]));
  const chain = {
    symbol: raw.symbol, source: raw.source, asOf: raw.asOf, stale: !!raw.stale, adjustedDropped: raw.adjustedDropped || 0,
    spot: S, rate: r, expiries: live, contracts,
    mode: live.some(e => e.mode === 'live') ? 'live' : live.some(e => e.mode === 'last') ? 'last' : 'none',
    totals: { vol: total('vol'), oi: total('oi'), callVol: tot(false)('vol'), putVol: tot(true)('vol'), callOI: tot(false)('oi'), putOI: tot(true)('oi') },
  };
  chain.ivAtDays = days => ivAtDays(chain, days);
  chain.iv30 = chain.ivAtDays(30);
  return chain;
}

export function occSymbol(root, date, put, strike) {
  return `${root}${date.slice(2).replaceAll('-', '')}${put ? 'P' : 'C'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

function analyseExpiry(exp, S, r, q0, fresh) {
  const byStrike = (a, b) => a.strike - b.strike;
  exp.calls.sort(byStrike); exp.puts.sort(byStrike);
  const all = [...exp.calls, ...exp.puts];
  exp.rows = new Map();
  for (const c of all) {
    if (!exp.rows.has(c.strike)) exp.rows.set(c.strike, { strike: c.strike, call: null, put: null });
    exp.rows.get(c.strike)[c.put ? 'put' : 'call'] = c;
  }
  exp.strikes = [...exp.rows.keys()].sort((a, b) => a - b);
  // 'live': real two-sided quotes. 'last': quotes are blank (Yahoo wipes index quotes after the
  // close), so fall back to the session's last trades. Thin but genuinely quoted chains stay 'live'.
  const quotedCount = all.filter(c => c.two).length, freshCount = all.filter(fresh).length;
  exp.mode = quotedCount >= 0.1 * all.length || (quotedCount && freshCount <= quotedCount) ? 'live'
    : freshCount ? 'last' : quotedCount ? 'live' : 'none';
  for (const c of all) {
    c.mark = exp.mode === 'last' ? (fresh(c) ? c.last : c.two ? c.mid : null) : c.two ? c.mid : null;
    c.spread = c.two ? c.ask - c.bid : null;
    c.spreadPct = c.two ? c.spread / c.mid : null;
  }

  // Forward price from put-call parity: F = K + e^(rT) * (call - put) near the money. This captures
  // dividends, stock-borrow costs and, for VIX or index options, the futures price they trade off.
  const carry = S * Math.exp((r - q0) * exp.T);
  const cands = [];
  for (const { strike, call, put } of exp.rows.values()) {
    if (call?.mark == null || put?.mark == null) continue;
    const width = exp.mode === 'live' ? (call.ask - call.bid) + (put.ask - put.bid) : 0;
    cands.push({ strike, diff: call.mark - put.mark, width });
  }
  cands.sort((a, b) => (Math.abs(a.diff) + a.width) - (Math.abs(b.diff) + b.width));
  let F = carry;
  exp.forwardSrc = 'carry';
  if (cands.length && cands[0].width <= 0.12 * S) {
    const guess = Q.median(cands.slice(0, exp.mode === 'live' ? 3 : 5).map(c => c.strike + Math.exp(r * exp.T) * c.diff));
    if (guess > 0 && Math.abs(Math.log(guess / S)) < 0.7) { F = guess; exp.forwardSrc = 'parity'; }
  }
  exp.F = F;
  exp.q = q0;
  // The spot price the options themselves imply. For a stock it sits within pennies of the quoted
  // price; for VIX it is the (discounted) futures price, which can be far from spot VIX.
  exp.S = F * Math.exp(-(r - q0) * exp.T);
  exp.basis = exp.S / S;

  // Implied volatility per contract, from the mid plus the bid and ask to show how well it is pinned down.
  const iv = (price, c) => {
    const v = Q.impliedVol(price, exp.S, c.strike, exp.T, r, exp.q, c.put);
    return v != null && v <= MAX_IV ? v : null;
  };
  for (const c of all) {
    c.iv = c.ivBid = c.ivAsk = c.ivQ = null;
    if (c.two && exp.mode === 'live') {
      c.iv = iv(c.mid, c); c.ivAsk = iv(c.ask, c); c.ivBid = iv(c.bid, c) ?? 0;
      if (c.iv != null && c.ivAsk != null) {
        const range = c.ivAsk - c.ivBid;
        c.ivQ = range <= 0.05 + 0.25 * c.iv ? 'tight' : range <= 1 ? 'ok' : 'wide';
      } else c.iv = null;
    } else if (c.mark != null) {
      c.iv = iv(c.mark, c);
      c.ivQ = c.iv != null ? 'stale' : null;
    }
  }

  // Volatility smile: one node per strike from the out-of-the-money side (puts below the forward,
  // calls above), where the price is mostly time value. A tight in-the-money quote close to the
  // money stands in when the other side has no quote.
  let nodes = [];
  for (const { strike, call, put } of exp.rows.values()) {
    const otm = strike < F ? put : call, itm = strike < F ? call : put;
    const pick = usable(otm) ? otm : usable(itm) && itm.ivQ === 'tight' && Math.abs(Math.log(strike / F)) < 0.25 ? itm : null;
    if (pick) nodes.push({ strike, k: Math.log(strike / F), iv: pick.iv, lo: pick.ivBid, hi: pick.ivAsk, put: pick.put, q: pick.ivQ });
  }
  nodes.sort((a, b) => a.strike - b.strike);
  if (nodes.length >= 5) {
    // ponytail: simple outlier trim (a node far from the median of its neighbours is a bad quote).
    // Replace with a fitted smile (SVI) if you need a no-arbitrage surface.
    nodes = nodes.filter((n, i) => {
      const near = nodes.slice(Math.max(0, i - 2), i + 3).map(x => x.iv);
      const m = Q.median(near);
      return Math.abs(n.iv - m) <= 0.5 * m + 0.05;
    });
  }
  exp.smile = nodes;
  if (nodes.length) {
    const ks = nodes.map(n => n.k), ivs = nodes.map(n => n.iv);
    exp.ivAt = K => Q.interp(ks, ivs, Math.log(K / F));
    exp.atmIV = exp.ivAt(F);
    exp.smileSrc = 'quotes';
  } else { exp.ivAt = null; exp.atmIV = null; exp.smileSrc = null; }
}

function finishExpiry(exp, S, r) {
  const all = [...exp.calls, ...exp.puts], F = exp.F;
  for (const c of all) {
    const otm = c.put ? c.strike < F : c.strike >= F;
    const own = usable(c) ? c.iv : null;
    // Out-of-the-money contracts use their own quote; the rest use the smile so that a call and a put
    // at the same strike share one volatility (as put-call parity says they must).
    c.sigma = otm && own != null ? own : exp.ivAt ? exp.ivAt(c.strike) : own;
    c.sigmaSrc = c.sigma == null ? null : c.sigma === own ? 'quote' : 'model';
    c.intrinsic = Q.intrinsic(exp.S, c.strike, c.put);
    c.itm = c.intrinsic > 0;
    c.extrinsic = c.mark != null ? Math.max(c.mark - c.intrinsic, 0) : null;
    if (c.sigma != null) {
      const g = Q.bsm({ S: exp.S, K: c.strike, T: exp.T, r, q: exp.q, vol: c.sigma, put: c.put });
      Object.assign(c, { theo: g.price, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho, probITM: g.probITM });
    } else Object.assign(c, { theo: null, delta: null, gamma: null, theta: null, vega: null, rho: null, probITM: null });
  }
  const side = (list, key) => Q.sum(list.map(c => c[key]));
  const nearMoney = all.filter(c => c.two && Math.abs(Math.log(c.strike / F)) < 0.2);
  const quoted = all.filter(c => c.two);
  exp.atmStrike = exp.strikes.reduce((a, b) => (Math.abs(b - F) < Math.abs(a - F) ? b : a));
  const atm = exp.rows.get(exp.atmStrike);
  exp.straddle = atm.call?.mark != null && atm.put?.mark != null ? atm.call.mark + atm.put.mark : null;
  exp.em = exp.atmIV != null ? F * exp.atmIV * Math.sqrt(exp.T) : null;       // one standard deviation, in dollars
  exp.stats = {
    callVol: side(exp.calls, 'vol'), putVol: side(exp.puts, 'vol'), callOI: side(exp.calls, 'oi'), putOI: side(exp.puts, 'oi'),
    quoted: quoted.length, total: all.length,
    medSpread: (nearMoney.length ? nearMoney : quoted).length ? Q.median((nearMoney.length ? nearMoney : quoted).map(c => c.spreadPct)) : null,
  };
  exp.maxPain = maxPain(exp).strike;
  exp.kind = expiryKind(exp);
}

/** 'monthly' (third Friday), 'quarterly' (quarter end), 'leap' (over a year out) or 'weekly'. */
export function expiryKind(exp) {
  const [y, m, d] = exp.date.split('-').map(Number), day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (exp.days > 365) return 'leap';
  if (day === 5 && d >= 15 && d <= 21) return 'monthly';
  if (m % 3 === 0 && d >= 28) return 'quarterly';
  return 'weekly';
}

/** Expiries with their own at-the-money vol, minus any that sit far off their neighbours (bad quotes). */
export function termStructure(chain) {
  const own = chain.expiries.filter(e => e.atmIV != null && e.smileSrc === 'quotes' && e.days >= 1);
  return own.filter((e, i) => {
    const m = Q.median(own.slice(Math.max(0, i - 2), i + 3).map(x => x.atmIV));
    return Math.abs(e.atmIV - m) <= 0.6 * m;
  });
}

/** At-the-money implied vol at a constant maturity, interpolating total variance between expiries. */
function ivAtDays(chain, days) {
  const pts = termStructure(chain).map(e => ({ T: e.T, w: e.atmIV ** 2 * e.T }));
  if (!pts.length) return null;
  const T = days / 365;
  if (T <= pts[0].T) return Math.sqrt(pts[0].w / pts[0].T);
  const last = pts[pts.length - 1];
  if (T >= last.T) return Math.sqrt(last.w / last.T);
  return Math.sqrt(Math.max(Q.interp(pts.map(p => p.T), pts.map(p => p.w), T), 0) / T);
}

// ---------------------------------------------------------------- positioning analytics

/** Settlement price at which option holders collectively receive the least. */
export function maxPain(exp) {
  const pain = exp.strikes.map(S => Q.sum(exp.calls.map(c => c.oi * Math.max(S - c.strike, 0))) + Q.sum(exp.puts.map(c => c.oi * Math.max(c.strike - S, 0))));
  let best = 0;
  pain.forEach((p, i) => { if (p < pain[best]) best = i; });
  return { strikes: exp.strikes, pain: pain.map(p => p * MULT), strike: exp.strikes[best] };
}

/** Open interest, volume and gamma exposure per strike, for one expiry or summed over several. S is the spot. */
export function byStrike(expiries, S) {
  const map = new Map();
  for (const e of expiries) for (const c of [...e.calls, ...e.puts]) {
    if (!map.has(c.strike)) map.set(c.strike, { strike: c.strike, callOI: 0, putOI: 0, callVol: 0, putVol: 0, gex: 0 });
    const row = map.get(c.strike);
    row[c.put ? 'putOI' : 'callOI'] += c.oi;
    row[c.put ? 'putVol' : 'callVol'] += c.vol;
    // Dealer gamma exposure in dollars per 1% move, under the usual assumption that dealers are
    // long calls and short puts. It is an estimate: nobody publishes who holds which side.
    if (c.gamma != null) row.gex += (c.put ? -1 : 1) * c.gamma * c.oi * MULT * S * S * 0.01;
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

/** Strike and implied vol where the option has the given delta (0.25 means a 25-delta call or put). */
export function atDelta(exp, target, put, r) {
  if (!exp.ivAt || exp.atmIV == null) return null;
  const width = Math.max(exp.atmIV * Math.sqrt(exp.T), 0.02);
  let prev = null;
  for (let i = 0; i <= 240; i++) {
    const K = exp.F * Math.exp((put ? -1 : 1) * (i / 240) * 4 * width), vol = exp.ivAt(K);
    const d = Math.abs(Q.bsm({ S: exp.S, K, T: exp.T, r, q: exp.q, vol, put }).delta);
    if (d <= target) {
      if (!prev) return { strike: K, iv: vol };
      const w = (prev.d - target) / (prev.d - d || 1);
      return { strike: prev.K + (K - prev.K) * w, iv: prev.vol + (vol - prev.vol) * w };
    }
    prev = { K, vol, d };
  }
  return null;
}

/** 25-delta risk reversal: call vol minus put vol. Negative means downside protection costs more. */
export function riskReversal(exp, r) {
  if (!exp.smile || exp.smile.length < 3) return null;
  const c = atDelta(exp, 0.25, false, r), p = atDelta(exp, 0.25, true, r);
  return c && p ? { call: c, put: p, rr: c.iv - p.iv } : null;
}

export function topContracts(chain, score, n = 12) {
  return chain.contracts.map(c => ({ c, s: score(c) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.c);
}

// ---------------------------------------------------------------- price history

export function historyStats(h) {
  const c = h.c, n = c.length;
  if (n < 2) return null;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(c[i] / c[i - 1] - 1);
  const hi = Math.max(...h.h.filter(x => x != null)), lo = Math.min(...h.l.filter(x => x != null));
  const best = Math.max(...rets), worst = Math.min(...rets);
  return {
    change: c[n - 1] / c[0] - 1, high: hi, low: lo, bars: n,
    upShare: rets.filter(x => x > 0).length / rets.length,
    avgRange: Q.mean(h.h.map((x, i) => (x - h.l[i]) / c[i]).filter(Number.isFinite)),
    avgAbsMove: Q.mean(rets.map(Math.abs)), best, worst,
    bestAt: h.t[rets.indexOf(best) + 1], worstAt: h.t[rets.indexOf(worst) + 1],
  };
}

// ---------------------------------------------------------------- positions and strategies
// A leg is { kind: 'C' | 'P' | 'S', side: +1 buy / -1 sell, qty, price (per share at entry),
//            strike, close (expiry epoch seconds), sigma, q, basis, t0 }.  'S' is stock (qty in shares).
// basis is the options-implied spot divided by the quoted spot when the leg was created (1 for
// stocks, well away from 1 for VIX). It fades to 1 at expiry, when the option settles on the spot.

export function legFromContract(c, side, qty = 1, price = null, now = Date.now() / 1000) {
  const natural = side > 0 ? c.ask || c.mark : c.bid || c.mark;
  return { kind: c.put ? 'P' : 'C', side, qty, strike: c.strike, close: c.exp.close, date: c.exp.date, expLabel: c.exp.label,
           q: c.exp.q, basis: c.exp.basis, t0: now, sigma: c.sigma ?? c.exp.atmIV ?? 0.5,
           price: price ?? c.mark ?? c.theo ?? natural ?? 0, bid: c.bid, ask: c.ask, id: c.id, symbol: c.symbol };
}
export const stockLeg = (side, shares, price) => ({ kind: 'S', side, qty: shares, price });
export const legMult = leg => (leg.kind === 'S' ? 1 : MULT);

/** Model spot for a leg when the quoted spot is S at time t (applies the fading basis). */
function legSpot(leg, S, T) {
  if (!leg.basis || leg.basis === 1) return S;
  const T0 = (leg.close - leg.t0) / YEAR;
  return S * Math.pow(leg.basis, T0 > 0 ? Math.min(T / T0, 1) : 1);
}

/** Value of one unit of a leg (per share) if the stock is at S at time t. volShift is in vol decimals. */
export function legValue(leg, S, t, r, volShift = 0) {
  if (leg.kind === 'S') return S;
  const T = (leg.close - t) / YEAR, put = leg.kind === 'P';
  if (!(T > 0)) return Q.intrinsic(S, leg.strike, put);
  return Q.bsPrice(legSpot(leg, S, T), leg.strike, T, r, leg.q || 0, Math.max(leg.sigma + volShift, 0.01), put);
}
export const positionCost = legs => Q.sum(legs.map(l => l.side * l.qty * legMult(l) * l.price));
export const positionValue = (legs, S, t, r, volShift = 0) => Q.sum(legs.map(l => l.side * l.qty * legMult(l) * legValue(l, S, t, r, volShift)));
export const positionPnl = (legs, S, t, r, volShift = 0) => positionValue(legs, S, t, r, volShift) - positionCost(legs);

/** Net Greeks of the whole position in dollar terms: delta in shares, theta in $ per day, vega in $ per vol point. */
export function positionGreeks(legs, S, t, r) {
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of legs) {
    const n = l.side * l.qty * legMult(l);
    if (l.kind === 'S') { out.delta += n; continue; }
    const T = (l.close - t) / YEAR;
    if (!(T > 0)) continue;
    const g = Q.bsm({ S: legSpot(l, S, T), K: l.strike, T, r, q: l.q || 0, vol: l.sigma, put: l.kind === 'P' });
    for (const k of Object.keys(out)) out[k] += n * g[k];
  }
  return out;
}

/**
 * Full analysis of a position at its first expiry: payoff curves, extremes, break-evens and the
 * chance of profit. ctx = { S, r, now, vol } where vol is the at-the-money vol used for the odds.
 */
export function analysePosition(legs, { S, r, now, vol }) {
  const opts = legs.filter(l => l.kind !== 'S');
  const horizon = opts.length ? Math.min(...opts.map(l => l.close)) : now + 30 * 86400;
  const T = Math.max((horizon - now) / YEAR, 1 / 3650);
  const sig = vol ?? (opts.length ? Q.mean(opts.map(l => l.sigma)) : 0.3);
  const first = opts.length ? opts.reduce((a, b) => (b.close < a.close ? b : a)) : null;
  const F = S * (first?.basis || 1) * Math.exp((r - (first?.q || 0)) * T);
  const strikes = opts.map(l => l.strike);
  const w = Math.min(Math.max(3.5 * sig * Math.sqrt(T), 0.25), 2.5);
  const lo = Math.min(S * Math.exp(-w), ...(strikes.length ? [Math.min(...strikes) * 0.7] : []));
  const hi = Math.max(S * Math.exp(w), ...(strikes.length ? [Math.max(...strikes) * 1.3] : []));
  const xs = new Set([S, ...strikes]);
  for (let i = 0; i <= 300; i++) xs.add(lo + (hi - lo) * i / 300);
  const grid = [...xs].filter(x => x > 0).sort((a, b) => a - b);
  const atExpiry = grid.map(x => positionPnl(legs, x, horizon, r));
  const today = grid.map(x => positionPnl(legs, x, now, r));

  // Extremes: check the grid, a stock price of zero, and the slope as the stock runs away upward.
  const atZero = positionPnl(legs, 1e-9, horizon, r);
  const upSlope = Q.sum(legs.filter(l => l.kind !== 'P').map(l => l.side * l.qty * legMult(l)));
  let maxProfit = Math.max(atZero, ...atExpiry), maxLoss = Math.min(atZero, ...atExpiry);
  if (upSlope > 1e-9) maxProfit = Infinity;
  if (upSlope < -1e-9) maxLoss = -Infinity;

  const breakevens = [];
  const pts = [[1e-9, atZero], ...grid.map((x, i) => [x, atExpiry[i]])];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (y0 === 0 && i > 1) continue;
    if ((y0 < 0 && y1 >= 0) || (y0 > 0 && y1 <= 0)) breakevens.push(x0 + (x1 - x0) * (0 - y0) / (y1 - y0));
  }
  // Chance of profit: add up the lognormal probability of every stretch of prices that makes money.
  const edges = [0, ...breakevens, Infinity];
  let pop = 0;
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1], b = edges[i];
    const probe = b === Infinity ? Math.max(a * 1.5, hi * 2) : (a + b) / 2 || b / 2;
    if (positionPnl(legs, Math.max(probe, 1e-9), horizon, r) > 0)
      pop += (b === Infinity ? 1 : Q.probBelow(b, F, sig, T)) - Q.probBelow(a, F, sig, T);
  }
  return {
    cost: positionCost(legs), horizon, T, F, vol: sig, grid, atExpiry, today, maxProfit, maxLoss, breakevens, pop,
    range: [F * Math.exp(-sig * Math.sqrt(T)), F * Math.exp(sig * Math.sqrt(T))],
    greeks: positionGreeks(legs, S, now, r),
  };
}

/** Contract in this expiry whose delta is closest to the target (use negative targets for puts). */
export function pickByDelta(exp, target) {
  const pool = (target < 0 ? exp.puts : exp.calls).filter(c => c.delta != null);
  if (!pool.length) return null;
  return pool.reduce((a, b) => (Math.abs(b.delta - target) < Math.abs(a.delta - target) ? b : a));
}
const neighbour = (exp, c, steps) => {
  const list = c.put ? exp.puts : exp.calls, i = list.indexOf(c);
  return list[Math.min(Math.max(i + steps, 0), list.length - 1)];
};

/** Ready-made strategies. Each builds legs from real contracts in the given expiry. */
export const TEMPLATES = {
  'Long call': { view: 'Bullish', build: e => [[pickByDelta(e, 0.5), 1]] },
  'Long put': { view: 'Bearish', build: e => [[pickByDelta(e, -0.5), 1]] },
  'Bull call spread': { view: 'Bullish, capped', build: e => [[pickByDelta(e, 0.55), 1], [pickByDelta(e, 0.3), -1]] },
  'Bear put spread': { view: 'Bearish, capped', build: e => [[pickByDelta(e, -0.55), 1], [pickByDelta(e, -0.3), -1]] },
  'Bull put spread (credit)': { view: 'Neutral to bullish', build: e => [[pickByDelta(e, -0.3), -1], [pickByDelta(e, -0.15), 1]] },
  'Bear call spread (credit)': { view: 'Neutral to bearish', build: e => [[pickByDelta(e, 0.3), -1], [pickByDelta(e, 0.15), 1]] },
  'Long straddle': { view: 'Big move either way', build: e => { const r = e.rows.get(e.atmStrike); return [[r.call, 1], [r.put, 1]]; } },
  'Long strangle': { view: 'Big move either way, cheaper', build: e => [[pickByDelta(e, 0.25), 1], [pickByDelta(e, -0.25), 1]] },
  'Iron condor': { view: 'Stays in a range', build: e => { const c = pickByDelta(e, 0.2), p = pickByDelta(e, -0.2); return [[c, -1], [c && neighbour(e, c, 1), 1], [p, -1], [p && neighbour(e, p, -1), 1]]; } },
  'Call butterfly': { view: 'Pins near a price', build: e => { const m = e.rows.get(e.atmStrike).call; return [[m && neighbour(e, m, -1), 1], [m, -2], [m && neighbour(e, m, 1), 1]]; } },
  'Covered call': { view: 'Own shares, earn income', stock: 100, build: e => [[pickByDelta(e, 0.3), -1]] },
  'Protective put': { view: 'Own shares, insure them', stock: 100, build: e => [[pickByDelta(e, -0.3), 1]] },
  'Collar': { view: 'Own shares, cheap insurance', stock: 100, build: e => [[pickByDelta(e, -0.25), 1], [pickByDelta(e, 0.25), -1]] },
  'Cash-secured put': { view: 'Get paid to bid lower', build: e => [[pickByDelta(e, -0.3), -1]] },
};

export function buildTemplate(name, exp, S) {
  const t = TEMPLATES[name];
  const picks = t.build(exp).filter(([c]) => c);
  const legs = picks.map(([c, n]) => legFromContract(c, Math.sign(n), Math.abs(n)));
  if (t.stock) legs.unshift(stockLeg(1, t.stock, S));
  return legs;
}

/** A short name for a set of legs, for headings. */
export function nameOf(legs) {
  const o = legs.filter(l => l.kind !== 'S'), stock = legs.find(l => l.kind === 'S');
  const word = l => `${l.side > 0 ? 'Long' : 'Short'} ${l.kind === 'C' ? 'call' : 'put'}`;
  if (!o.length) return stock ? `${stock.side > 0 ? 'Long' : 'Short'} stock` : 'Empty position';
  if (o.length === 1) {
    if (stock && stock.side > 0) return o[0].kind === 'C' && o[0].side < 0 ? 'Covered call' : o[0].kind === 'P' && o[0].side > 0 ? 'Protective put' : `Stock plus ${word(o[0]).toLowerCase()}`;
    return word(o[0]);
  }
  if (o.length === 2) {
    const [a, b] = o;
    if (a.kind === b.kind && a.side !== b.side && a.close === b.close) {
      const long = a.side > 0 ? a : b, short = a.side > 0 ? b : a;
      const debit = positionCost(o) > 0;
      const bull = long.strike < short.strike;     // true for calls and puts alike
      return `${bull ? 'Bull' : 'Bear'} ${a.kind === 'C' ? 'call' : 'put'} spread (${debit ? 'debit' : 'credit'})`;
    }
    if (a.kind === b.kind && a.side !== b.side && a.strike === b.strike) return 'Calendar spread';
    if (a.kind !== b.kind && a.side === b.side && a.close === b.close)
      return `${a.side > 0 ? 'Long' : 'Short'} ${a.strike === b.strike ? 'straddle' : 'strangle'}`;
    if (stock && a.kind !== b.kind && a.side !== b.side) return 'Collar';
  }
  if (o.length === 4 && o.filter(l => l.kind === 'C').length === 2) return 'Iron condor';
  if (o.length === 3) return 'Butterfly';
  return 'Custom position';
}

// Model checks, run by tests.mjs. Strategy maths and the chain model are checked offline, on fixed
// inputs and on made-up chains whose true values are known. When the local server is reachable the
// chain model is also run on live data.
import assert from 'node:assert/strict';
import * as Q from './static/js/quant.js';

const BASE = process.env.TERMINAL_URL || 'http://127.0.0.1:8765';
const get = async path => {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(90000) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
};

export async function run(M, test, close) {
  const now = 1_800_000_000,
    day = 86400,
    r = 0.04;
  const leg = (kind, side, qty, strike, price, days = 15, sigma = 1.1) => ({
    kind,
    side,
    qty,
    strike,
    price,
    close: now + days * day,
    sigma,
    q: 0,
  });
  const ctx = { S: 1.705, r, now, vol: 1.1 };

  test('long put: cost, extremes, break-even and odds', () => {
    const a = M.analysePosition([leg('P', 1, 12, 2, 0.4)], ctx);
    close(a.cost, 480, 1e-9, 'cost');
    close(a.maxLoss, -480, 1e-6, 'max loss');
    close(a.maxProfit, 1920, 1e-3, 'max profit at zero');
    assert.equal(a.breakevens.length, 1);
    close(a.breakevens[0], 1.6, 1e-6, 'break-even');
    close(a.pop, Q.probBelow(1.6, a.F, 1.1, a.T), 1e-9, 'chance of profit');
    close(M.positionPnl([leg('P', 1, 12, 2, 0.4)], 1.5, now + 15 * day, r), 120, 1e-9, 'P/L at 1.50');
    assert.equal(M.nameOf([leg('P', 1, 12, 2, 0.4)]), 'Long put');
  });

  test('spreads, short options and stock combinations', () => {
    const spread = [leg('P', 1, 1, 2, 0.4), leg('P', -1, 1, 1.5, 0.05)];
    const a = M.analysePosition(spread, ctx);
    close(a.cost, 35, 1e-9, 'debit');
    close(a.maxProfit, 15, 1e-6, 'max profit');
    close(a.maxLoss, -35, 1e-6, 'max loss');
    close(a.breakevens[0], 1.65, 1e-6, 'break-even');
    assert.equal(M.nameOf(spread), 'Bear put spread (debit)');
    const naked = M.analysePosition([leg('C', -1, 1, 2, 0.1)], ctx);
    assert.equal(naked.maxLoss, -Infinity);
    close(naked.maxProfit, 10, 1e-6, 'short call keeps the premium');
    const longCall = M.analysePosition([leg('C', 1, 1, 2, 0.1)], ctx);
    assert.equal(longCall.maxProfit, Infinity);
    close(longCall.maxLoss, -10, 1e-6, 'long call risk');
    const covered = [M.stockLeg(1, 100, 1.705), leg('C', -1, 1, 2, 0.1)];
    const cc = M.analysePosition(covered, ctx);
    close(cc.maxProfit, (2 - 1.705 + 0.1) * 100, 1e-6, 'covered call cap');
    close(cc.maxLoss, -(1.705 - 0.1) * 100, 1e-3, 'covered call floor');
    assert.equal(M.nameOf(covered), 'Covered call');
    const straddle = [leg('C', 1, 1, 2, 0.1), leg('P', 1, 1, 2, 0.4)];
    const s = M.analysePosition(straddle, ctx);
    assert.equal(s.breakevens.length, 2);
    close(s.breakevens[0], 1.5, 1e-6, 'lower');
    close(s.breakevens[1], 2.5, 1e-6, 'upper');
    assert.ok(s.pop > 0 && s.pop < 1);
    assert.equal(M.nameOf(straddle), 'Long straddle');
    const g = M.positionGreeks([leg('P', 1, 12, 2, 0.4)], 1.705, now, r);
    assert.ok(g.delta < -500 && g.delta > -1200, `12 long puts are short several hundred shares: ${g.delta}`);
    assert.ok(g.theta < 0 && g.vega > 0 && g.gamma > 0);
    const before = M.positionPnl([leg('P', 1, 1, 2, 0.4)], 1.705, now, r),
      later = M.positionPnl([leg('P', 1, 1, 2, 0.4)], 1.705, now + 10 * day, r);
    assert.ok(later < before, 'time decay hurts a long option');
  });

  test('expiry kinds and contract symbols', () => {
    assert.equal(M.expiryKind({ date: '2026-12-18', days: 29 }), 'monthly');
    assert.equal(M.expiryKind({ date: '2026-12-04', days: 15 }), 'weekly');
    assert.equal(M.expiryKind({ date: '2026-12-31', days: 42 }), 'quarterly');
    assert.equal(M.expiryKind({ date: '2028-01-21', days: 428 }), 'leap');
    assert.equal(M.occSymbol('GEMI', '2026-12-04', true, 2), 'GEMI261204P00002000');
    assert.equal(M.occSymbol('SPXW', '2026-11-20', false, 7335), 'SPXW261120C07335000');
  });

  // ---- a made-up chain with known answers, so the chain model can be checked without the network
  const iso = t => new Date(t * 1000).toISOString().slice(0, 10);
  /**
   * Build the payloads the server would send for a chain whose true values are known.
   * vol(k) is the true volatility at log-moneyness k = ln(strike / forward). Every contract is quoted
   * at its exact Black-Scholes value plus and minus half the spread, unless `only` says otherwise.
   */
  function made({
    S = 100,
    rate = 0.04,
    yld = 0,
    days = [30],
    strikes,
    vol = () => 0.3,
    spread = 0.02,
    oi = 100,
    state = 'REGULAR',
    only = () => true,
    extra = () => ({}),
  }) {
    const expiries = days.map(d => ({
      date: iso(now + d * day),
      root: 'TEST',
      am: false,
      close: now + d * day,
      label: iso(now + d * day),
    }));
    const rows = [];
    expiries.forEach((e, i) => {
      const T = days[i] / 365,
        F = S * Math.exp((rate - yld) * T);
      for (const K of strikes)
        for (const put of [0, 1]) {
          const fair = Q.bsPrice(S, K, T, rate, yld, vol(Math.log(K / F)), !!put),
            quoted = only(K, put);
          rows.push(
            [
              i,
              K,
              put,
              quoted ? Math.max(fair - spread / 2, 0.01) : 0,
              quoted ? fair + spread / 2 : 0,
              null,
              null,
              10,
              oi,
              null,
            ].map((v, j) => extra(K, put)[j] ?? v),
          );
        }
    });
    return {
      raw: {
        symbol: 'TEST',
        source: 'made up',
        asOf: now,
        adjustedDropped: 0,
        expiries,
        fields: ['e', 'strike', 'put', 'bid', 'ask', 'last', 'chg', 'vol', 'oi', 'lastTrade'],
        rows,
      },
      quote: { symbol: 'TEST', price: S, rate, dividendYield: yld, marketState: state, time: now, type: 'EQUITY' },
    };
  }
  const range = (from, to, step) =>
    Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
  const finite = chain =>
    chain.contracts.every(c =>
      ['theo', 'delta', 'gamma', 'theta', 'vega'].every(k => c[k] === null || Number.isFinite(c[k])),
    );

  test('made-up chain: forward, volatility, skew and max pain are recovered', () => {
    const smile = k => 0.25 - 0.12 * k + 0.35 * k * k;
    const { raw, quote } = made({ yld: 0.015, days: [7, 30, 60, 180, 365], strikes: range(60, 150, 2.5), vol: smile });
    const chain = M.buildChain(raw, quote, now),
      e = chain.expiries[1];
    close(e.F, 100 * Math.exp((0.025 * 30) / 365), 0.002, 'forward from put-call parity');
    for (const x of chain.expiries) {
      close(x.atmIV, 0.25, 0.001, `at-the-money vol, ${x.label}`);
      assert.equal(x.smileSrc, 'quotes');
    }
    close(chain.iv30, 0.25, 0.001, '30-day vol');
    const rr = M.riskReversal(e, chain.rate);
    assert.ok(
      rr.put.strike < e.F && rr.call.strike > e.F && rr.rr < -0.005 && rr.rr > -0.02,
      `puts dearer than calls, as the made-up smile says: ${rr.rr}`,
    );
    close(rr.put.iv, smile(Math.log(rr.put.strike / e.F)), 0.002, '25-delta put vol sits on the true smile');
    const brute = e.strikes.map(
      s =>
        Q.sum(e.calls.map(c => c.oi * Math.max(s - c.strike, 0))) +
        Q.sum(e.puts.map(c => c.oi * Math.max(c.strike - s, 0))),
    );
    assert.equal(e.maxPain, e.strikes[brute.indexOf(Math.min(...brute))], 'max pain equals the brute-force minimum');
    assert.ok(finite(chain), 'no bad numbers');
    const atm = e.rows.get(100).call;
    assert.equal(atm.sigmaSrc, 'smile');
    assert.equal(e.rows.get(110).call.sigmaSrc, 'own'); // in the money reads the curve, out of the money its own quote
  });

  test('a closed market does not inflate near-dated volatility', () => {
    const args = { days: [3, 28], strikes: range(80, 120, 2.5), vol: () => 0.2 };
    const later = now + 2 * day + 4 * 3600; // quotes frozen at the close, read 52 hours on
    const shut = made({ ...args, state: 'CLOSED' }),
      open = made({ ...args, state: 'REGULAR' });
    const frozen = M.buildChain(shut.raw, shut.quote, later).expiries[0],
      ticking = M.buildChain(open.raw, open.quote, later).expiries[0];
    close(frozen.atmIV, 0.2, 0.002, 'volatility as of the close');
    close(frozen.days, 20 / 24, 1e-9, 'days to expiry still count from the clock');
    assert.ok(ticking.atmIV > 0.3, `the same quotes measured against a running clock read ${ticking.atmIV}`);
  });

  test('an old last trade never overrides a live quote', () => {
    // Only the at-the-money call and put are quoted. Nine contracts carry a last trade from when the stock was at 80.
    const stale = (K, put) => (K >= 80 && K <= 100 ? { 5: Q.bsPrice(80, K, 45 / 365, 0.04, 0, 0.4, !!put) } : {});
    const { raw, quote } = made({
      days: [45],
      strikes: range(30, 175, 5),
      vol: () => 0.4,
      spread: 0.1,
      only: K => K === 100,
      extra: stale,
    });
    const e = M.buildChain(raw, quote, now).expiries[0],
      call = e.rows.get(100).call;
    assert.equal(e.mode, 'live');
    close(call.mark, Q.bsPrice(100, 100, 45 / 365, 0.04, 0, 0.4, false), 1e-9, 'the mark is the mid of the live quote');
    close(e.F, 100 * Math.exp((0.04 * 45) / 365), 0.05, 'forward');
    close(e.atmIV, 0.4, 0.005, 'at-the-money vol');
    close(call.delta, 0.542, 0.01, 'delta');
  });

  test('thin, empty and one-sided chains build without bad numbers', () => {
    const none = made({ strikes: [] });
    assert.deepEqual(M.buildChain(none.raw, none.quote, now).expiries, []);
    const unquoted = made({ strikes: range(90, 110, 5), only: () => false });
    const u = M.buildChain(unquoted.raw, unquoted.quote, now);
    assert.equal(u.expiries[0].mode, 'none');
    assert.ok(u.contracts.every(c => c.sigma === null) && u.iv30 === null && !u.ivMeasured);
    const expired = made({ days: [-1, 20], strikes: range(90, 110, 5) });
    assert.equal(M.buildChain(expired.raw, expired.quote, now).expiries.length, 1, 'an expired expiry is dropped');
    // Quotes exist only far below the money: the volatility is a flagged guess, never passed off as a measurement.
    const wing = made({ strikes: range(50, 75, 5), vol: k => 0.35 - 0.6 * k });
    const w = M.buildChain(wing.raw, wing.quote, now);
    assert.equal(w.expiries[0].smileSrc, 'wing');
    assert.equal(w.ivMeasured, false);
    assert.ok(finite(w));
    // With a properly quoted neighbour, the thin expiry takes the neighbour's level at the money instead.
    const mixed = made({
      days: [20, 40],
      strikes: range(50, 150, 5),
      vol: () => 0.3,
      only: (K, put) => K <= 75 || put === 9,
    });
    mixed.raw.rows.forEach((row, i) => {
      if (row[0] === 1 && !row[3]) {
        const fair = Q.bsPrice(100, row[1], 40 / 365, 0.04, 0, 0.3, !!row[2]);
        mixed.raw.rows[i][3] = Math.max(fair - 0.01, 0.01);
        mixed.raw.rows[i][4] = fair + 0.01;
      }
    });
    const m = M.buildChain(mixed.raw, mixed.quote, now);
    assert.equal(m.expiries[0].smileSrc, 'borrowed');
    assert.equal(m.expiries[1].smileSrc, 'quotes');
    close(m.expiries[0].atmIV, m.expiries[1].atmIV, 1e-12, 'borrowed level');
    const flatOI = made({ strikes: [95, 105], oi: 0 });
    assert.equal(
      M.buildChain(flatOI.raw, flatOI.quote, now).expiries[0].maxPain,
      null,
      'no open interest, no max pain',
    );
  });

  test('break-evens and odds when the payoff is flat at zero', () => {
    const at = { S: 100, r, now, vol: 0.3 },
      L = (kind, side, qty, strike, price) => leg(kind, side, qty, strike, price, 30, 0.3);
    const cases = [
      [[L('P', -1, 1, 95, 1.2), L('C', 1, 1, 105, 1.2)], [95, 105], 0.28364], // costs nothing, flat between the strikes
      [[L('C', 1, 1, 105, 0)], [105], 0.28364], // a free call
      // a butterfly entered at zero
      [[L('C', 1, 1, 100, 0.05), L('C', -2, 1, 105, 0.03), L('C', 1, 1, 110, 0.01)], [100, 110], 0.36523],
      [[L('C', 1, 1, 90, 12.5), L('C', -1, 1, 95, 7.5)], [95], 0], // paid the most it can ever be worth
    ];
    for (const [legs, want, odds] of cases) {
      const a = M.analysePosition(legs, at);
      assert.equal(a.breakevens.length, want.length, `break-evens ${a.breakevens} for ${M.nameOf(legs)}`);
      want.forEach((x, i) => close(a.breakevens[i], x, 1e-6, 'break-even'));
      close(a.pop, odds, 2e-4, 'chance of profit');
    }
    const soon = M.analysePosition([leg('C', 1, 1, 100, 0.02, 60 / day, 0.3)], at); // one minute to expiry
    assert.ok(soon.range[1] - soon.range[0] < 0.2, `the typical range has collapsed: ${soon.range}`);
  });

  test('strategy names are only given when sides and sizes really fit', () => {
    const L = (kind, side, qty, strike, days = 30) => leg(kind, side, qty, strike, 1, days, 0.3);
    const condor = [L('P', -1, 1, 95), L('P', 1, 1, 90), L('C', -1, 1, 105), L('C', 1, 1, 110)];
    assert.equal(M.nameOf(condor), 'Iron condor');
    const a = M.analysePosition(
      [
        leg('P', -1, 1, 95, 1.5, 30, 0.3),
        leg('P', 1, 1, 90, 0.75, 30, 0.3),
        leg('C', -1, 1, 105, 1.4, 30, 0.3),
        leg('C', 1, 1, 110, 0.65, 30, 0.3),
      ],
      { S: 100, r, now, vol: 0.3 },
    );
    close(a.cost, -150, 1e-9, 'credit');
    close(a.maxProfit, 150, 1e-6, 'max profit');
    close(a.maxLoss, -350, 1e-6, 'max loss');
    close(a.breakevens[0], 93.5, 1e-6, 'lower');
    close(a.breakevens[1], 106.5, 1e-6, 'upper');
    close(a.pop, 0.55075, 2e-4, 'odds');
    assert.equal(M.nameOf([L('C', 1, 1, 95), L('C', -1, 2, 100), L('C', 1, 1, 105)]), 'Long call butterfly');
    assert.equal(
      M.nameOf([L('C', 1, 1, 95), L('C', 1, 1, 100), L('C', 1, 1, 105)]),
      'Custom position',
      'three bought calls are not a butterfly',
    );
    assert.equal(
      M.nameOf([L('C', 1, 1, 100), L('P', 1, 1, 100), L('C', 1, 1, 110), L('P', 1, 1, 90)]),
      'Custom position',
      'four bought options are not an iron condor',
    );
    assert.equal(
      M.nameOf([L('C', 1, 1, 100), L('C', -1, 2, 105)]),
      'Custom position',
      'one bought against two sold is not a plain spread',
    );
    assert.equal(
      M.nameOf([M.stockLeg(1, 100, 100), L('C', 1, 1, 105), L('P', -1, 1, 95)]),
      'Custom position',
      'a bought call and sold put on shares is not a collar',
    );
    assert.equal(M.nameOf([M.stockLeg(1, 100, 100), L('P', 1, 1, 95), L('C', -1, 1, 105)]), 'Collar');
    assert.equal(M.nameOf([L('C', -1, 1, 100, 30), L('C', 1, 1, 100, 60)]), 'Calendar spread');
  });

  test('legs from a link: round trip, junk and hostile text', () => {
    const { raw, quote } = made({ days: [30, 60], strikes: range(90, 110, 2.5) });
    const chain = M.buildChain(raw, quote, now),
      [near, far] = chain.expiries;
    const legs = [
      M.stockLeg(1, 100, 712.34),
      M.legFromContract(near.rows.get(100).call, 1, 3, 2.955),
      M.legFromContract(near.rows.get(95).put, -1, 12, 0.4),
      M.legFromContract(far.rows.get(102.5).call, -1, 1, 3.23),
    ];
    const back = M.decodeLegs(M.encodeLegs(legs), chain);
    assert.equal(back.length, 4);
    back.forEach((l, i) => {
      for (const k of ['kind', 'side', 'qty', 'strike', 'close', 'price'])
        assert.equal(l[k], legs[i][k], `leg ${i} ${k}`);
      assert.ok(M.validLeg(l));
    });
    for (const junk of [
      'garbage',
      '1S@5.',
      '1S@1e3',
      '+1S@1',
      ' 1S@1',
      '1x' + near.rows.get(100).call.symbol,
      '0S@1',
      '9'.repeat(400) + 'S@1',
      '1S@' + '9'.repeat(400),
    ])
      assert.deepEqual(M.decodeLegs(junk, chain), [], `"${junk.slice(0, 20)}" is dropped`);
    const t0 = performance.now();
    assert.deepEqual(M.decodeLegs('1S@' + '1'.repeat(80000) + 'x', chain), []);
    assert.ok(performance.now() - t0 < 200, 'a huge number does not stall the page');
    assert.equal(
      M.decodeLegs(Array(5000).fill('1S@1').join(','), chain).length,
      20,
      'at most 20 legs come out of a link',
    );
    for (const bad of [
      null,
      {},
      { kind: 'C' },
      { kind: 'S', side: 1, qty: 0, price: 1 },
      { kind: 'C', side: 1, qty: 1, price: 1, strike: 5 },
      { kind: 'S', side: 2, qty: 1, price: 1 },
    ])
      assert.equal(M.validLeg(bad), false);
  });

  test('templates, skew and term structure at their edges', () => {
    const two = made({ strikes: [95, 105] }),
      e2 = M.buildChain(two.raw, two.quote, now).expiries[0];
    assert.deepEqual(M.buildTemplate('Call butterfly', e2, 100), [], 'two strikes cannot make a butterfly');
    assert.deepEqual(M.buildTemplate('Iron condor', e2, 100), []);
    assert.equal(M.buildTemplate('Bull call spread', e2, 100).length, 2);
    // At 110% volatility two years out even the forward strike has less than 25 delta on the put side:
    // no reading rather than a wrong one.
    const wild = made({ S: 1.705, days: [730], strikes: range(0.5, 10, 0.5), vol: k => 1.1 - 0.1 * k, spread: 0.002 });
    assert.equal(M.riskReversal(M.buildChain(wild.raw, wild.quote, now).expiries[0], 0.04), null);
    // A front-month spike (an event just ahead) survives the outlier filter.
    const levels = [1.5, 0.62, 0.6, 0.58, 0.56, 0.55],
      spiky = made({ days: [3, 10, 17, 24, 45, 80], strikes: range(70, 130, 2.5), vol: () => 0.3 });
    spiky.raw.rows.forEach(row => {
      const T = [3, 10, 17, 24, 45, 80][row[0]] / 365,
        fair = Q.bsPrice(100, row[1], T, 0.04, 0, levels[row[0]], !!row[2]);
      row[3] = Math.max(fair - 0.01, 0.01);
      row[4] = fair + 0.01;
    });
    const ts = M.termStructure(M.buildChain(spiky.raw, spiky.quote, now));
    assert.equal(ts.length, 6);
    close(ts[0].atmIV, 1.5, 0.02, 'the 3-day reading is kept');
    assert.equal(
      M.expiryKind({ date: '2026-12-28', days: 30 }),
      'weekly',
      'a Monday near the quarter end is not the quarterly',
    );
    assert.equal(
      M.expiryKind({ date: '2026-12-16', days: 20, am: true, root: 'VIX' }),
      'monthly',
      'the VIX monthly falls on a Wednesday',
    );
  });

  let live = true;
  try {
    await fetch(BASE + '/api/quote?symbol=SPY', { signal: AbortSignal.timeout(20000) });
  } catch {
    live = false;
  }
  if (!live) {
    console.log('--  server not running: skipped live chain checks');
    return;
  }

  for (const symbol of ['GEMI', 'SPY', '^SPX', '^VIX']) {
    const [quote, raw] = await Promise.all([
      get(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
      get(`/api/chain?symbol=${encodeURIComponent(symbol)}`),
    ]);
    const t0 = performance.now();
    const chain = M.buildChain(raw, quote);
    const ms = Math.round(performance.now() - t0);
    test(`${symbol}: chain builds and every number is sane (${chain.contracts.length} contracts, ${chain.expiries.length} expiries, ${ms} ms, ${raw.source}, ${chain.mode})`, () => {
      assert.ok(chain.expiries.length > 0, 'has expiries');
      for (let i = 1; i < chain.expiries.length; i++)
        assert.ok(chain.expiries[i].close >= chain.expiries[i - 1].close, 'sorted by expiry');
      let priced = 0;
      for (const e of chain.expiries) {
        assert.ok(e.T > 0 && e.F > 0 && Number.isFinite(e.q), `forward for ${e.label}`);
        assert.ok(Math.abs(Math.log(e.F / quote.price)) < 0.7, `forward ${e.F} near spot`);
        assert.ok((e.maxPain == null || e.strikes.includes(e.maxPain)) && e.strikes.includes(e.atmStrike));
        if (e.atmIV != null) assert.ok(e.atmIV > 0.01 && e.atmIV < 10, `atm iv ${e.atmIV} for ${e.label}`);
        for (const c of [...e.calls, ...e.puts]) {
          if (c.sigma == null) continue;
          priced++;
          for (const k of ['theo', 'delta', 'gamma', 'theta', 'vega', 'rho', 'probITM'])
            assert.ok(Number.isFinite(c[k]), `${k} finite for ${c.id}`);
          assert.ok(
            c.put ? c.delta <= 1e-12 && c.delta >= -1.0001 : c.delta >= -1e-12 && c.delta <= 1.0001,
            `delta sign ${c.id} ${c.delta}`,
          );
          assert.ok(c.gamma >= 0 && c.vega >= 0 && c.theo >= 0 && c.probITM >= 0 && c.probITM <= 1, `signs ${c.id}`);
        }
      }
      assert.ok(priced > chain.contracts.length * 0.5, `only ${priced} of ${chain.contracts.length} contracts priced`);
      const strip = chain.expiries
        .map(
          e =>
            `${e.label.slice(5)}:${e.atmIV == null ? '-' : (e.atmIV * 100).toFixed(0)}${{ borrowed: 'b', wing: 'w' }[e.smileSrc] || ''}${e.forwardSrc === 'parity' ? '' : '*'}`,
        )
        .slice(0, 14)
        .join(' ');
      console.log(
        `      spot ${quote.price}  iv30 ${chain.iv30 == null ? 'n/a' : (chain.iv30 * 100).toFixed(1) + '%'}  atm iv by expiry (b = borrowed, w = guessed from far strikes, * = no parity forward): ${strip}`,
      );
    });
    if (symbol === 'GEMI')
      test('GEMI: the complete listing is present', () => {
        const dec = chain.expiries.find(e => e.date === '2026-12-04');
        if (!dec) return console.log('      (Dec 4 expiry has passed, skipped)');
        const put = dec.rows.get(1.5)?.put;
        assert.ok(put, 'the $1.50 put that Yahoo omits is listed');
        console.log(
          `      Dec 4: F ${dec.F.toFixed(3)} (${dec.forwardSrc}) atm iv ${(dec.atmIV * 100).toFixed(0)}% | $2 put: mark ${dec.rows.get(2).put.mark} delta ${dec.rows.get(2).put.delta?.toFixed(2)} theta ${dec.rows.get(2).put.theta?.toFixed(4)} | em ±${dec.em?.toFixed(2)} | max pain ${dec.maxPain}`,
        );
      });
    if (symbol === 'SPY')
      test('SPY: calls and puts agree on volatility, and templates build', () => {
        const e = chain.expiries.find(x => x.days > 20) || chain.expiries[0];
        const diffs = [];
        for (const { call, put } of e.rows.values())
          if (call?.ivQ === 'tight' && put?.ivQ === 'tight' && Math.abs(Math.log(call.strike / e.F)) < 0.05)
            diffs.push(Math.abs(call.iv - put.iv));
        assert.ok(diffs.length > 3, 'enough tight pairs near the money');
        assert.ok(
          Q.median(diffs) < 0.02,
          `median call/put vol gap ${Q.median(diffs)} should be small once the forward is implied`,
        );
        assert.ok(e.atmIV > 0.05 && e.atmIV < 0.8, `SPY vol ${e.atmIV}`);
        for (const name of Object.keys(M.TEMPLATES)) {
          const legs = M.buildTemplate(name, e, quote.price);
          assert.ok(legs.length >= 1, name);
          const a = M.analysePosition(legs, { S: quote.price, r: chain.rate, now: Date.now() / 1000, vol: e.atmIV });
          assert.ok(Number.isFinite(a.cost) && a.pop >= 0 && a.pop <= 1.000001, `${name}: cost ${a.cost} pop ${a.pop}`);
        }
        const condor = M.buildTemplate('Iron condor', e, quote.price).map((l, i) => ({
          ...l,
          qty: i + 1,
          price: +(l.price + 0.01 * i).toFixed(4),
        }));
        const withShares = [M.stockLeg(1, 100, 712.34), ...condor];
        const back = M.decodeLegs(M.encodeLegs(withShares), chain);
        assert.equal(back.length, withShares.length, 'every leg survives the trip through the address bar');
        back.forEach((l, i) => {
          for (const k of ['kind', 'side', 'qty', 'strike', 'close', 'price'])
            assert.equal(l[k], withShares[i][k], `leg ${i} ${k}`);
        });
        assert.deepEqual(
          M.decodeLegs('3xNOPE999999C00001000@1,garbage,-2S@5', chain).map(l => [l.kind, l.side, l.qty, l.price]),
          [['S', -1, 2, 5]],
          'unknown contracts and junk are dropped',
        );
        assert.equal(
          M.riskReversal(e, chain.rate),
          M.riskReversal(e, chain.rate),
          'the skew reading is computed once per expiry',
        );
        const rr = M.riskReversal(e, chain.rate);
        assert.ok(rr && rr.put.strike < e.F && rr.call.strike > e.F, '25-delta strikes straddle the forward');
        console.log(
          `      ${e.label}: atm ${(e.atmIV * 100).toFixed(1)}%  25d put ${(rr.put.iv * 100).toFixed(1)}%  25d call ${(rr.call.iv * 100).toFixed(1)}%  median call/put gap ${(Q.median(diffs) * 100).toFixed(2)} pts`,
        );
      });
  }
}

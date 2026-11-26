// Model checks, run by tests.mjs. Strategy maths is checked on fixed inputs; the chain model is
// smoke-tested on live data when the local server is reachable.
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
  const now = 1_800_000_000, day = 86400, r = 0.04;
  const leg = (kind, side, qty, strike, price, days = 15, sigma = 1.1) => ({ kind, side, qty, strike, price, close: now + days * day, sigma, q: 0 });
  const ctx = { S: 1.705, r, now, vol: 1.1 };

  test('long put: cost, extremes, break-even and odds', () => {
    const a = M.analysePosition([leg('P', 1, 12, 2, 0.40)], ctx);
    close(a.cost, 480, 1e-9, 'cost');
    close(a.maxLoss, -480, 1e-6, 'max loss');
    close(a.maxProfit, 1920, 1e-3, 'max profit at zero');
    assert.equal(a.breakevens.length, 1); close(a.breakevens[0], 1.60, 1e-6, 'break-even');
    close(a.pop, Q.probBelow(1.60, a.F, 1.1, a.T), 1e-9, 'chance of profit');
    close(M.positionPnl([leg('P', 1, 12, 2, 0.40)], 1.5, now + 15 * day, r), 120, 1e-9, 'P/L at 1.50');
    assert.equal(M.nameOf([leg('P', 1, 12, 2, 0.40)]), 'Long put');
  });

  test('spreads, short options and stock combinations', () => {
    const spread = [leg('P', 1, 1, 2, 0.40), leg('P', -1, 1, 1.5, 0.05)];
    const a = M.analysePosition(spread, ctx);
    close(a.cost, 35, 1e-9, 'debit'); close(a.maxProfit, 15, 1e-6, 'max profit'); close(a.maxLoss, -35, 1e-6, 'max loss');
    close(a.breakevens[0], 1.65, 1e-6, 'break-even');
    assert.equal(M.nameOf(spread), 'Bear put spread (debit)');
    const naked = M.analysePosition([leg('C', -1, 1, 2, 0.10)], ctx);
    assert.equal(naked.maxLoss, -Infinity); close(naked.maxProfit, 10, 1e-6, 'short call keeps the premium');
    const longCall = M.analysePosition([leg('C', 1, 1, 2, 0.10)], ctx);
    assert.equal(longCall.maxProfit, Infinity); close(longCall.maxLoss, -10, 1e-6, 'long call risk');
    const covered = [M.stockLeg(1, 100, 1.705), leg('C', -1, 1, 2, 0.10)];
    const cc = M.analysePosition(covered, ctx);
    close(cc.maxProfit, (2 - 1.705 + 0.10) * 100, 1e-6, 'covered call cap'); close(cc.maxLoss, -(1.705 - 0.10) * 100, 1e-3, 'covered call floor');
    assert.equal(M.nameOf(covered), 'Covered call');
    const straddle = [leg('C', 1, 1, 2, 0.10), leg('P', 1, 1, 2, 0.40)];
    const s = M.analysePosition(straddle, ctx);
    assert.equal(s.breakevens.length, 2); close(s.breakevens[0], 1.5, 1e-6, 'lower'); close(s.breakevens[1], 2.5, 1e-6, 'upper');
    assert.ok(s.pop > 0 && s.pop < 1); assert.equal(M.nameOf(straddle), 'Long straddle');
    const g = M.positionGreeks([leg('P', 1, 12, 2, 0.40)], 1.705, now, r);
    assert.ok(g.delta < -500 && g.delta > -1200, `12 long puts are short several hundred shares: ${g.delta}`);
    assert.ok(g.theta < 0 && g.vega > 0 && g.gamma > 0);
    const before = M.positionPnl([leg('P', 1, 1, 2, 0.40)], 1.705, now, r), later = M.positionPnl([leg('P', 1, 1, 2, 0.40)], 1.705, now + 10 * day, r);
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

  let live = true;
  try { await fetch(BASE + '/api/quote?symbol=SPY', { signal: AbortSignal.timeout(20000) }); } catch { live = false; }
  if (!live) { console.log('--  server not running: skipped live chain checks'); return; }

  for (const symbol of ['GEMI', 'SPY', '^SPX', '^VIX']) {
    const [quote, raw] = await Promise.all([get(`/api/quote?symbol=${encodeURIComponent(symbol)}`), get(`/api/chain?symbol=${encodeURIComponent(symbol)}`)]);
    const t0 = performance.now();
    const chain = M.buildChain(raw, quote);
    const ms = Math.round(performance.now() - t0);
    test(`${symbol}: chain builds and every number is sane (${chain.contracts.length} contracts, ${chain.expiries.length} expiries, ${ms} ms, ${raw.source}, ${chain.mode})`, () => {
      assert.ok(chain.expiries.length > 0, 'has expiries');
      for (let i = 1; i < chain.expiries.length; i++) assert.ok(chain.expiries[i].close >= chain.expiries[i - 1].close, 'sorted by expiry');
      let priced = 0;
      for (const e of chain.expiries) {
        assert.ok(e.T > 0 && e.F > 0 && Number.isFinite(e.q), `forward for ${e.label}`);
        assert.ok(Math.abs(Math.log(e.F / quote.price)) < 0.7, `forward ${e.F} near spot`);
        assert.ok(e.strikes.includes(e.maxPain) && e.strikes.includes(e.atmStrike));
        if (e.atmIV != null) assert.ok(e.atmIV > 0.01 && e.atmIV < 10, `atm iv ${e.atmIV} for ${e.label}`);
        for (const c of [...e.calls, ...e.puts]) {
          if (c.sigma == null) continue;
          priced++;
          for (const k of ['theo', 'delta', 'gamma', 'theta', 'vega', 'rho', 'probITM']) assert.ok(Number.isFinite(c[k]), `${k} finite for ${c.id}`);
          assert.ok(c.put ? c.delta <= 1e-12 && c.delta >= -1.0001 : c.delta >= -1e-12 && c.delta <= 1.0001, `delta sign ${c.id} ${c.delta}`);
          assert.ok(c.gamma >= 0 && c.vega >= 0 && c.theo >= 0 && c.probITM >= 0 && c.probITM <= 1, `signs ${c.id}`);
        }
      }
      assert.ok(priced > chain.contracts.length * 0.5, `only ${priced} of ${chain.contracts.length} contracts priced`);
      const strip = chain.expiries.map(e => `${e.label.slice(5)}:${e.atmIV == null ? '-' : (e.atmIV * 100).toFixed(0)}${e.smileSrc === 'borrowed' ? 'b' : ''}${e.forwardSrc === 'parity' ? '' : '*'}`).slice(0, 14).join(' ');
      console.log(`      spot ${quote.price}  iv30 ${chain.iv30 == null ? 'n/a' : (chain.iv30 * 100).toFixed(1) + '%'}  atm iv by expiry (b = borrowed, * = no parity forward): ${strip}`);
    });
    if (symbol === 'GEMI') test('GEMI: the complete listing is present', () => {
      const dec = chain.expiries.find(e => e.date === '2026-12-04');
      if (!dec) return console.log('      (Dec 4 expiry has passed, skipped)');
      const put = dec.rows.get(1.5)?.put;
      assert.ok(put, 'the $1.50 put that Yahoo omits is listed');
      console.log(`      Dec 4: F ${dec.F.toFixed(3)} (${dec.forwardSrc}) atm iv ${(dec.atmIV * 100).toFixed(0)}% | $2 put: mark ${dec.rows.get(2).put.mark} delta ${dec.rows.get(2).put.delta?.toFixed(2)} theta ${dec.rows.get(2).put.theta?.toFixed(4)} | em ±${dec.em?.toFixed(2)} | max pain ${dec.maxPain}`);
    });
    if (symbol === 'SPY') test('SPY: calls and puts agree on volatility, and templates build', () => {
      const e = chain.expiries.find(x => x.days > 20) || chain.expiries[0];
      const diffs = [];
      for (const { call, put } of e.rows.values())
        if (call?.ivQ === 'tight' && put?.ivQ === 'tight' && Math.abs(Math.log(call.strike / e.F)) < 0.05) diffs.push(Math.abs(call.iv - put.iv));
      assert.ok(diffs.length > 3, 'enough tight pairs near the money');
      assert.ok(Q.median(diffs) < 0.02, `median call/put vol gap ${Q.median(diffs)} should be small once the forward is implied`);
      assert.ok(e.atmIV > 0.05 && e.atmIV < 0.8, `SPY vol ${e.atmIV}`);
      for (const name of Object.keys(M.TEMPLATES)) {
        const legs = M.buildTemplate(name, e, quote.price);
        assert.ok(legs.length >= 1, name);
        const a = M.analysePosition(legs, { S: quote.price, r: chain.rate, now: Date.now() / 1000, vol: e.atmIV });
        assert.ok(Number.isFinite(a.cost) && a.pop >= 0 && a.pop <= 1.000001, `${name}: cost ${a.cost} pop ${a.pop}`);
      }
      const rr = M.riskReversal(e, chain.rate);
      assert.ok(rr && rr.put.strike < e.F && rr.call.strike > e.F, '25-delta strikes straddle the forward');
      console.log(`      ${e.label}: atm ${(e.atmIV * 100).toFixed(1)}%  25d put ${(rr.put.iv * 100).toFixed(1)}%  25d call ${(rr.call.iv * 100).toFixed(1)}%  median call/put gap ${(Q.median(diffs) * 100).toFixed(2)} pts`);
    });
  }
}

// Checks for the options maths and the chain model. Run:  node tests.mjs
// Everything here runs offline. With the server running (uv run server.py) tests-model.mjs also
// builds live chains and checks that every number in them is sane.
import assert from 'node:assert/strict';
import * as Q from './static/js/quant.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b} (tol ${tol})`);
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('ok  ' + name);
};

test('normal cdf matches reference values and symmetry', () => {
  close(Q.cdf(0), 0.5, 1e-15, 'cdf(0)');
  close(Q.cdf(1), 0.8413447460685429, 1e-13, 'cdf(1)');
  close(Q.cdf(-1.96), 0.024997895148220435, 1e-13, 'cdf(-1.96)');
  close(Q.cdf(3), 0.9986501019683699, 1e-13, 'cdf(3)');
  close(Q.cdf(-8), 6.220960574271785e-16, 1e-20, 'cdf(-8)');
  for (const x of [0.1, 0.7, 2.3, 5, 9]) close(Q.cdf(x) + Q.cdf(-x), 1, 1e-14, 'symmetry');
  let area = 0; // Simpson's rule from -8 to 1.3
  const n = 20000,
    a = -8,
    b = 1.3,
    h = (b - a) / n;
  for (let i = 0; i <= n; i++) area += Q.pdf(a + i * h) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  close((area * h) / 3, Q.cdf(1.3), 1e-10, 'cdf equals the integral of pdf');
});

test('Black-Scholes textbook value and put-call parity', () => {
  const o = { S: 100, K: 100, T: 1, r: 0.05, q: 0, vol: 0.2 };
  close(Q.bsm(o).price, 10.450583572185565, 1e-9, 'call');
  close(Q.bsm({ ...o, put: true }).price, 5.573526022256971, 1e-9, 'put');
  for (const [S, K, T, r, q, vol] of [
    [1.7, 2, 15 / 365, 0.04, 0.3, 1.1],
    [350, 300, 0.5, 0.045, 0.004, 0.28],
    [7000, 7200, 2, 0.04, 0.013, 0.17],
  ]) {
    const c = Q.bsPrice(S, K, T, r, q, vol, false),
      p = Q.bsPrice(S, K, T, r, q, vol, true);
    close(c - p, S * Math.exp(-q * T) - K * Math.exp(-r * T), 1e-9 * S, 'parity');
    close(Q.bsm({ S, K, T, r, q, vol }).price, c, 1e-12 * S, 'bsm price equals bsPrice');
  }
});

test('analytic Greeks match finite differences', () => {
  const cases = [
    { S: 100, K: 105, T: 0.5, r: 0.04, q: 0.01, vol: 0.3 },
    { S: 1.705, K: 2, T: 15 / 365, r: 0.0415, q: 0.2, vol: 1.1 },
    { S: 350, K: 320, T: 60 / 365, r: 0.045, q: 0.005, vol: 0.25 },
    { S: 50, K: 50, T: 5 / 365, r: 0.03, q: 0, vol: 0.6 },
  ];
  for (const base of cases)
    for (const put of [false, true]) {
      const o = { ...base, put },
        g = Q.bsm(o),
        P = x => Q.bsm({ ...o, ...x });
      const hS = o.S * 1e-4,
        hv = 1e-5,
        hr = 1e-6,
        hT = 1e-6;
      close(g.delta, (P({ S: o.S + hS }).price - P({ S: o.S - hS }).price) / (2 * hS), 1e-6, 'delta');
      close(g.gamma, (P({ S: o.S + hS }).delta - P({ S: o.S - hS }).delta) / (2 * hS), 1e-5 / o.S, 'gamma');
      close(g.vega, (P({ vol: o.vol + hv }).price - P({ vol: o.vol - hv }).price) / (2 * hv) / 100, 1e-6 * o.S, 'vega');
      close(g.theta, -(P({ T: o.T + hT }).price - P({ T: o.T - hT }).price) / (2 * hT) / 365, 1e-6 * o.S, 'theta');
      close(g.rho, (P({ r: o.r + hr }).price - P({ r: o.r - hr }).price) / (2 * hr) / 100, 1e-6 * o.S, 'rho');
      close(g.vanna, (P({ vol: o.vol + hv }).delta - P({ vol: o.vol - hv }).delta) / (2 * hv) / 100, 1e-6, 'vanna');
      close(g.charm, -(P({ T: o.T + hT }).delta - P({ T: o.T - hT }).delta) / (2 * hT) / 365, 1e-6, 'charm');
      close(g.vomma, (P({ vol: o.vol + hv }).vega - P({ vol: o.vol - hv }).vega) / (2 * hv) / 100, 1e-6 * o.S, 'vomma');
      const n = Q.numericGreeks(x => Q.bsm(x).price, o);
      close(n.delta, g.delta, 2e-3, 'numeric delta');
      // numeric theta is the real one-day decay, which runs ahead of the instantaneous rate near expiry
      close(n.theta, g.theta, Math.abs(g.theta) * 0.15 + 1e-6, 'numeric theta');
      close(n.vega, g.vega, Math.abs(g.vega) * 0.01 + 1e-9, 'numeric vega');
      close(n.rho, g.rho, Math.abs(g.rho) * 0.01 + 1e-9, 'numeric rho');
    }
});

test('implied volatility round-trips and rejects impossible prices', () => {
  for (const S of [1.7, 48, 350])
    for (const m of [0.6, 0.9, 1, 1.15, 1.6])
      for (const T of [2 / 365, 30 / 365, 1.5])
        for (const vol of [0.08, 0.35, 1.1, 3])
          for (const put of [false, true]) {
            const K = S * m,
              price = Q.bsPrice(S, K, T, 0.04, 0.01, vol, put);
            const floor = Q.bsPrice(S, K, T, 0.04, 0.01, 1e-4, put);
            if (price - floor < 1e-7 * S) continue; // no time value left to invert
            const iv = Q.impliedVol(price, S, K, T, 0.04, 0.01, put);
            assert.ok(iv !== null, `no iv for S=${S} K=${K} T=${T} vol=${vol}`);
            close(Q.bsPrice(S, K, T, 0.04, 0.01, iv, put), price, 1e-6 * S, 'reprices');
          }
  assert.equal(Q.impliedVol(0.2, 1.7, 2, 30 / 365, 0.04, 0, true), null, 'below intrinsic value');
  assert.equal(Q.impliedVol(0, 100, 100, 1, 0.04, 0, false), null, 'zero price');
  assert.equal(Q.impliedVol(150, 100, 100, 1, 0.04, 0, false), null, 'call worth more than the stock');
});

test('binomial tree agrees with Black-Scholes and prices early exercise', () => {
  const o = { S: 100, K: 100, T: 0.75, r: 0.05, q: 0.02, vol: 0.3 };
  for (const put of [false, true])
    close(Q.binomial({ ...o, put }, 800, false), Q.bsPrice(o.S, o.K, o.T, o.r, o.q, o.vol, put), 0.01, 'european tree');
  const itmPut = { S: 80, K: 100, T: 1, r: 0.06, q: 0, vol: 0.25, put: true };
  const euro = Q.bsPrice(80, 100, 1, 0.06, 0, 0.25, true),
    amer = Q.binomial(itmPut, 400, true);
  assert.ok(amer > euro + 0.3 && amer >= 20, `american put ${amer} should exceed european ${euro} and intrinsic 20`);
  close(
    Q.binomial({ S: 100, K: 100, T: 1, r: 0.05, q: 0, vol: 0.2 }, 800, true),
    10.450583572185565,
    0.01,
    'american call without dividends equals european',
  );
  // American values from the literature (and an independent Leisen-Reimer tree), at 800 steps.
  for (const [o, want] of [
    [{ S: 100, K: 100, T: 1, r: 0.05, vol: 0.2, put: true }, 6.0902],
    [{ S: 36, K: 40, T: 1, r: 0.06, vol: 0.2, put: true }, 4.4864],
    [{ S: 40, K: 40, T: 2, r: 0.06, vol: 0.4, put: true }, 6.9233],
    [{ S: 100, K: 100, T: 0.5, r: 0.04, q: 0.08, vol: 0.3 }, 7.4848],
  ])
    close(Q.binomial(o, 800, true), want, 0.005, `american reference ${want}`);
  const noDiv = { S: 100, K: 110, T: 1, r: 0.045, q: 0, vol: 0.6 };
  assert.equal(
    Q.binomial(noDiv, 400, true) - Q.binomial(noDiv, 400, false),
    0,
    'no early-exercise premium on a call without dividends',
  );
  // Greeks read off the tree by bumping are smooth (a plain tree gives zeros and spikes for gamma).
  const tree = x => Q.binomial(x, 300, true),
    base = { S: 100, K: 100, T: 90 / 365, r: 0.045, q: 0, vol: 0.3 };
  for (const S of [97, 99, 100, 101, 104])
    close(
      Q.numericGreeks(tree, { ...base, S }).gamma,
      Q.bsm({ ...base, S }).gamma,
      0.05 * Q.bsm({ ...base, S }).gamma,
      `tree gamma at ${S}`,
    );
  close(
    Q.solveVol(v => Q.binomial({ S: 80, K: 100, T: 1, r: 0.06, q: 0, vol: v, put: true }, 300, true), 21.5),
    0.3209,
    0.002,
    'volatility solved on the tree',
  );
});

test('degenerate inputs give sensible answers, never NaN', () => {
  assert.ok(
    Q.binomial({ S: 80, K: 100, T: 1, r: 0.05, vol: 0.002, put: true }, 300, true) >= 20,
    'an american put is worth at least what exercising pays',
  );
  assert.equal(Q.impliedVol(5, 100, 100, 1, NaN, 0, false), null, 'no volatility from a rate that is not a number');
  // With no volatility the forward (105.1) is above the strike: certain to pay.
  const sure = Q.bsm({ S: 100, K: 101, T: 1, r: 0.05, vol: 0 });
  assert.equal(sure.delta, 1);
  assert.equal(sure.probITM, 1);
  close(sure.price, 100 - 101 * Math.exp(-0.05), 1e-12, 'zero-volatility value');
  for (const k of ['price', 'delta', 'gamma', 'theta', 'vega', 'rho'])
    assert.ok(Number.isFinite(Q.bsm({ S: 0, K: 100, T: 1, r: 0.05, vol: 0.2 })[k]), `${k} at a zero stock price`);
  assert.equal(
    Q.numericGreeks(x => Q.bsm(x).price, { S: 100, K: 100, T: 0, r: 0.04, vol: 0.3 }).theta,
    0,
    'no decay left at expiry',
  );
  close(Q.cdf(-10), 7.619853024160593e-24, 1e-30, 'far tail');
  close(Q.bsPrice(42, 40, 0.5, 0.1, 0, 0.2, false), 4.7594, 1e-4, 'Hull, call');
  close(Q.bsPrice(42, 40, 0.5, 0.1, 0, 0.2, true), 0.8086, 1e-4, 'Hull, put');
});

test('probabilities, statistics and interpolation helpers', () => {
  const S = 100,
    K = 110,
    T = 0.5,
    r = 0.04,
    q = 0.01,
    vol = 0.3,
    F = S * Math.exp((r - q) * T);
  close(Q.probBelow(K, F, vol, T), 1 - Q.bsm({ S, K, T, r, q, vol }).probITM, 1e-12, 'probBelow equals 1 - N(d2)');
  close(Q.probBelow(F, F, 0.4, 1), Q.cdf(0.2), 1e-12, 'median is below the forward');
  assert.equal(Q.median([3, 1, 2]), 2);
  assert.equal(Q.median([4, 1, 2, 3]), 2.5);
  close(Q.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-12, 'sample stdev');
  assert.equal(Q.interp([1, 2, 4], [10, 20, 40], 3), 30);
  assert.equal(Q.interp([1, 2], [10, 20], 0), 10);
  assert.equal(Q.interp([1, 2], [10, 20], 9), 20);
  assert.deepEqual(Q.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const closes = [100];
  let seed = 7; // deterministic pseudo-random daily moves of exactly +/-2%
  for (let i = 0; i < 300; i++) {
    seed = (seed * 16807) % 2147483647;
    closes.push(closes[i] * Math.exp(seed % 2 ? 0.02 : -0.02));
  }
  close(Q.realizedVol(closes, 250), 0.02 * Math.sqrt(252), 0.01, 'realized vol of +/-2% days');
  assert.equal(Q.realizedVol([1, 2, 3], 20), null);
  const roll = Q.rollingVol(closes, 20);
  assert.equal(roll[19], null);
  close(roll[300], Q.realizedVol(closes, 20), 1e-12, 'rolling equals point value');
});

// ---- the chain model and strategy maths (tests-model.mjs); its live checks need the server running
const model = await import('./static/js/model.js');
await (await import('./tests-model.mjs')).run(model, test, close);

// ---- the portfolio maths (tests-portfolio.mjs); its live checks need the server running too
await (await import('./tests-portfolio.mjs')).run(test, close);
console.log(`\n${passed} checks passed`);

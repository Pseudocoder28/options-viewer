// Option pricing math. Pure functions, no DOM, no network. Checked by tests.mjs.
//
// Units used everywhere in this app:
//   T      years (calendar days / 365)        vol    decimal (0.25 = 25%)
//   r, q   decimal per year                   theta  dollars per share per calendar day
//   vega   dollars per share per 1 vol point  rho    dollars per share per 1 point of rate

const SQRT2PI = Math.sqrt(2 * Math.PI);

export const pdf = x => Math.exp(-x * x / 2) / SQRT2PI;

/**
 * Standard normal CDF: Hart's algorithm as given by West, "Better approximations to cumulative
 * normal functions" (2005). The absolute error is about 1e-16; far out in the tail the relative
 * error is about 1e-8, which no option price here can notice.
 */
export function cdf(x) {
  const a = Math.abs(x);
  let c;
  if (a > 37) c = 0;
  else {
    const e = Math.exp(-a * a / 2);
    if (a < 7.07106781186547) {              // 5 * sqrt(2): below it a ratio of polynomials, above it a continued fraction
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165; n = n * a + 33.912866078383; n = n * a + 112.079291497871;
      n = n * a + 221.213596169931; n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207; d = d * a + 86.7807322029461; d = d * a + 296.564248779674;
      d = d * a + 637.333633378831; d = d * a + 793.826512519948; d = d * a + 440.413735824752;
      c = e * n / d;
    } else {
      let b = a + 0.65;
      b = a + 4 / b; b = a + 3 / b; b = a + 2 / b; b = a + 1 / b;
      c = e / b / SQRT2PI;
    }
  }
  return x > 0 ? 1 - c : c;
}

export const intrinsic = (S, K, put) => Math.max(put ? K - S : S - K, 0);

/** Black-Scholes-Merton price only (the fast path used by the implied-vol solver). */
export function bsPrice(S, K, T, r, q, vol, put) {
  if (!(T > 0) || !(vol > 0)) return Math.max((put ? -1 : 1) * (S * Math.exp(-q * Math.max(T, 0)) - K * Math.exp(-r * Math.max(T, 0))), 0);
  const sq = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + vol * vol / 2) * T) / sq, d2 = d1 - sq;
  return put
    ? K * Math.exp(-r * T) * cdf(-d2) - S * Math.exp(-q * T) * cdf(-d1)
    : S * Math.exp(-q * T) * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
}

/**
 * Black-Scholes-Merton price and Greeks for a European option on an asset with a continuous yield q.
 * Pass q = r - ln(F/S)/T to price off a forward F (this is how the app handles dividends, borrow
 * costs and index or VIX futures: the forward is read from put-call parity).
 */
export function bsm({ S, K, T, r = 0, q = 0, vol, put = false }) {
  const sign = put ? -1 : 1;
  if (!(T > 0) || !(vol > 0) || !(S > 0)) {
    // No time, no volatility or a worthless stock: the outcome is already decided. The option is
    // either certain to pay (it moves one for one with the stock) or certain not to.
    const t = Math.max(T, 0), itm = sign * (S * Math.exp(-q * t) - K * Math.exp(-r * t)) > 0;
    return { price: bsPrice(S, K, T, r, q, vol, put), delta: itm ? sign * Math.exp(-q * t) : 0, gamma: 0, theta: 0, vega: 0, rho: 0,
             vanna: 0, charm: 0, vomma: 0, d1: NaN, d2: NaN, probITM: itm ? 1 : 0 };
  }
  const rt = Math.sqrt(T), sq = vol * rt, dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  const d1 = (Math.log(S / K) + (r - q + vol * vol / 2) * T) / sq, d2 = d1 - sq;
  const n1 = cdf(sign * d1), n2 = cdf(sign * d2), p1 = pdf(d1);
  // The formulas are the standard ones (for example Haug, "The Complete Guide to Option Pricing
  // Formulas", chapter 2), rescaled to the units listed at the top of this file. Theta and charm
  // are written as the change when a day PASSES, so they are minus the derivative with respect to T.
  const vega = S * dq * p1 * rt;                                              // per 1.00 of vol
  const thetaYear = -S * dq * p1 * vol / (2 * rt) - sign * r * K * dr * n2 + sign * q * S * dq * n1;
  const charmYear = sign * q * dq * n1 - dq * p1 * (2 * (r - q) * T - d2 * sq) / (2 * T * sq);
  return {
    price: sign * (S * dq * n1 - K * dr * n2),
    delta: sign * dq * n1,
    gamma: dq * p1 / (S * sq),
    theta: thetaYear / 365,
    vega: vega / 100,
    rho: sign * K * T * dr * n2 / 100,
    vanna: -dq * p1 * d2 / vol / 100,        // change in delta per 1 vol point
    charm: charmYear / 365,                  // change in delta per calendar day
    vomma: vega * d1 * d2 / vol / 10000,     // change in vega (per point) per 1 vol point
    d1, d2,
    probITM: n2,                             // risk-neutral chance of finishing in the money
  };
}

/**
 * The volatility at which priceAt(vol) equals target, found by halving an interval (bisection).
 * priceAt must rise with volatility, as every option price does. Returns null when no volatility
 * between 0.01% and 6400% gives the target.
 */
export function solveVol(priceAt, target) {
  if (!(target > 0)) return null;
  let lo = 1e-4, hi = 4;
  if (!(priceAt(lo) < target)) return null;          // at or below the zero-volatility value (or the inputs are not numbers)
  while (priceAt(hi) < target) { hi *= 2; if (hi > 64) return null; }
  for (let i = 0; i < 100 && hi - lo > 1e-8; i++) {
    const mid = (lo + hi) / 2;
    if (priceAt(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Black-Scholes volatility that reprices the option, or null when no volatility can (price outside its bounds). */
export function impliedVol(price, S, K, T, r, q, put) {
  if (!(price > 0) || !(T > 0) || !(S > 0) || !(K > 0)) return null;
  return solveVol(vol => bsPrice(S, K, T, r, q, vol, put), price);
}

/**
 * Cox-Ross-Rubinstein binomial tree. american=true allows early exercise, which matters for
 * in-the-money puts and for calls just before a dividend. Converges to bsPrice as steps grow.
 *
 * The last step is priced with the exact formula instead of the bare payoff (the Broadie-Detemple
 * refinement). A plain tree is a chain of straight segments in S, so its second difference, gamma,
 * comes out as zeros and spikes; with the smooth last step the value curves as it should.
 */
export function binomial({ S, K, T, r = 0, q = 0, vol, put = false }, steps = 200, american = true) {
  if (!(T > 0) || !(vol > 0)) return intrinsic(S, K, put);
  const dt = T / steps, u = Math.exp(vol * Math.sqrt(dt)), d = 1 / u, disc = Math.exp(-r * dt);
  const p = (Math.exp((r - q) * dt) - d) / (u - d);
  // The up-probability must lie between 0 and 1; when it does not (tiny volatility against a large
  // rate) the tree cannot be built, so fall back to the formula, never below what exercising now pays.
  if (!(p > 0 && p < 1)) return Math.max(bsPrice(S, K, T, r, q, vol, put), american ? intrinsic(S, K, put) : 0);
  const sign = put ? -1 : 1, u2 = u * u, v = new Float64Array(steps);
  let s = S * Math.pow(d, steps - 1);                           // lowest price one step before expiry
  for (let i = 0; i < steps; i++, s *= u2) {
    const hold = bsPrice(s, K, dt, r, q, vol, put);
    v[i] = american ? Math.max(hold, sign * (s - K)) : hold;
  }
  for (let n = steps - 2; n >= 0; n--) {                        // walk back to today, one step at a time
    s = S * Math.pow(d, n);
    for (let i = 0; i <= n; i++, s *= u2) {
      const hold = disc * (p * v[i + 1] + (1 - p) * v[i]);
      v[i] = american ? Math.max(hold, sign * (s - K)) : hold;
    }
  }
  return v[0];
}

/**
 * Greeks by bumping any pricing function fn(o) that takes the same object as bsm(). Same units as bsm().
 * Each input is nudged a little either way and the price difference is scaled to the unit:
 * the stock by 0.5%, time by one day, volatility by half a point each way (so the difference is
 * already "per point"), the rate by a twentieth of a point each way (hence the * 10).
 */
export function numericGreeks(fn, o) {
  const h = o.S * 0.005, base = fn(o), up = fn({ ...o, S: o.S + h }), dn = fn({ ...o, S: o.S - h });
  const day = Math.min(1 / 365, o.T / 2);
  return {
    price: base,
    delta: (up - dn) / (2 * h),
    gamma: (up - 2 * base + dn) / (h * h),
    theta: day > 0 ? (fn({ ...o, T: o.T - day }) - base) / (day * 365) : 0,
    vega: (fn({ ...o, vol: o.vol + 0.005 }) - fn({ ...o, vol: o.vol - 0.005 })),
    rho: (fn({ ...o, r: (o.r || 0) + 0.0005 }) - fn({ ...o, r: (o.r || 0) - 0.0005 })) * 10,
  };
}

/** Risk-neutral chance that the price ends below x at time T, given forward F and volatility. */
export function probBelow(x, F, vol, T) {
  if (!(x > 0)) return 0;
  if (!(T > 0) || !(vol > 0)) return x > F ? 1 : 0;
  const sq = vol * Math.sqrt(T);
  return cdf((Math.log(x / F) + sq * sq / 2) / sq);
}

// ---------------------------------------------------------------- small numeric helpers

export const sum = a => a.reduce((s, x) => s + x, 0);
export const mean = a => (a.length ? sum(a) / a.length : NaN);

export function stdev(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear interpolation through sorted xs, flat beyond both ends. */
export function interp(xs, ys, x) {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
}

/** Annualised volatility of the last n daily log returns (close to close, 252 trading days). */
export function realizedVol(closes, n) {
  const c = closes.filter(x => x > 0);
  if (c.length < n + 1) return null;
  const rets = [];
  for (let i = c.length - n; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  return stdev(rets) * Math.sqrt(252);
}

/** Rolling version of realizedVol: one value per bar, null until n returns exist. */
export function rollingVol(closes, n) {
  const out = new Array(closes.length).fill(null), rets = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(closes[i] > 0 && closes[i - 1] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
    if (rets.length >= n) out[i] = stdev(rets.slice(-n)) * Math.sqrt(252);
  }
  return out;
}

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= n) s -= values[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

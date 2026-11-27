// Interactive widgets for the lessons. Each returns a DOM node and draws itself once it is on the page.
//
// Two sets of numbers appear in every widget, in different units:
//   ex   the example option, as the model wants it: vol 0.30, r 0.04, q 0.01 (decimals)
//   s    what the sliders hold, as a person reads it: vol 30, r 4 (percent). q stays a decimal.
// bs(s) converts from the second to the first.
import * as Q from './quant.js';
import * as F from './fmt.js';
import { h, mount, plot, chart, seg, slider, C, vline } from './ui.js';

const box = (title, hint, ...kids) =>
  h('div', { class: 'widget' }, h('header', null, title, h('span', null, hint)), h('div', { class: 'in' }, kids));
const tiles = () => h('div', { class: 'stats' });
const tile = (k, v, sub) =>
  h(
    'div',
    { class: 'stat' },
    h('span', { class: 'k' }, k),
    h('span', { class: 'v' }, v),
    sub ? h('span', { class: 'sub' }, sub) : null,
  );
/** Run fn once the widget is on the page: a chart needs to know its size before it can draw. */
const later = fn => requestAnimationFrame(fn);
const grid = (lo, hi, n = 160) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
const dot = (x, y, name = 'now') => ({
  type: 'scatter',
  mode: 'markers',
  name,
  x: [x],
  y: [y],
  marker: { color: C.amber, size: 11, line: { color: '#000', width: 2 } },
  hoverinfo: 'skip',
  showlegend: false,
});
/**
 * Price and Greeks for slider state s (see the units note above); `over` replaces inputs in model units.
 * The lessons are about US stock options, which can be exercised on any day and so are never worth
 * less than exercising now would pay. The formula assumes exercise at expiry only, which for a deep
 * in-the-money put comes out a little below that floor, so the floor is put back here.
 */
function bs(s, over = {}) {
  const o = {
    S: s.S,
    K: s.K,
    T: Math.max(s.days, 0.01) / 365,
    r: s.r / 100,
    q: s.q,
    vol: s.vol / 100,
    put: s.put,
    ...over,
  };
  const g = Q.bsm(o),
    floor = Q.intrinsic(o.S, o.K, o.put);
  return g.price >= floor
    ? { ...g, theta: Math.min(g.theta, 0) }
    : { ...g, price: floor, delta: o.put ? -1 : 1, gamma: 0, theta: 0, vega: 0 };
}
const word = put => (put ? 'put' : 'call');
/** A small, round stock move for "if the stock rises…" sentences: $1 for most stocks, less for cheap ones. */
export const smallMove = S => (S >= 20 ? 1 : S >= 2 ? 0.1 : 0.05);
/** Call / Put buttons that keep themselves up to date; onPick runs after state.put has changed. */
function callPut(state, onPick) {
  const holder = h('span');
  const paint = () =>
    mount(
      holder,
      seg(
        [
          [false, 'Call'],
          [true, 'Put'],
        ],
        state.put,
        put => {
          state.put = put;
          paint();
          onPick();
        },
      ),
    );
  paint();
  return holder;
}

/** The option every lesson talks about: the loaded ticker's at-the-money contract about a month out. */
export function exampleFrom(ctx) {
  const { app } = ctx,
    chain = app.chain,
    q = app.quote,
    sym = q ? q.symbol.replace('^', '') : 'XYZ';
  if (chain) {
    const sel = ctx.contract(),
      cands = chain.expiries.filter(e => e.atmIV != null && e.days >= 7);
    // Prefer an expiry about a month out whose nearest strike really is near the money (thin chains
    // sometimes list only strikes far from the price, which make poor teaching examples).
    const score = e => Math.abs(e.days - 30) / 30 + 5 * Math.abs(Math.log(e.atmStrike / e.F));
    const e =
      sel?.exp.atmIV != null
        ? sel.exp
        : cands.length
          ? cands.reduce((a, b) => (score(b) < score(a) ? b : a))
          : chain.expiries.find(x => x.atmIV != null);
    // S is the price the options are priced off (e.S), which for most stocks is the quoted price to within pennies.
    if (e)
      return {
        sym,
        S: +e.S.toPrecision(5),
        spot: chain.spot,
        K: sel ? sel.strike : e.atmStrike,
        days: Math.max(Math.round(e.days), 2),
        vol: sel?.sigma ?? e.atmIV,
        r: chain.rate,
        q: e.q,
        date: e.date,
        label: e.label,
        root: e.root,
        put: sel ? sel.put : false,
        real: true,
      };
  }
  const S = q?.price ?? 100;
  return {
    sym,
    S,
    spot: S,
    K: +S.toPrecision(2),
    days: 30,
    vol: 0.3,
    r: 0.04,
    q: 0,
    date: null,
    put: false,
    real: false,
  };
}
const startState = (ex, over = {}) => ({
  S: ex.S,
  K: ex.K,
  days: ex.days,
  vol: +(ex.vol * 100).toFixed(1),
  r: +(ex.r * 100).toFixed(2),
  q: ex.q,
  put: ex.put,
  ...over,
});
const priceRange = ex => {
  const w = Math.min(Math.max(3 * ex.vol * Math.sqrt(ex.days / 365), 0.25), 1.2);
  return [Math.min(ex.S, ex.K) * Math.exp(-w), Math.max(ex.S, ex.K) * Math.exp(w)];
};

// ---------------------------------------------------------------- generic lab

const SLIDERS = {
  S: (ex, s) => {
    const [lo, hi] = priceRange(ex);
    return { label: 'Stock price', min: lo, max: hi, step: (hi - lo) / 300, value: s.S, format: F.usd };
  },
  days: (ex, s) => ({
    label: 'Days left',
    min: 0,
    max: Math.max(ex.days * 2, 60),
    step: 1,
    value: s.days,
    format: v => `${v} days`,
  }),
  vol: (ex, s) => ({
    label: 'Implied volatility',
    min: 5,
    max: Math.max(Math.round(ex.vol * 200), 120),
    step: 1,
    value: s.vol,
    format: v => `${F.num(v, 0)}%`,
  }),
  r: (ex, s) => ({ label: 'Interest rate', min: 0, max: 10, step: 0.01, value: s.r, format: v => `${F.num(v, 2)}%` }),
};

/**
 * A panel of sliders, live value-and-Greek tiles, one chart and one sentence.
 * sliders: names from SLIDERS, or [name, { changes }] to adjust one (a longer range, say).
 * view(state, greeks, ex) -> { traces, layout, say: [text or nodes] }
 */
function lab(ex, { title, hint, sliders, view, toggle = true, height = '' }) {
  const s = startState(ex),
    el = chart(height),
    out = tiles(),
    say = h('p', { class: 'say' });
  const draw = () => {
    if (!el.isConnected) return;
    const g = bs(s),
      v = view(s, g, ex),
      lastDay = s.days < 1;
    // Theta is a rate, and on the last day that rate runs away.
    // What a holder feels is the real change over the next day.
    mount(
      out,
      tile('Value', F.usd(g.price), `${F.money(g.price * 100)} a contract`),
      tile('Delta', F.greek(g.delta, 2), `${F.int(g.delta * 100)} shares`),
      tile('Gamma', F.greek(g.gamma, 3)),
      tile(
        'Theta',
        lastDay ? '—' : F.greek(g.theta, 3),
        lastDay ? 'expires today' : `${F.pnl(nextDay(s) * 100)} over the next day`,
      ),
      tile('Vega', F.greek(g.vega, 3), `${F.pnl(g.vega * 100)} a point`),
    );
    plot(el, v.traces, v.layout);
    mount(say, v.say);
  };
  const node = box(
    title,
    hint,
    toggle
      ? h(
          'div',
          { class: 'row', style: { marginBottom: '6px' } },
          callPut(s, draw),
          h('span', { class: 'muted' }, `${ex.sym} ${F.strike(ex.K)} strike`),
        )
      : null,
    sliders.map(item => {
      const [key, changes] = Array.isArray(item) ? item : [item, {}];
      return slider({
        ...SLIDERS[key](ex, s),
        ...changes,
        onInput: v => {
          s[key] = v;
          draw();
        },
      });
    }),
    out,
    el,
    say,
  );
  later(draw);
  return node;
}

/** The change in value per share over the next day, with everything else held still (negative: the option loses). */
const nextDay = s => bs(s, { T: Math.max(s.days - 1, 0.01) / 365 }).price - bs(s).price;
const strikeMark = s => vline(s.K, `strike ${F.strike(s.K)}`, C.muted);
const axes = (xTitle, yTitle, extra = {}) => ({
  margin: { t: 26 },
  showlegend: true,
  xaxis: { title: { text: xTitle }, ...extra.x },
  yaxis: { title: { text: yTitle }, ...extra.y },
});

export const valueLab = ex =>
  lab(ex, {
    title: 'Try it: what moves the price',
    hint: 'drag the sliders',
    sliders: ['S', 'days', 'vol'],
    height: '',
    view(s, g) {
      const [lo, hi] = priceRange(ex),
        xs = grid(lo, hi),
        k = strikeMark(s),
        inr = Q.intrinsic(s.S, s.K, s.put);
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Worth at expiry',
            x: xs,
            y: xs.map(S => Q.intrinsic(S, s.K, s.put)),
            line: { color: C.ink, width: 2 },
            hovertemplate: 'at expiry $%{y:.2f}<extra></extra>',
          },
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Worth today',
            x: xs,
            y: xs.map(S => bs(s, { S }).price),
            line: { color: C.amber, width: 2 },
            fill: 'tonexty',
            fillcolor: 'rgba(255,176,0,0.10)',
            hovertemplate: 'today $%{y:.2f}<extra></extra>',
          },
          dot(s.S, g.price),
        ],
        layout: {
          ...axes('Stock price', 'Option value per share', {
            x: { tickprefix: '$' },
            y: { tickprefix: '$', rangemode: 'tozero' },
          }),
          hovermode: 'x unified',
          shapes: [k.shape],
          annotations: [k.note],
        },
        say: [
          'With the stock at ',
          h('b', null, F.usd(s.S)),
          `, ${s.days} days left and volatility at ${F.num(s.vol, 0)}%, this ${word(s.put)} is worth `,
          h('b', null, F.usd(g.price)),
          ` a share (${F.money(g.price * 100)} a contract): ${F.usd(inr)} of intrinsic value plus ${F.usd(Math.max(g.price - inr, 0))} of time value. The shaded gap between the two lines is the time value. Slide Days left to zero and watch it vanish.`,
        ],
      };
    },
  });

export const deltaLab = ex =>
  lab(ex, {
    title: 'Try it: delta is the slope',
    hint: 'move the stock price',
    sliders: ['S', 'days', 'vol'],
    view(s, g) {
      const [lo, hi] = priceRange(ex),
        xs = grid(lo, hi),
        half = (hi - lo) * 0.16,
        k = strikeMark(s);
      const move = smallMove(s.S);
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Option value today',
            x: xs,
            y: xs.map(S => bs(s, { S }).price),
            line: { color: C.ink, width: 2 },
            hovertemplate: 'value $%{y:.2f}<extra></extra>',
          },
          {
            type: 'scatter',
            mode: 'lines',
            name: `Slope here = delta ${F.num(g.delta, 2)}`,
            x: [s.S - half, s.S + half],
            y: [g.price - g.delta * half, g.price + g.delta * half],
            line: { color: C.amber, width: 2, dash: 'dash' },
            hoverinfo: 'skip',
          },
          dot(s.S, g.price),
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Delta at every price',
            x: xs,
            y: xs.map(S => bs(s, { S }).delta),
            xaxis: 'x2',
            yaxis: 'y2',
            line: { color: C.series[2], width: 2 },
            hovertemplate: 'delta %{y:.2f}<extra></extra>',
          },
          { ...dot(s.S, g.delta), xaxis: 'x2', yaxis: 'y2' },
        ],
        layout: {
          margin: { t: 26 },
          showlegend: true,
          shapes: [k.shape],
          annotations: [k.note],
          xaxis: { domain: [0, 0.56], title: { text: 'Stock price' }, tickprefix: '$' },
          yaxis: { title: { text: 'Option value' }, tickprefix: '$', rangemode: 'tozero' },
          xaxis2: { domain: [0.66, 1], title: { text: 'Stock price' }, tickprefix: '$', anchor: 'y2' },
          yaxis2: { title: { text: 'Delta' }, anchor: 'x2', range: s.put ? [-1.05, 0.05] : [-0.05, 1.05] },
        },
        say: [
          'The dashed line just touches the curve at the price you chose. Its slope is the delta: ',
          h('b', null, F.num(g.delta, 2)),
          `. If the stock rises ${F.usd(move)}, the ${word(s.put)} ${g.delta >= 0 ? 'gains' : 'loses'} about `,
          h('b', null, `${F.money(Math.abs(g.delta) * move * 100)} a contract`),
          `. Right now one contract moves like ${g.delta >= 0 ? 'owning' : 'being short'} `,
          h('b', null, `${F.int(Math.abs(g.delta) * 100)} shares`),
          '. The right-hand chart shows delta at every price: near 0 when far out of the money, near ',
          s.put ? '−1' : '1',
          ' when deep in the money, about half-way at the strike.',
        ],
      };
    },
  });

export const gammaLab = ex =>
  lab(ex, {
    title: 'Try it: gamma is how fast delta changes',
    hint: 'shrink Days left and watch the hill',
    sliders: ['S', 'days', 'vol'],
    view(s, g) {
      const [lo, hi] = priceRange(ex),
        xs = grid(lo, hi),
        k = strikeMark(s),
        move = smallMove(s.S);
      const up = bs(s, { S: s.S + move }).delta,
        dn = bs(s, { S: s.S - move }).delta;
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Delta',
            x: xs,
            y: xs.map(S => bs(s, { S }).delta),
            line: { color: C.series[2], width: 2 },
            hovertemplate: 'delta %{y:.2f}<extra></extra>',
          },
          dot(s.S, g.delta),
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Gamma (steepness of the delta curve)',
            x: xs,
            y: xs.map(S => bs(s, { S }).gamma),
            xaxis: 'x2',
            yaxis: 'y2',
            line: { color: C.amber, width: 2 },
            fill: 'tozeroy',
            fillcolor: 'rgba(255,176,0,0.10)',
            hovertemplate: 'gamma %{y:.3f}<extra></extra>',
          },
          { ...dot(s.S, g.gamma), xaxis: 'x2', yaxis: 'y2' },
        ],
        layout: {
          margin: { t: 26 },
          showlegend: true,
          shapes: [k.shape],
          annotations: [k.note],
          xaxis: { domain: [0, 0.46], title: { text: 'Stock price' }, tickprefix: '$' },
          yaxis: { title: { text: 'Delta' } },
          xaxis2: { domain: [0.56, 1], title: { text: 'Stock price' }, tickprefix: '$', anchor: 'y2' },
          yaxis2: { title: { text: 'Gamma' }, anchor: 'x2', rangemode: 'tozero' },
        },
        say: [
          'Delta is ',
          h('b', null, F.num(g.delta, 2)),
          ' now and gamma is ',
          h('b', null, F.greek(g.gamma, 3)),
          `. After a ${F.usd(move)} rise, delta becomes about ${F.num(up, 2)}; after a ${F.usd(move)} fall, about ${F.num(dn, 2)}. `,
          'Gamma is tallest where the delta curve is steepest: near the strike, and a little below it when volatility is high or there is a lot of time left. Drag Days left toward zero: the delta curve turns into a step and the gamma hill into a spike. That is why at-the-money options get wild in their last days.',
        ],
      };
    },
  });

export const thetaLab = ex =>
  lab(ex, {
    title: 'Try it: time decay',
    hint: 'drag Days left toward zero',
    sliders: ['days', 'S', 'vol'],
    view(s, g) {
      const max = Math.max(ex.days * 2, 60),
        ds = grid(0.01, max, 120),
        inr = Q.intrinsic(s.S, s.K, s.put);
      const at = d => bs(s, { T: Math.max(d, 0.01) / 365 });
      // What the option loses on the day that starts with d days left.
      const lossOn = d => at(d).price - at(d - 1).price;
      const dayLoss = -nextDay(s) * 100,
        weekOut = s.days > 9 ? lossOn(7) * 100 : null;
      let peak = 1; // the day on which this option loses the most
      for (let d = 2; d <= max; d++) if (lossOn(d) > lossOn(peak)) peak = d;
      const away = Math.abs(Math.log(s.S / s.K)) > 0.03; // more than about 3% from the strike
      // The move that pays for a day of decay.
      // Hedged: direction is cancelled with shares, so only the size of the move counts.
      const hedged = g.gamma > 0 && s.days >= 1 ? Math.sqrt((2 * Math.abs(g.theta)) / g.gamma) : null;
      const unhedged = Math.abs(g.delta) > 0.01 && s.days >= 1 ? Math.abs(g.theta) / Math.abs(g.delta) : null;
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Option value',
            x: ds,
            y: ds.map(d => at(d).price),
            line: { color: C.amber, width: 2 },
            fill: 'tozeroy',
            fillcolor: 'rgba(255,176,0,0.08)',
            hovertemplate: '%{x:.0f} days left: $%{y:.3f}<extra></extra>',
          },
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Intrinsic value (does not decay)',
            x: [0, max],
            y: [inr, inr],
            line: { color: C.ink2, width: 1, dash: 'dot' },
            hoverinfo: 'skip',
          },
          dot(s.days, g.price),
        ],
        layout: axes('Days left until expiry', 'Option value per share', {
          x: { autorange: 'reversed' },
          y: { tickprefix: '$', rangemode: 'tozero' },
        }),
        say:
          s.days < 1
            ? [
                'It expires today. Whatever time value is left, ',
                h('b', null, `${F.money(Math.max(g.price - inr, 0) * 100)} a contract`),
                ', is gone by the close.',
              ]
            : [
                'With ',
                h('b', null, `${s.days} days left`),
                ' this option loses about ',
                h('b', null, `${F.money(dayLoss)} a contract over the next day`),
                weekOut != null
                  ? ` if nothing else changes. With a week left it would be losing about ${F.money(weekOut)} a day. `
                  : ' if nothing else changes. ',
                away
                  ? `This option is away from the strike, so its time value drains earlier: decay is fastest with about ${peak} days left, and little is left to lose in the final days. `
                  : 'The curve gets steeper toward the right-hand edge: for an option at the strike, time value melts slowly at first and fastest at the end. ',
                hedged
                  ? `With the delta hedged away, the stock would need to move about ${F.usd(hedged)} (${F.pct(hedged / s.S)}) in a day, either way, to earn back that decay.`
                  : '',
                unhedged ? ` Simply owning it, about ${F.usd(unhedged)} in your favour covers it.` : '',
              ],
      };
    },
  });

export const vegaLab = ex =>
  lab(ex, {
    title: 'Try it: volatility changes the price',
    hint: 'drag Implied volatility',
    sliders: ['vol', 'days', 'S'],
    view(s, g) {
      const hi = Math.max(Math.round(ex.vol * 200), 120),
        vs = grid(5, hi, 120),
        lower = Math.max(s.vol - 10, 1),
        drop = bs(s, { vol: lower / 100 }).price;
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Option value',
            x: vs,
            y: vs.map(v => bs(s, { vol: v / 100 }).price),
            line: { color: C.ink, width: 2 },
            hovertemplate: 'IV %{x:.0f}%: $%{y:.3f}<extra></extra>',
          },
          dot(s.vol, g.price),
        ],
        layout: {
          ...axes('Implied volatility', 'Option value per share', {
            x: { ticksuffix: '%' },
            y: { tickprefix: '$', rangemode: 'tozero' },
          }),
          showlegend: false,
        },
        say: [
          'At ',
          h('b', null, `${F.num(s.vol, 0)}% implied volatility`),
          ' this option is worth ',
          h('b', null, F.usd(g.price)),
          `. Each extra point of volatility adds about ${F.money(g.vega * 100)} a contract (that is vega). `,
          `If volatility fell ${F.num(s.vol - lower, 0)} points to ${F.num(lower, 0)}%, with the stock not moving at all, the option would be worth ${F.usd(drop)}: a change of `,
          h('b', { class: 'down' }, `${F.pnl((drop - g.price) * 100)} a contract`),
          '. Add Days left and the line gets steeper: longer-dated options carry more vega.',
        ],
      };
    },
  });

export const rhoLab = ex =>
  lab(ex, {
    title: 'Try it: interest rates',
    hint: 'small for short dates, bigger for long ones',
    sliders: ['r', ['days', { max: 730 }]],
    toggle: false,
    view(s) {
      const rs = grid(0, 10, 80),
        c = bs(s, { put: false }),
        p = bs(s, { put: true });
      return {
        traces: [
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Call',
            x: rs,
            y: rs.map(r => bs(s, { r: r / 100, put: false }).price),
            line: { color: C.call, width: 2 },
            hovertemplate: 'call $%{y:.3f}<extra></extra>',
          },
          {
            type: 'scatter',
            mode: 'lines',
            name: 'Put',
            x: rs,
            y: rs.map(r => bs(s, { r: r / 100, put: true }).price),
            line: { color: C.put, width: 2 },
            hovertemplate: 'put $%{y:.3f}<extra></extra>',
          },
          dot(s.r, c.price),
          dot(s.r, p.price),
        ],
        layout: {
          ...axes('Interest rate', 'Option value per share', {
            x: { ticksuffix: '%' },
            y: { tickprefix: '$', rangemode: 'tozero' },
          }),
          hovermode: 'x unified',
        },
        say: [
          `With ${s.days} days left, a one-point rise in rates changes the call by `,
          h('b', null, `${F.pnl(c.rho * 100)} a contract`),
          ' and the put by ',
          h('b', null, `${F.pnl(p.rho * 100)}`),
          '. Both lines are nearly flat for short-dated options. Push Days left out past a year and they tilt: rho only matters for long-dated contracts. (The tiles above describe the call.)',
        ],
      };
    },
  });

// ---------------------------------------------------------------- one-off widgets

/** Buy or sell a call or put and see what it makes at expiry. */
export function payoffWidget(ex) {
  const [lo, hi] = priceRange(ex);
  // Today's fair premium for a strike: the model value, never below what exercising now would pay.
  const fair = (K, put) =>
    +Math.max(Q.bsPrice(ex.S, K, ex.days / 365, ex.r, ex.q, ex.vol, put), Q.intrinsic(ex.S, K, put)).toFixed(2) || 0.01;
  const s = { put: false, side: 1, K: ex.K, prem: fair(ex.K, false), at: ex.S };
  const el = chart(),
    say = h('p', { class: 'say' }),
    controls = h('div', { class: 'row', style: { marginBottom: '6px' } });
  const step = (hi - lo) / 300;
  const draw = () => {
    if (!el.isConnected) return;
    const xs = grid(lo, hi),
      pl = S => s.side * (Q.intrinsic(S, s.K, s.put) - s.prem) * 100,
      y = xs.map(pl);
    const be = s.put ? s.K - s.prem : s.K + s.prem,
      k = vline(s.K, `strike ${F.strike(s.K)}`, C.muted),
      b = vline(be, `break-even ${F.price(be)}`, C.ink2, 'dot', 'bottom'),
      now = pl(s.at);
    plot(
      el,
      [
        {
          type: 'scatter',
          mode: 'lines',
          x: xs,
          y: y.map(v => Math.max(v, 0)),
          line: { width: 0 },
          fill: 'tozeroy',
          fillcolor: 'rgba(12,163,12,0.20)',
          hoverinfo: 'skip',
        },
        {
          type: 'scatter',
          mode: 'lines',
          x: xs,
          y: y.map(v => Math.min(v, 0)),
          line: { width: 0 },
          fill: 'tozeroy',
          fillcolor: 'rgba(208,59,59,0.22)',
          hoverinfo: 'skip',
        },
        {
          type: 'scatter',
          mode: 'lines',
          x: xs,
          y,
          line: { color: C.ink, width: 2 },
          hovertemplate: 'stock at $%{x:.2f}<br>%{y:+$,.0f}<extra></extra>',
        },
        dot(s.at, now),
      ],
      {
        margin: { t: 14 },
        xaxis: { title: { text: 'Stock price at expiry' }, tickprefix: '$' },
        yaxis: { title: { text: 'Profit or loss, one contract' }, tickprefix: '$' },
        shapes: [
          k.shape,
          b.shape,
          { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: C.axis, width: 1 } },
        ],
        annotations: [k.note, b.note],
      },
    );
    const buy = s.side > 0,
      cost = s.prem * 100;
    mount(
      say,
      buy
        ? `You pay ${F.money(cost)} for the right to ${s.put ? 'sell' : 'buy'} 100 shares at ${F.usd(s.K)}. That ${F.money(cost)} is the most you can lose. `
        : `You are paid ${F.money(cost)} and take on the duty to ${s.put ? 'buy' : 'sell'} 100 shares at ${F.usd(s.K)} if the buyer wants. That ${F.money(cost)} is the most you can make. `,
      `Break-even is ${F.usd(be)} (strike ${s.put ? 'minus' : 'plus'} premium). If the stock finishes at `,
      h('b', null, F.usd(s.at)),
      ', you ',
      h('b', { class: now >= 0 ? 'up' : 'down' }, `${now >= 0 ? 'make' : 'lose'} ${F.money(Math.abs(now))}`),
      '.',
    );
  };
  // Choosing another strike or type resets the premium to today's fair price for it,
  // so the picture is always a trade that could exist.
  const reprice = () => {
    s.prem = fair(s.K, s.put);
    premium.set(s.prem);
    draw();
  };
  const paint = () =>
    mount(
      controls,
      callPut(s, reprice),
      seg(
        [
          [1, 'Buy it'],
          [-1, 'Sell it'],
        ],
        s.side,
        side => {
          s.side = side;
          paint();
          draw();
        },
        null,
        'Side',
      ),
    );
  const premium = slider({
    label: 'Premium',
    min: 0.01,
    max: Math.max(ex.S * 0.5, hi - lo),
    step: 0.01,
    value: s.prem,
    format: F.usd,
    onInput: v => {
      s.prem = v;
      draw();
    },
  });
  paint();
  const node = box(
    'Try it: profit and loss at expiry',
    'the hockey stick',
    controls,
    slider({
      label: 'Strike',
      min: lo,
      max: hi,
      step,
      value: s.K,
      format: F.usd,
      onInput: v => {
        s.K = v;
        reprice();
      },
    }),
    premium,
    slider({
      label: 'Stock ends at',
      min: lo,
      max: hi,
      step,
      value: s.at,
      format: F.usd,
      onInput: v => {
        s.at = v;
        draw();
      },
    }),
    el,
    say,
  );
  later(draw);
  return node;
}

/** Slide the stock price and watch intrinsic and time value trade places. */
export function splitWidget(ex) {
  const [lo, hi] = priceRange(ex),
    s = startState(ex),
    el = chart('mini'),
    say = h('p', { class: 'say' });
  const draw = () => {
    if (!el.isConnected) return;
    const rows = [true, false].map(put => {
      const price = bs(s, { put }).price,
        inr = Math.min(Q.intrinsic(s.S, s.K, put), price);
      return { put, price, inr, time: price - inr };
    });
    plot(
      el,
      [
        {
          type: 'bar',
          orientation: 'h',
          name: 'Intrinsic value',
          y: rows.map(r => (r.put ? 'Put' : 'Call')),
          x: rows.map(r => r.inr),
          marker: { color: rows.map(r => (r.put ? C.put : C.call)) },
          hovertemplate: 'intrinsic $%{x:.2f}<extra></extra>',
        },
        {
          type: 'bar',
          orientation: 'h',
          name: 'Time value',
          y: rows.map(r => (r.put ? 'Put' : 'Call')),
          x: rows.map(r => r.time),
          marker: { color: 'rgba(255,176,0,0.55)', line: { color: C.amber, width: 1 } },
          hovertemplate: 'time value $%{x:.2f}<extra></extra>',
        },
      ],
      {
        barmode: 'stack',
        showlegend: true,
        margin: { l: 44, t: 26, b: 30 },
        xaxis: { tickprefix: '$' },
        yaxis: { type: 'category' },
      },
    );
    const c = rows[1],
      p = rows[0],
      state = v => (Math.abs(s.S - s.K) / s.K < 0.01 ? 'at the money' : v ? 'in the money' : 'out of the money');
    mount(
      say,
      'Stock at ',
      h('b', null, F.usd(s.S)),
      `, strike ${F.usd(s.K)}. The call is ${state(s.S > s.K)}: worth ${F.usd(c.price)} = ${F.usd(c.inr)} intrinsic + ${F.usd(c.time)} time value. `,
      `The put is ${state(s.S < s.K)}: worth ${F.usd(p.price)} = ${F.usd(p.inr)} intrinsic + ${F.usd(p.time)} time value. Time value (amber) is largest when the stock sits right at the strike.`,
    );
  };
  const node = box(
    'Try it: intrinsic value and time value',
    'solid = intrinsic, amber = time',
    slider({
      label: 'Stock price',
      min: lo,
      max: hi,
      step: (hi - lo) / 300,
      value: s.S,
      format: F.usd,
      onInput: v => {
        s.S = v;
        draw();
      },
    }),
    slider({
      label: 'Days left',
      min: 0,
      max: Math.max(ex.days * 2, 60),
      step: 1,
      value: s.days,
      format: v => `${v} days`,
      onInput: v => {
        s.days = v;
        draw();
      },
    }),
    el,
    say,
  );
  later(draw);
  return node;
}

/** Implied volatility turned into a range of likely prices. */
export function coneWidget(ex) {
  const s = { vol: +(ex.vol * 100).toFixed(0), days: ex.days },
    el = chart(),
    say = h('p', { class: 'say' });
  const draw = () => {
    if (!el.isConnected) return;
    const T = Math.max(s.days, 0.5) / 365,
      v = s.vol / 100,
      sd = v * Math.sqrt(T),
      F0 = ex.S;
    const lo = F0 * Math.exp(-3.2 * sd),
      hi = F0 * Math.exp(3.2 * sd),
      xs = grid(lo, hi, 240);
    const dens = x => Q.pdf((Math.log(x / F0) + (sd * sd) / 2) / sd) / (x * sd);
    // The bands hold exactly 68% and 95% of the outcomes of the plotted curve
    // (whose centre sits a little below today's price).
    const band = z => [F0 * Math.exp((-sd * sd) / 2 - z * sd), F0 * Math.exp((-sd * sd) / 2 + z * sd)],
      [a1, b1] = band(1),
      [a2, b2] = band(2);
    const inside = (a, b) => xs.filter(x => x >= a && x <= b);
    const area = (a, b, color, name) => ({
      type: 'scatter',
      mode: 'lines',
      name,
      x: inside(a, b),
      y: inside(a, b).map(dens),
      line: { width: 0 },
      fill: 'tozeroy',
      fillcolor: color,
      hoverinfo: 'skip',
    });
    const m = vline(F0, `now ${F.price(F0)}`, C.ink2);
    plot(
      el,
      [
        area(a2, b2, 'rgba(255,176,0,0.12)', 'About 95% of outcomes'),
        area(a1, b1, 'rgba(255,176,0,0.30)', 'About 68% of outcomes'),
        {
          type: 'scatter',
          mode: 'lines',
          name: 'Likelihood',
          x: xs,
          y: xs.map(dens),
          line: { color: C.amber, width: 2 },
          hovertemplate: '$%{x:.2f}<extra></extra>',
          showlegend: false,
        },
      ],
      {
        showlegend: true,
        margin: { t: 26, l: 20 },
        xaxis: { title: { text: `Stock price in ${s.days} days` }, tickprefix: '$' },
        yaxis: { showticklabels: false, title: { text: 'More likely ↑' }, rangemode: 'tozero' },
        shapes: [m.shape],
        annotations: [m.note],
      },
    );
    mount(
      say,
      'An implied volatility of ',
      h('b', null, `${s.vol}%`),
      s.days > 1
        ? ` means typical daily moves of about ${F.pct(v / Math.sqrt(252))} (divide by 16). Over ${s.days} days it prices a move of about `
        : ' prices a move over one day of about ',
      h('b', null, `±${F.usd(F0 * sd)} (${F.pct(sd)})`),
      ': two times in three the stock ends between ',
      h('b', null, `${F.usd(a1)} and ${F.usd(b1)}`),
      `, and nineteen times in twenty between ${F.usd(a2)} and ${F.usd(b2)}. `,
      "It says nothing about direction: the average outcome is today's price. The peak sits a little lower and the range reaches further up than down, because a stock can rise more than it can fall.",
    );
  };
  const node = box(
    'Try it: volatility as a range of prices',
    "the market's bell curve",
    slider({
      label: 'Implied volatility',
      min: 5,
      max: Math.max(Math.round(ex.vol * 200), 150),
      step: 1,
      value: s.vol,
      format: v => `${v}%`,
      onInput: v => {
        s.vol = v;
        draw();
      },
    }),
    slider({
      label: 'Days ahead',
      min: 1,
      max: 365,
      step: 1,
      value: s.days,
      format: v => `${v} days`,
      onInput: v => {
        s.days = v;
        draw();
      },
    }),
    el,
    say,
  );
  later(draw);
  return node;
}

const signedBars = (el, labels, values, title) =>
  plot(
    el,
    [
      {
        type: 'bar',
        x: labels,
        y: values,
        marker: { color: values.map(v => (v >= 0 ? C.up : C.loss)) },
        text: values.map(v => F.pnl(v)),
        textposition: 'outside',
        cliponaxis: false,
        hovertemplate: '%{x}: %{y:+$,.2f}<extra></extra>',
      },
    ],
    {
      margin: { t: 22, b: 44 },
      xaxis: { type: 'category' },
      yaxis: { title: { text: title }, tickprefix: '$', zeroline: true },
    },
  );

/** Right about direction, wrong about volatility: the earnings trap. */
export function crushWidget(ex) {
  const base = Math.round(ex.vol * 100),
    s = { before: Math.round(base * 1.4), after: base, move: 3 },
    el = chart('short'),
    say = h('p', { class: 'say' });
  const days = Math.max(Math.min(ex.days, 14), 3);
  const draw = () => {
    if (!el.isConnected) return;
    const val = (S, d, v) => Q.bsPrice(S, ex.K, d / 365, ex.r, ex.q, v / 100, false) * 100,
      S1 = ex.S * (1 + s.move / 100);
    // Three things happen overnight, taken one at a time: the stock moves, a day passes, volatility changes.
    const start = val(ex.S, days, s.before),
      moved = val(S1, days, s.before),
      aged = val(S1, days - 1, s.before),
      end = val(S1, days - 1, s.after);
    const fell = s.after <= s.before;
    signedBars(
      el,
      ['From the stock move', 'From one day passing', `From volatility ${fell ? 'falling' : 'rising'}`, 'Net result'],
      [moved - start, aged - moved, end - aged, end - start],
      'Change in one call',
    );
    mount(
      say,
      `You buy a ${F.strike(ex.K)} call with ${days} days left, the day before earnings, for ${F.money(start)}, with volatility pumped up to ${s.before}%. Next morning the stock is `,
      h('b', null, `${s.move >= 0 ? 'up' : 'down'} ${Math.abs(s.move)}%`),
      ` and volatility has ${fell ? 'dropped' : 'risen'} to ${s.after}%. The move ${moved >= start ? 'made' : 'cost'} you ${F.money(Math.abs(moved - start))}, the day that passed cost ${F.money(Math.abs(aged - moved))}, `,
      `and the ${fell ? 'drop' : 'rise'} in volatility ${end >= aged ? 'added' : 'cost'} ${F.money(Math.abs(end - aged))}. Net: `,
      h('b', { class: end >= start ? 'up' : 'down' }, F.pnl(end - start)),
      end < start && s.move > 0 ? '. You were right about the direction and still lost money.' : '.',
    );
  };
  const node = box(
    'Try it: the volatility crush',
    'why options can fall after good news',
    slider({
      label: 'IV before the news',
      min: 10,
      max: Math.max(base * 3, 150),
      step: 1,
      value: s.before,
      format: v => `${v}%`,
      onInput: v => {
        s.before = v;
        draw();
      },
    }),
    slider({
      label: 'IV after the news',
      min: 5,
      max: Math.max(base * 3, 150),
      step: 1,
      value: s.after,
      format: v => `${v}%`,
      onInput: v => {
        s.after = v;
        draw();
      },
    }),
    slider({
      label: 'Stock move',
      min: -15,
      max: 15,
      step: 0.5,
      value: s.move,
      format: v => `${v >= 0 ? '+' : ''}${v}%`,
      onInput: v => {
        s.move = v;
        draw();
      },
    }),
    el,
    say,
  );
  later(draw);
  return node;
}

/** Split a change in option price into what each Greek contributed. */
export function attributionWidget(ex) {
  const s = { ...startState(ex), move: 3, pass: Math.min(5, Math.max(ex.days - 1, 0)), dv: -5 },
    el = chart('short'),
    say = h('p', { class: 'say' });
  const draw = () => {
    if (!el.isConnected) return;
    const g = bs(s),
      dS = (s.S * s.move) / 100;
    const after = bs(s, { S: s.S + dS, T: Math.max(s.days - s.pass, 0.01) / 365, vol: (s.vol + s.dv) / 100 });
    const parts = [g.delta * dS, 0.5 * g.gamma * dS * dS, g.theta * s.pass, g.vega * s.dv].map(v => v * 100),
      total = (after.price - g.price) * 100;
    const rest = total - parts.reduce((a, b) => a + b, 0);
    signedBars(
      el,
      ['Delta', 'Gamma', 'Theta', 'Vega', 'Everything else', 'Actual change'],
      [...parts, rest, total],
      'Dollars per contract',
    );
    const biggest = [
      'the stock move (delta)',
      'the curve in the move (gamma)',
      'time passing (theta)',
      'the change in volatility (vega)',
    ][parts.map(Math.abs).indexOf(Math.max(...parts.map(Math.abs)))];
    mount(
      say,
      `The stock moves ${s.move >= 0 ? '+' : ''}${s.move}%, ${s.pass} days pass and volatility changes by ${s.dv >= 0 ? '+' : ''}${s.dv} points. This ${word(s.put)} goes from ${F.usd(g.price)} to ${F.usd(after.price)}: `,
      h('b', { class: total >= 0 ? 'up' : 'down' }, `${F.pnl(total)} a contract`),
      `. The biggest single driver was ${biggest}. "Everything else" is what the four Greeks miss, because they are measured at the starting point and keep changing along the way. It grows with the size of the move.`,
    );
  };
  const node = box(
    'Try it: where did the profit or loss come from?',
    'the four Greeks add up',
    slider({
      label: 'Stock move',
      min: -20,
      max: 20,
      step: 0.5,
      value: s.move,
      format: v => `${v >= 0 ? '+' : ''}${v}%`,
      onInput: v => {
        s.move = v;
        draw();
      },
    }),
    slider({
      label: 'Days that pass',
      min: 0,
      max: Math.max(ex.days - 1, 1),
      step: 1,
      value: s.pass,
      format: v => `${v} days`,
      onInput: v => {
        s.pass = v;
        draw();
      },
    }),
    slider({
      label: 'Volatility change',
      min: -Math.min(30, Math.floor(s.vol) - 1),
      max: 30,
      step: 1,
      value: Math.max(s.dv, -(Math.floor(s.vol) - 1)),
      format: v => `${v >= 0 ? '+' : ''}${v} pts`,
      onInput: v => {
        s.dv = v;
        draw();
      },
    }),
    el,
    say,
  );
  later(draw);
  return node;
}

/**
 * Multiple-choice questions. items: [{ q, a: [answers], right: index of the right one, why }].
 * The answers are shown in a fresh random order each time, so the right one cannot be learnt by
 * its position. onDone fires when every question has been answered correctly.
 */
export function quiz(items, onDone) {
  const solved = new Set();
  const shuffled = n => {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  };
  return h(
    'div',
    null,
    items.map((item, n) => {
      const why = h('div', { class: 'why', 'aria-live': 'polite' });
      const opts = h(
        'div',
        { class: 'opts' },
        shuffled(item.a.length).map(i =>
          h(
            'button',
            {
              onclick: ev => {
                const right = i === item.right;
                ev.currentTarget.className = right ? 'right' : 'wrong';
                why.textContent = (right ? 'Correct. ' : 'Not quite. ') + (right ? item.why : 'Try another answer.');
                if (right) {
                  solved.add(n);
                  if (solved.size === items.length) onDone?.();
                }
              },
            },
            item.a[i],
          ),
        ),
      );
      return h('div', { class: 'quiz' }, h('div', { class: 'qq' }, `${n + 1}. ${item.q}`), opts, why);
    }),
  );
}

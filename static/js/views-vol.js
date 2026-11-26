// Volatility view (skew, term structure, surface) and Open Interest view (positioning by strike).
import * as M from './model.js';
import * as F from './fmt.js';
import { h, append, mount, plot, chart, panel, table, empty, note, seg, check, values, C, vline, hline, scene3d, whenVisible } from './ui.js';
import { expiryPicker } from './expiries.js';

const noChain = (root, ctx) => append(root, ctx.noChain());
const expLabel = F.expiryName;
const ACROSS = [['strike', 'Strike'], ['money', '% of price']];
const OI_WINDOWS = [[8, '±8'], [15, '±15'], [30, '±30'], [0, 'All']];
const TIME_EXPIRIES = 30;     // "open interest by expiry" shows this many expiries at most
let surfaceCamera = null;     // where the 3D surface was left: { symbol, camera }. Kept across refreshes, never saved.
/** Position of a value on a category axis whose categories are the sorted numbers in `cats`. */
function catPos(cats, v) {
  if (v <= cats[0]) return 0;
  for (let i = 1; i < cats.length; i++) if (v <= cats[i]) return i - 1 + (v - cats[i - 1]) / (cats[i] - cats[i - 1]);
  return cats.length - 1;
}

// ---------------------------------------------------------------- volatility

export function vol(root, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote;
  if (!chain) return noChain(root, ctx);
  const withSmile = chain.expiries.filter(e => e.smile?.length >= 1);        // every expiry with at least one real quote to plot
  const p = ctx.prefs('vol', { x: 'strike', band: true, picks: {} }, { x: values(ACROSS) });
  const set = patch => { Object.assign(p, patch); ctx.savePrefs(); ctx.rerenderView(); };
  // Remember chosen expiries per symbol; start with the nearest few that have at least two points.
  const mine = p.picks[app.symbol];
  let picks = (Array.isArray(mine) ? mine : []).filter(l => withSmile.some(e => e.label === l));
  if (!picks.length) picks = (withSmile.filter(e => e.smile.length >= 2 && e.days >= 2).length ? withSmile.filter(e => e.smile.length >= 2 && e.days >= 2) : withSmile).slice(0, 4).map(e => e.label);
  const toggle = label => {
    const next = picks.includes(label) ? picks.filter(l => l !== label) : [...picks, label].slice(-5);
    set({ picks: { ...p.picks, [app.symbol]: next } });
  };
  const chosen = withSmile.filter(e => picks.includes(e.label));

  const skew = chart('tall'), term = chart(), surf = chart('xl');
  append(root,
    h('div', { class: 'toolbar' },
      seg(ACROSS, p.x, x => set({ x }), 'Across'),
      check('Bid–ask range', p.band, band => set({ band }), 'Bars from the volatility implied by the bid up to the one implied by the ask. Long bars mean the market is not pinning the number down.')),
    expiryPicker(withSmile, { on: e => picks.includes(e.label), onPick: e => toggle(e.label), label: 'Compare up to 5', compact: false }),
    panel('Volatility by strike: the skew', { cls: 's8', code: 'SKEW', lesson: ['iv', () => ctx.openLesson('iv')] }, skew),
    panel('Reading the skew', { cls: 's4' }, h('div', { class: 'prose' },
      h('p', null, 'Each line is one expiry. Each point is the implied volatility of the option at that strike, taken from out-of-the-money contracts: puts below the price, calls above it.'),
      h('p', null, 'If every strike cost the same in volatility terms the line would be flat. A line that rises to the left means downside puts are dearer: traders pay extra for crash protection. A line that rises to the right means upside calls are in demand.'),
      h('p', null, 'Lighter lines expire sooner. Vertical bars show how well each number is pinned down by the bid and ask.'))),
    panel('Volatility by expiry: the term structure', { cls: 's6', code: 'TERM' }, term,
      note('At-the-money volatility for each expiry. Rising to the right is the calm, normal shape. A hump or a high left end marks a date the market is worried about, often earnings.')),
    panel('Volatility surface', { cls: 's6', code: 'SURF' }, surf,
      note('Strike across, time back, volatility up: every quote in one picture. Drag to rotate, scroll to zoom. Points are real quotes; the sheet joins them.')));

  // --- skew
  if (!chosen.length) mount(skew, empty('No expiry has a quote tight enough to measure volatility.'));
  else {
    const xOf = (e, K) => (p.x === 'money' ? K / e.F * 100 : K);
    const traces = chosen.map((e, i) => {
      const color = C.ramp[Math.round(i * (C.ramp.length - 1) / Math.max(chosen.length - 1, 1))];
      return { type: 'scatter', mode: 'lines+markers', name: `${expLabel(e)} (${F.days(e.days)})`, x: e.smile.map(n => xOf(e, n.strike)), y: e.smile.map(n => n.iv * 100),
        line: { color, width: 2 }, marker: { color, size: 8, line: { color: C.surface, width: 2 } },
        error_y: p.band ? { type: 'data', symmetric: false, array: e.smile.map(n => ((n.hi ?? n.iv) - n.iv) * 100), arrayminus: e.smile.map(n => (n.iv - (n.lo ?? n.iv)) * 100), color, thickness: 1, width: 3 } : undefined,
        customdata: e.smile.map(n => [F.strike(n.strike), n.put ? 'put' : 'call', F.iv(n.lo), F.iv(n.hi)]),
        hovertemplate: '<b>%{customdata[0]} %{customdata[1]}</b><br>IV %{y:.0f}%<br>bid/ask range %{customdata[2]} to %{customdata[3]}<extra>%{fullData.name}</extra>' };
    });
    const m = p.x === 'money' ? vline(100, 'at the money', C.amber) : vline(chain.spot, `${q.symbol.replace('^', '')} ${F.price(chain.spot)}`, C.amber);
    plot(skew, traces, { showlegend: true, margin: { t: 30 }, xaxis: { title: { text: p.x === 'money' ? 'Strike as % of the forward price' : 'Strike' }, ticksuffix: p.x === 'money' ? '%' : '' },
      yaxis: { title: { text: 'Implied volatility' }, ticksuffix: '%', rangemode: 'tozero' }, shapes: [m.shape], annotations: [m.note] });
  }

  // --- term structure
  const ts = M.termStructure(chain);
  if (ts.length < 2) mount(term, empty('Too few expiries with a usable quote to draw a term structure.'));
  else {
    const marks = [];
    if (app.hv?.d20 != null) marks.push(hline(app.hv.d20 * 100, `realized, last 20 days ${F.iv(app.hv.d20)}`, C.series[2], 'dot'));
    if (app.hv?.d60 != null) marks.push(hline(app.hv.d60 * 100, `realized, last 60 days ${F.iv(app.hv.d60)}`, C.series[4], 'dot'));
    if (app.hv?.d60 != null && marks.length === 2) marks[1].note.yanchor = 'top';
    whenVisible(term, () => plot(term, [{ type: 'scatter', mode: 'lines+markers', x: ts.map(e => e.days), y: ts.map(e => e.atmIV * 100), line: { color: C.amber, width: 2 }, marker: { color: C.amber, size: 8, line: { color: C.surface, width: 2 } },
      customdata: ts.map(e => [F.dateLong(e.date), F.usd(e.em), F.pct(e.em / e.F)]), hovertemplate: '<b>%{customdata[0]}</b> (%{x:.0f} days)<br>ATM IV %{y:.0f}%<br>expected move ±%{customdata[1]} (%{customdata[2]})<extra></extra>' }],
      { xaxis: { title: { text: 'Days to expiry (log scale)' }, type: 'log', tickvals: [1, 2, 7, 14, 30, 60, 90, 180, 365, 730], ticktext: ['1', '2', '7', '14', '30', '60', '90', '180', '1y', '2y'] },
        yaxis: { title: { text: 'At-the-money IV' }, ticksuffix: '%', rangemode: 'tozero' }, shapes: marks.map(m => m.shape), annotations: marks.map(m => m.note) }));
  }

  // --- surface
  const rich = withSmile.filter(e => e.smile.length >= 3 && e.days >= 1);
  const sheet = rich.length >= 3;
  // With a sheet, keep to strikes within 60% to 160% of the price so far-flung quotes do not squash it.
  const lo = sheet ? Math.max(60, Math.min(...rich.map(e => e.smile[0].strike / e.F * 100))) : 0;
  const hi = sheet ? Math.min(160, Math.max(...rich.map(e => e.smile[e.smile.length - 1].strike / e.F * 100))) : Infinity;
  const nodes = withSmile.flatMap(e => e.smile.map(n => ({ e, n }))).filter(v => { const m = v.n.strike / v.e.F * 100; return m >= lo && m <= hi; });
  if (!nodes.length) mount(surf, empty('No usable quotes to draw.'));
  else whenVisible(surf, () => {
    const pts = { type: 'scatter3d', mode: 'markers', x: nodes.map(v => v.n.strike / v.e.F * 100), y: nodes.map(v => Math.log10(Math.max(v.e.days, 0.5))), z: nodes.map(v => v.n.iv * 100),
      marker: sheet ? { size: 1.6, color: 'rgba(240,239,236,0.5)' } : { size: 4, color: C.amber }, customdata: nodes.map(v => [expLabel(v.e), F.strike(v.n.strike)]),
      hovertemplate: '<b>%{customdata[1]} strike, %{customdata[0]}</b><br>IV %{z:.0f}%<extra></extra>' };
    const traces = [pts];
    if (sheet) {
      const xs = Array.from({ length: 41 }, (_, i) => lo + (hi - lo) * i / 40);
      const z = rich.map(e => xs.map(m => { const K = e.F * m / 100; return K < e.smile[0].strike * 0.999 || K > e.smile[e.smile.length - 1].strike * 1.001 ? null : e.ivAt(K) * 100; }));
      traces.unshift({ type: 'surface', x: xs, y: rich.map(e => Math.log10(e.days)), z, colorscale: C.seq, opacity: 0.92, showscale: false, connectgaps: false,
        contours: { z: { show: false } }, hovertemplate: '%{x:.0f}% of price<br>IV %{z:.0f}%<extra></extra>' });
    }
    const ticks = [1, 7, 30, 90, 365, 730].filter(d => d >= Math.min(...nodes.map(v => v.e.days)) * 0.7 && d <= Math.max(...nodes.map(v => v.e.days)) * 1.4);
    plot(surf, traces, { margin: { l: 0, r: 0, t: 0, b: 0 }, scene: {
      xaxis: scene3d('Strike, % of price'), yaxis: { ...scene3d('Days to expiry'), tickvals: ticks.map(Math.log10), ticktext: ticks.map(String) }, zaxis: scene3d('IV %'),
      camera: surfaceCamera?.symbol === app.symbol ? surfaceCamera.camera : { eye: { x: 1.5, y: -1.8, z: 0.75 } }, aspectratio: { x: 1.2, y: 1.2, z: 0.7 } } }, { scrollZoom: true });
    // Remember how the surface was turned, so the minute's refresh does not swing it back.
    surf.on?.('plotly_relayout', change => { if (change['scene.camera']) surfaceCamera = { symbol: app.symbol, camera: change['scene.camera'] }; });
  });

  // --- table
  const rows = chain.expiries.filter(e => e.atmIV != null);
  append(root, panel('Volatility by expiry, in numbers', { cls: 'flush', code: `${rows.length} EXPIRIES` }, table([
    { label: 'Expiry', cls: 'l', cell: e => [F.weekday(e.date), ' ', F.dateLong(e.date), e.label !== e.date ? ` ${e.root}` : ''] },
    { label: 'Days', cell: e => F.days(e.days) },
    { label: 'ATM IV', tip: 'iv', cell: e => h('span', { class: e.smileSrc === 'quotes' ? 'amber' : 'muted' }, F.iv(e.atmIV)) },
    { label: '25Δ put IV', tiptext: 'Volatility of the put with a delta of -0.25: a strike moderately below the price.', cell: e => F.iv(M.riskReversal(e, chain.rate)?.put.iv) },
    { label: '25Δ call IV', tiptext: 'Volatility of the call with a delta of 0.25: a strike moderately above the price.', cell: e => F.iv(M.riskReversal(e, chain.rate)?.call.iv) },
    { label: 'Call − put', tip: 'skew', cell: e => { const r = M.riskReversal(e, chain.rate); return r ? h('span', { class: r.rr < -0.02 ? 'putc' : r.rr > 0.02 ? 'callc' : '' }, F.signed(r.rr * 100, 1) + ' pts') : '—'; } },
    { label: 'Straddle', tiptext: 'Cost of the at-the-money call plus put.', cell: e => F.price(e.straddle) },
    { label: '± Move', tip: 'em', cell: e => `${F.usd(e.em)} (${F.pct(e.em / e.F)})` },
    { label: 'Forward', tip: 'forward', cell: e => h('span', { class: e.forwardSrc === 'parity' ? '' : 'muted' }, F.price(e.F)) },
    { label: 'Points', tiptext: 'How many strikes had a quote good enough to measure volatility.', cell: e => (e.smileSrc === 'quotes' ? e.smile.length : e.smile.length ? `${e.smile.length}, far out` : 'none') },
  ], rows, { onRow: e => { app.expiry = e.label; app.selected = null; ctx.go('chain'); }, rowClass: e => (e.label === app.expiry ? 'on' : '') }),
  note('Grey figures are estimates: a volatility borrowed from the nearest expiry or guessed from far-away strikes, or a forward built from interest rates because calls and puts were not both quoted. "Call − put" below zero means downside protection costs more than upside.')));
}

// ---------------------------------------------------------------- open interest

export function oi(root, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote, sym = q.symbol.replace('^', '');
  if (!chain) return noChain(root, ctx);
  const p = ctx.prefs('oi', { scope: 'expiry', window: 15 }, { scope: ['expiry', 'near', 'all'], window: values(OI_WINDOWS) });
  const set = patch => { Object.assign(p, patch); ctx.savePrefs(); ctx.rerenderView(); };
  const exp = ctx.expiry() || chain.expiries[0];
  const scope = p.scope === 'expiry' ? [exp] : p.scope === 'near' ? chain.expiries.filter(e => e.days <= 45) : chain.expiries;
  const scopeName = p.scope === 'expiry' ? expLabel(exp) : p.scope === 'near' ? 'expiries in the next 45 days' : 'all expiries';
  let rows = M.byStrike(scope.length ? scope : [exp]);
  if (p.window && rows.length) {
    const at = rows.reduce((best, r, i) => (Math.abs(r.strike - chain.spot) < Math.abs(rows[best].strike - chain.spot) ? i : best), 0);
    rows = rows.filter((r, i) => Math.abs(i - at) <= p.window);
  }
  const strikes = rows.map(r => r.strike), cats = strikes.map(F.strike);
  const spotMark = () => { const m = vline(catPos(strikes, chain.spot), `${sym} ${F.price(chain.spot)}`, C.amber); return m; };
  const oiChart = chart(), volChart = chart(), painChart = chart(), gexChart = chart(), timeChart = chart('short');

  append(root,
    expiryPicker(chain.expiries, { on: e => e === exp, onPick: e => ctx.setExpiry(e.label) }),
    h('div', { class: 'toolbar' },
      seg([['expiry', expLabel(exp)], ['near', 'Next 45 days'], ['all', 'All expiries']], p.scope, s => set({ scope: s }), 'Scope'),
      seg(OI_WINDOWS, p.window, window => set({ window }), 'Strikes')),
    panel(`Open interest by strike · ${scopeName}`, { cls: 's6', code: 'OI', lesson: ['chain', () => ctx.openLesson('chain')] }, oiChart,
      note('Contracts that exist right now. Calls rise above the line, puts hang below it. Tall bars mark prices where many traders have something at stake.')),
    panel(`Volume today by strike · ${scopeName}`, { cls: 's6', code: 'VOL' }, volChart,
      note('Contracts traded this session. Volume well above open interest at a strike means new positions are being opened there today.')),
    panel(`Max pain · ${expLabel(exp)}`, { cls: 's6', code: 'PAIN' }, painChart,
      note('For each possible closing price, the total paid out to everyone holding options into this expiry. The low point is "max pain": the price at which holders collect least. A reference point, not a forecast.')),
    panel(`Dealer gamma exposure (estimate) · ${scopeName}`, { cls: 's6', code: 'GEX' }, gexChart,
      note('Roughly how many dollars of stock option dealers must trade per 1% move to stay hedged, by strike. Bars above zero tend to calm the price near that strike, bars below can amplify moves. It assumes dealers are long calls and short puts, which is a convention, not a fact.')));

  const mirrored = (el, callKey, putKey, word, extra = []) => {
    if (!rows.some(r => r[callKey] || r[putKey])) return mount(el, empty(`No ${word} in this selection.`));
    const m = spotMark();
    plot(el, [
      { type: 'bar', name: 'Calls', x: cats, y: rows.map(r => r[callKey]), marker: { color: C.call }, hovertemplate: '%{x} calls: %{y:,.0f}<extra></extra>' },
      { type: 'bar', name: 'Puts', x: cats, y: rows.map(r => -r[putKey]), customdata: rows.map(r => r[putKey]), marker: { color: C.put }, hovertemplate: '%{x} puts: %{customdata:,.0f}<extra></extra>' },
    ], { showlegend: true, barmode: 'relative', bargap: 0.18, margin: { t: 28 }, xaxis: { type: 'category', title: { text: 'Strike' } }, yaxis: { title: { text: `${word}  (puts below zero)` }, tickformat: '~s' },
      shapes: [m.shape, ...extra.map(e => e.shape)], annotations: [m.note, ...extra.map(e => e.note)] });
  };
  const pain = M.maxPain(exp);
  mirrored(oiChart, 'callOI', 'putOI', 'Open interest', p.scope === 'expiry' && strikes.includes(pain.strike) ? [vline(catPos(strikes, pain.strike), `max pain ${F.strike(pain.strike)}`, C.muted, 'dot', 'bottom')] : []);
  mirrored(volChart, 'callVol', 'putVol', 'Volume');

  if (exp.stats.callOI + exp.stats.putOI === 0) mount(painChart, empty('No open interest in this expiry yet.'));
  else {
    const near = pain.strikes.map((s, i) => [s, pain.pain[i]]).filter(([s]) => !p.window || (s >= strikes[0] && s <= strikes[strikes.length - 1]));
    const m1 = vline(pain.strike, `max pain ${F.strike(pain.strike)}`, C.amber), m2 = vline(chain.spot, `now ${F.price(chain.spot)}`, C.ink2, 'dot', 'bottom');
    whenVisible(painChart, () => plot(painChart, [{ type: 'scatter', mode: 'lines+markers', x: near.map(v => v[0]), y: near.map(v => v[1]), line: { color: C.ink, width: 2 }, marker: { size: 5, color: C.ink },
      hovertemplate: `If ${sym} closes at %{x}<br>holders are paid $%{y:,.0f}<extra></extra>` }],
      { xaxis: { title: { text: 'Closing price at expiry' } }, yaxis: { title: { text: 'Total paid to option holders' }, tickprefix: '$', tickformat: '~s', rangemode: 'tozero' },
        shapes: [m1.shape, m2.shape], annotations: [m1.note, m2.note] }));
  }
  if (!rows.some(r => r.gex)) mount(gexChart, empty('No open interest to estimate from.'));
  else {
    const m = spotMark();
    whenVisible(gexChart, () => plot(gexChart, [{ type: 'bar', x: cats, y: rows.map(r => r.gex), marker: { color: rows.map(r => (r.gex >= 0 ? C.call : C.loss)) }, hovertemplate: '%{x} strike<br>$%{y:,.0f} per 1% move<extra></extra>' }],
      { bargap: 0.18, xaxis: { type: 'category', title: { text: 'Strike' } }, yaxis: { title: { text: '$ of stock per 1% move' }, tickprefix: '$', tickformat: '~s' }, shapes: [m.shape], annotations: [m.note] }));
  }

  // positions through time
  const es = chain.expiries.slice(0, TIME_EXPIRIES);
  append(root, panel('Open interest by expiry', { code: 'TIME' }, timeChart, note('Where the open contracts sit in time. Monthly expiries (third Friday) usually hold the most.',
    chain.expiries.length > TIME_EXPIRIES ? ` The first ${TIME_EXPIRIES} of ${chain.expiries.length} expiries are shown.` : '')));
  whenVisible(timeChart, () => plot(timeChart, [
    { type: 'bar', name: 'Calls', x: es.map(expLabel), y: es.map(e => e.stats.callOI), marker: { color: C.call }, hovertemplate: '%{x} calls: %{y:,.0f}<extra></extra>' },
    { type: 'bar', name: 'Puts', x: es.map(expLabel), y: es.map(e => -e.stats.putOI), customdata: es.map(e => e.stats.putOI), marker: { color: C.put }, hovertemplate: '%{x} puts: %{customdata:,.0f}<extra></extra>' },
  ], { showlegend: true, barmode: 'relative', bargap: 0.25, margin: { t: 28, b: 60 }, xaxis: { type: 'category' }, yaxis: { tickformat: '~s' } }));

  // tables
  const open = c => { ctx.select(c); ctx.go('chain'); };
  const cols = extra => [
    { label: 'Contract', cls: 'l', cell: c => h('span', { class: c.put ? 'putc' : 'callc' }, F.contractName(c)) },
    { label: 'Days', cell: c => F.days(c.exp.days) },
    { label: 'Volume', tip: 'volume', cell: c => F.int(c.vol) }, { label: 'OI', tip: 'oi', cell: c => F.int(c.oi) },
    ...extra,
    { label: 'Bid', tip: 'bid', cell: c => (c.bid > 0 ? F.price(c.bid) : '—') }, { label: 'Ask', tip: 'ask', cell: c => (c.ask > 0 ? F.price(c.ask) : '—') },
    { label: 'IV', tip: 'iv', cell: c => F.iv(c.sigma) }, { label: 'Delta', tip: 'delta', cell: c => F.greek(c.delta, 2) },
  ];
  const active = M.topContracts(chain, c => c.vol, 10), big = M.topContracts(chain, c => c.oi, 10);
  const unusual = M.topContracts(chain, c => (c.vol >= 25 && c.vol > c.oi ? c.vol / Math.max(c.oi, 1) : 0), 10);
  const ratio = { label: 'Vol / OI', tiptext: 'Today\'s volume divided by the contracts that existed this morning. Above 1 means more traded today than were open.', cell: c => F.num(c.vol / Math.max(c.oi, 1), 1) + '×' };
  append(root,
    panel('Most traded today', { cls: 's6 flush' }, active.length ? table(cols([]), active, { onRow: open }) : empty('Nothing has traded today.')),
    panel('Largest open positions', { cls: 's6 flush' }, big.length ? table(cols([]), big, { onRow: open }) : empty('No open interest.')),
    panel('Unusual activity: volume above open interest', { cls: 'flush', code: 'UOA' },
      unusual.length ? table(cols([ratio]), unusual, { onRow: open }) : empty('No contract has traded more than its open interest today (minimum 25 contracts).'),
      note('When more contracts trade in a day than existed in the morning, someone is opening a new position of real size. It does not say whether they bought or sold, or why.')));
}

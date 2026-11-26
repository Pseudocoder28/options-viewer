// Overview and Price views.
import * as M from './model.js';
import * as Q from './quant.js';
import * as F from './fmt.js';
import { h, append, mount, plot, chart, panel, stat, table, empty, note, story, seg, check, tone, btn, C, hline, vline, skeletonLines } from './ui.js';
import { chainStory } from './explain.js';


// ---------------------------------------------------------------- overview

export function overview(root, ctx) {
  const { app } = ctx, q = app.quote, c = app.chain, hv = app.hv || {};
  const sym = q.symbol.replace('^', '');
  const t = c?.totals;
  const stats = h('div', { class: 'stats' },
    stat('Prev close', F.price(q.prevClose)), stat('Open', F.price(q.open)),
    stat('Day range', `${F.price(q.dayLow)} – ${F.price(q.dayHigh)}`), stat('52-week range', `${F.price(q.yearLow)} – ${F.price(q.yearHigh)}`),
    stat('Volume', F.compact(q.volume), { sub: q.avgVolume ? `avg ${F.compact(q.avgVolume)}` : null }),
    q.marketCap ? stat('Market cap', '$' + F.compact(q.marketCap)) : null,
    q.shortPctFloat ? stat('Short interest', F.pct(q.shortPctFloat), { tiptext: 'Share of the tradable shares that are sold short. A high figure means borrowing the stock is expensive, which makes puts dearer relative to calls.', sub: 'of float' }) : null,
    q.beta ? stat('Beta', F.num(q.beta), { tiptext: 'How much the stock tends to move for each 1% move in the market.' }) : null,
    q.dividendYield ? stat('Dividend yield', F.pct(q.dividendYield, 2)) : null,
    q.earnings ? stat('Next earnings', F.date(q.earnings), { tiptext: 'Implied volatility usually builds into this date and drops right after it.' }) : null,
    c ? stat('IV 30-day', F.iv(c.iv30), { tip: 'iv', tone: 'amber' }) : null,
    hv.d20 != null ? stat('Realized 20d', F.iv(hv.d20), { tip: 'hv' }) : null,
    hv.d60 != null ? stat('Realized 60d', F.iv(hv.d60), { tip: 'hv' }) : null,
    c && hv.d20 != null && c.iv30 != null ? stat('IV minus realized', F.signed((c.iv30 - hv.d20) * 100, 0) + ' pts', { tiptext: 'Positive: options price more movement than the stock has been delivering. Negative: less.' }) : null,
    t ? stat('Open interest', F.compact(t.oi), { tip: 'oi', sub: `${F.compact(t.callOI)} C / ${F.compact(t.putOI)} P` }) : null,
    t ? stat('Option volume', F.compact(t.vol), { tip: 'volume', sub: `${F.compact(t.callVol)} C / ${F.compact(t.putVol)} P` }) : null,
    t && t.callOI ? stat('Put/call (OI)', F.num(t.putOI / t.callOI, 2), { tip: 'pcr' }) : null,
    stat('Risk-free rate', F.pct(q.rate, 2), { tiptext: 'The 13-week US Treasury bill yield, used in the pricing model.' }),
    q.sector ? stat('Sector', q.sector, { sub: q.industry }) : null);

  const priceChart = chart('short');
  append(root,
    panel('What the options market is saying', { cls: 's7', code: 'OV', lesson: ['iv', () => ctx.openLesson('iv')] },
      c ? story(chainStory(c, q, app.hv)) : ctx.noChain()),
    panel('Snapshot', { cls: 's5 flush' }, stats),
    panel(`${sym} price, one year`, { cls: 's7', tools: h('button', { class: 'btn ghost', onclick: () => ctx.go('price') }, 'FULL CHART →') }, priceChart));

  const year = ctx.year();
  if (year) {
    const x = year.t.map(ts => F.nyStamp(ts).slice(0, 10));
    const marks = [hline(q.price, `now ${F.price(q.price)}`, C.amber)];
    plot(priceChart, [{ type: 'scatter', mode: 'lines', x, y: year.c, line: { color: C.ink, width: 1.5 }, fill: 'tozeroy', fillcolor: 'rgba(240,239,236,0.05)',
      hovertemplate: '%{x|%b %d, %Y}<br>close %{y:,.2f}<extra></extra>' }],
      { margin: { l: 10, r: 54, t: 8, b: 26 }, yaxis: { side: 'right', range: [Math.min(...year.l) * 0.97, Math.max(...year.h) * 1.03] }, hovermode: 'x',
        shapes: marks.map(m => m.shape), annotations: marks.map(m => m.note) });
  } else mount(priceChart, app.chainLoading ? skeletonLines(5) : empty('No price history available.'));

  if (!c) return;
  const open = e => { ctx.app.expiry = e.label; ctx.app.selected = null; ctx.go('chain'); };
  const moves = c.expiries.filter(e => e.em != null && e.days >= 1);
  append(root, panel('Expected move by expiry', { cls: 's5 flush', lesson: ['iv', () => ctx.openLesson('iv')] },
    table([
      { label: 'Expiry', cls: 'l', cell: e => [F.date(e.date), e.days > 300 ? ` '${e.date.slice(2, 4)}` : ''] },
      { label: 'Days', cell: e => F.days(e.days) },
      { label: 'ATM IV', tip: 'iv', cell: e => h('span', { class: e.smileSrc === 'borrowed' ? 'muted' : '' }, F.iv(e.atmIV)) },
      { label: '± Move', tip: 'em', cell: e => F.usd(e.em) },
      { label: '± %', cell: e => F.pct(e.em / e.F) },
      { label: 'Typical range', cell: e => `${F.price(e.F * Math.exp(-e.atmIV * Math.sqrt(e.T)))} – ${F.price(e.F * Math.exp(e.atmIV * Math.sqrt(e.T)))}` },
    ], moves, { onRow: open, rowClass: e => (e.label === app.expiry ? 'on' : '') }),
    note('One standard deviation: the price ends inside the range about two times in three. Grey volatility figures are borrowed from a neighbouring expiry. Click a row to open that chain.')));

  const tag = e => h('span', { class: 'tag' + (e.kind === 'monthly' ? ' m' : '') }, { weekly: 'W', monthly: 'M', quarterly: 'Q', leap: 'LEAP' }[e.kind]);
  append(root, panel('Every expiry at a glance', { cls: 'flush', code: `${c.expiries.length} EXPIRIES · ${F.int(c.contracts.length)} CONTRACTS` },
    table([
      { label: 'Expiry', cls: 'l', cell: e => [F.weekday(e.date), ' ', F.dateLong(e.date), e.root !== c.expiries[0].root || e.label !== e.date ? ` ${e.root}` : '', tag(e)] },
      { label: 'Days', cell: e => F.days(e.days) },
      { label: 'Strikes', cell: e => e.strikes.length },
      { label: 'Quoted', tiptext: 'Contracts showing both a bid and an ask, out of all listed.', cell: e => `${e.stats.quoted}/${e.stats.total}` },
      { label: 'ATM IV', tip: 'iv', cell: e => h('span', { class: e.smileSrc === 'borrowed' ? 'muted' : '' }, F.iv(e.atmIV)) },
      { label: 'Straddle', tiptext: 'Cost of the at-the-money call plus put: roughly what the market charges for a move in either direction.', cell: e => F.price(e.straddle) },
      { label: 'Call vol', cls: 'callc', tip: 'volume', cell: e => F.int(e.stats.callVol) },
      { label: 'Put vol', cls: 'putc', tip: 'volume', cell: e => F.int(e.stats.putVol) },
      { label: 'Call OI', cls: 'callc', tip: 'oi', cell: e => F.int(e.stats.callOI) },
      { label: 'Put OI', cls: 'putc', tip: 'oi', cell: e => F.int(e.stats.putOI) },
      { label: 'P/C OI', tip: 'pcr', cell: e => (e.stats.callOI ? F.num(e.stats.putOI / e.stats.callOI, 2) : '—') },
      { label: 'Max pain', tip: 'maxpain', cell: e => F.strike(e.maxPain) },
      { label: 'Spread', tiptext: 'Typical bid/ask spread near the money, as a share of the option price.', cell: e => F.pct(e.stats.medSpread, 0) },
    ], c.expiries, { onRow: open, rowClass: e => (e.label === app.expiry ? 'on' : '') })));
}

// ---------------------------------------------------------------- price

const RANGES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', 'MAX'];

export function price(root, ctx) {
  const { app } = ctx, q = app.quote, sym = q.symbol.replace('^', '');
  const p = ctx.prefs('price', { range: '6M', type: 'candles', sma20: true, sma50: true, sma200: false, cone: true, walls: false });
  const set = patch => { Object.assign(p, patch); ctx.savePrefs(); ctx.rerenderView(); };
  const main = chart('xl'), volChart = chart('short'), statsBox = h('div', { class: 'stats' });
  const tick = (key, label, tiptext) => check(label, p[key], v => set({ [key]: v }), tiptext);
  const reset = h('button', { class: 'btn ghost', hidden: true, key: 'reset-zoom', onclick: () => window.Plotly.relayout(main, { 'xaxis.autorange': true }) }, 'RESET ZOOM');
  append(root,
    h('div', { class: 'toolbar' },
      seg(RANGES, p.range, range => set({ range }), 'Range'),
      seg([['candles', 'Candles'], ['line', 'Line']], p.type, type => set({ type }), 'Style'),
      tick('sma20', 'MA 20', 'Average close of the last 20 bars.'), tick('sma50', 'MA 50', 'Average close of the last 50 bars.'), tick('sma200', 'MA 200', 'Average close of the last 200 bars.'),
      app.chain ? tick('cone', 'Expected-move cone', 'The range option prices imply for each expiry date (one standard deviation). Daily charts only.') : null,
      app.chain ? tick('walls', 'OI walls', 'Strikes holding the most open contracts in the next 60 days.') : null),
    panel(`${sym} price`, { cls: 'flush', code: 'GP', tools: [h('span', { class: 'code' }, 'DRAG ACROSS THE CHART TO ZOOM · DOUBLE-CLICK TO RESET'), reset] }, main),
    panel('Realized against implied volatility', { cls: 's7', lesson: ['iv', () => ctx.openLesson('iv')] }, volChart,
      note('The lines show how much the price has actually been moving (annualised). The amber line is what options are pricing for the next 30 days. Options above the lines are pricing in more movement than the recent past.')),
    panel('This range in numbers', { cls: 's5 flush' }, statsBox),
    panel('How to read this chart', {}, h('div', { class: 'prose' },
      h('p', null, 'Each candle is one period. The thick body runs from the open to the close: green when the close is higher, red when it is lower. The thin wicks reach the high and the low. Bars along the bottom are volume.'),
      h('p', null, 'The moving averages smooth the closes over 20, 50 or 200 bars and show the trend without the noise.'),
      app.chain ? h('p', null, 'The amber cone on the right is not a forecast of direction. It is the range option prices imply for each expiry date: the market expects the price to finish inside the cone about two times in three, and outside it one time in three.') : null)));

  mount(main, empty(h('span', { class: 'spin' }), ' Loading price history…'));
  ctx.history(p.range).then(hist => {
    if (!main.isConnected) return;
    mount(main);
    drawPrice(main, hist, p, app, zoomed => { reset.hidden = !zoomed; });
    const s = M.historyStats(hist);
    if (s) mount(statsBox,
      stat('Change', F.signedPct(s.change), { tone: tone(s.change) }), stat('High', F.price(s.high)), stat('Low', F.price(s.low)),
      stat('Bars', F.int(s.bars), { sub: hist.interval + ' each' }), stat('Up bars', F.pct(s.upShare, 0)),
      stat('Typical bar range', F.pct(s.avgRange), { tiptext: 'Average high-to-low distance of one bar, as a share of the price.' }),
      stat('Typical move', F.pct(s.avgAbsMove), { tiptext: 'Average size of the close-to-close change, ignoring direction.' }),
      stat('Best bar', F.signedPct(s.best), { tone: 'up', sub: F.date(s.bestAt) }), stat('Worst bar', F.signedPct(s.worst), { tone: 'down', sub: F.date(s.worstAt) }));
  }).catch(e => { if (main.isConnected) mount(main, empty(e.message, '  ', btn('RETRY', ctx.rerenderView, '', 'Ask for the price history again'))); });

  const year = ctx.year();
  if (year && year.c.length > 25) {
    const x = year.t.map(ts => F.nyStamp(ts).slice(0, 10));
    const line = (n, color, name) => ({ type: 'scatter', mode: 'lines', name, x, y: Q.rollingVol(year.c, n).map(v => (v == null ? null : v * 100)), line: { color, width: 2 },
      hovertemplate: `${name} %{y:.0f}%<extra></extra>` });
    const iv30 = app.chain?.iv30, marks = iv30 != null ? [hline(iv30 * 100, `options imply ${F.iv(iv30)} for the next 30 days`, C.amber, 'dash')] : [];
    plot(volChart, [line(20, C.series[2], 'Realized, last 20 days'), line(60, C.series[4], 'Realized, last 60 days')],
      { showlegend: true, hovermode: 'x unified', yaxis: { ticksuffix: '%', rangemode: 'tozero' }, margin: { t: 26 },
        shapes: marks.map(m => m.shape), annotations: marks.map(m => m.note) });
  } else mount(volChart, app.chainLoading ? skeletonLines(5) : empty('Not enough daily history to measure realized volatility.'));
}

function drawPrice(el, hist, p, app, onZoom) {
  const q = app.quote, chain = app.chain, intraday = /[mh]$/.test(hist.interval), daily = hist.interval === '1d';
  const x = hist.t.map(ts => (intraday ? F.nyStamp(ts) : F.nyStamp(ts).slice(0, 10)));
  const traces = [], shapes = [], notes = [];
  if (p.type === 'candles') traces.push({ type: 'candlestick', name: q.symbol, x, open: hist.o, high: hist.h, low: hist.l, close: hist.c,
    increasing: { line: { color: C.up, width: 1 }, fillcolor: C.up }, decreasing: { line: { color: C.down, width: 1 }, fillcolor: C.down } });
  else traces.push({ type: 'scatter', mode: 'lines', name: q.symbol, x, y: hist.c, line: { color: C.ink, width: 1.6 }, hovertemplate: '%{y:,.2f}<extra>close</extra>' });
  const up = hist.c.map((c, i) => c >= hist.o[i]);
  traces.push({ type: 'bar', name: 'Volume', x, y: hist.v, yaxis: 'y2', marker: { color: up.map(u => (u ? 'rgba(12,163,12,0.45)' : 'rgba(230,103,103,0.45)')) }, hovertemplate: '%{y:,.0f}<extra>volume</extra>' });
  [['sma20', 20, C.series[2]], ['sma50', 50, C.series[3]], ['sma200', 200, C.series[4]]].forEach(([key, n, color]) => {
    if (p[key] && hist.c.length > n) traces.push({ type: 'scatter', mode: 'lines', name: `MA ${n}`, x, y: Q.sma(hist.c, n), line: { color, width: 1.3 }, hovertemplate: `%{y:,.2f}<extra>MA ${n}</extra>` });
  });

  const last = x[x.length - 1], spot = q.price;
  if (chain && p.cone && daily) {
    const span = (hist.t[hist.t.length - 1] - hist.t[0]) / 86400;
    const horizon = Math.max(35, Math.min(span * 0.4, 200));
    const pts = chain.expiries.filter(e => e.atmIV != null && e.days >= 1 && e.days <= horizon);
    if (pts.length) {
      const band = sign => [spot, ...pts.map(e => e.F * Math.exp(sign * e.atmIV * Math.sqrt(e.T)))];
      const cx = [last, ...pts.map(e => e.date)], text = ['now', ...pts.map(e => `${F.date(e.date)} · IV ${F.iv(e.atmIV)}`)];
      traces.push({ type: 'scatter', mode: 'lines', name: 'cone low', x: cx, y: band(-1), text, line: { color: C.amber, width: 1, dash: 'dot' }, hovertemplate: '%{text}<br>low %{y:,.2f}<extra></extra>' });
      traces.push({ type: 'scatter', mode: 'lines', name: 'Expected range (options)', x: cx, y: band(1), text, line: { color: C.amber, width: 1, dash: 'dot' }, fill: 'tonexty', fillcolor: 'rgba(255,176,0,0.10)',
        hovertemplate: '%{text}<br>high %{y:,.2f}<extra></extra>' });
      const end = pts[pts.length - 1];
      notes.push({ x: end.date, y: band(1)[pts.length], text: `${F.price(band(1)[pts.length])}`, showarrow: false, yanchor: 'bottom', font: { size: 10.5, color: C.amber } },
                 { x: end.date, y: band(-1)[pts.length], text: `${F.price(band(-1)[pts.length])}`, showarrow: false, yanchor: 'top', font: { size: 10.5, color: C.amber } });
    }
  }
  if (chain && p.walls) {
    const rows = M.byStrike(chain.expiries.filter(e => e.days <= 60), spot);
    const top = (key, color, word) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, 2).filter(r => r[key] > 0).forEach(r => {
      const m = hline(r.strike, `${word} ${F.strike(r.strike)} · ${F.compact(r[key])} open`, color, 'dash'); shapes.push(m.shape); notes.push({ ...m.note, x: 0, xanchor: 'left' });
    });
    top('callOI', C.call, 'calls'); top('putOI', C.put, 'puts');
  }
  const now = hline(spot, F.price(spot), C.amber);
  shapes.push(now.shape); notes.push({ ...now.note, x: 1, xanchor: 'left', xshift: 2, yanchor: 'middle', bgcolor: C.amber, font: { size: 10.5, color: '#000' } });
  if (q.earnings && daily) { const m = vline(F.nyStamp(q.earnings).slice(0, 10), 'earnings', C.muted); shapes.push(m.shape); notes.push(m.note); }

  const breaks = [];
  if (['EQUITY', 'ETF', 'INDEX'].includes(q.type) && (intraday || daily)) {
    breaks.push({ bounds: ['sat', 'mon'] });
    if (intraday) breaks.push({ bounds: [16, 9.5], pattern: 'hour' });
    const have = new Set(x.map(s => s.slice(0, 10))), holidays = [];
    for (let d = new Date(x[0].slice(0, 10) + 'T12:00:00Z'); d <= new Date(last.slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10), wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6 && !have.has(iso)) holidays.push(iso);
    }
    if (holidays.length) breaks.push({ values: holidays });
  }
  plot(el, traces, {
    showlegend: traces.length > 2, hovermode: 'x unified', margin: { l: 10, r: 58, t: 26, b: 30 },
    dragmode: 'zoom',        // drag across a stretch of dates to zoom into it; the price scale follows (below)
    xaxis: { rangeslider: { visible: false }, rangebreaks: breaks, showspikes: true, spikemode: 'across', spikethickness: 1, spikecolor: C.muted, spikedash: 'dot' },
    yaxis: { side: 'right', domain: [0.2, 1], tickformat: spot < 10 ? ',.2f' : ',.0f', fixedrange: true },
    yaxis2: { domain: [0, 0.15], showticklabels: false, showgrid: false, fixedrange: true },
    shapes, annotations: notes,
  });
  // After a zoom, fit the price scale to what is in view. Our own relayout comes back through this
  // event as well, which is why only changes to the date axis count.
  el.on?.('plotly_relayout', change => {
    if (!Object.keys(change).some(key => key.startsWith('xaxis.'))) return;
    const zoomed = el.layout.xaxis.autorange === false;
    onZoom?.(zoomed);
    if (!zoomed) return window.Plotly.relayout(el, { 'yaxis.autorange': true });
    const [from, to] = el.layout.xaxis.range.map(String);
    let lo = Infinity, hi = -Infinity;
    for (const t of el.data) {
      if (t.yaxis === 'y2') continue;                                 // volume keeps its own scale
      t.x.forEach((at, i) => {
        if (at < from || at > to) return;                             // both are "YYYY-MM-DD HH:MM" text, which sorts by time
        const low = (t.low || t.y)[i], high = (t.high || t.y)[i];
        if (low != null && low < lo) lo = low;
        if (high != null && high > hi) hi = high;
      });
    }
    if (hi > lo) window.Plotly.relayout(el, { 'yaxis.range': [lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06] });
  });
}

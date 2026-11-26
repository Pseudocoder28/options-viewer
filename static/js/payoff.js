// Profit-and-loss diagram shared by the chain's contract panel, the strategy builder and the lessons.
import * as F from './fmt.js';
import { plot, C, vline } from './ui.js';

/**
 * a: result of model.analysePosition (grid, atExpiry, today, breakevens, range).
 * opts: { spot, lines: [{ name, y, color, dash }], height, point: { x, y, text }, showRange }
 * Returns the index of the scenario-point trace (for Plotly.restyle), or -1 without one.
 */
export function drawPayoff(el, a, opts = {}) {
  const x = a.grid, y = a.atExpiry;
  const traces = [
    { type: 'scatter', mode: 'lines', x, y: y.map(v => Math.max(v, 0)), line: { width: 0 }, fill: 'tozeroy', fillcolor: 'rgba(12,163,12,0.20)', hoverinfo: 'skip', showlegend: false },
    { type: 'scatter', mode: 'lines', x, y: y.map(v => Math.min(v, 0)), line: { width: 0 }, fill: 'tozeroy', fillcolor: 'rgba(208,59,59,0.22)', hoverinfo: 'skip', showlegend: false },
    { type: 'scatter', mode: 'lines', name: `At expiry (${F.date(a.horizon)})`, x, y, line: { color: C.ink, width: 2 }, hovertemplate: 'price %{x:,.2f}<br>at expiry %{y:+$,.0f}<extra></extra>' },
    { type: 'scatter', mode: 'lines', name: 'If it happened today', x, y: a.today, line: { color: C.amber, width: 1.6, dash: 'dash' }, hovertemplate: 'today %{y:+$,.0f}<extra></extra>' },
  ];
  for (const l of opts.lines || []) traces.push({ type: 'scatter', mode: 'lines', name: l.name, x, y: l.y, line: { color: l.color || C.series[2], width: 1.6, dash: l.dash || 'dot' }, hovertemplate: `${l.name} %{y:+$,.0f}<extra></extra>` });
  let pointIndex = -1;
  if (opts.point) {
    pointIndex = traces.length;
    traces.push({ type: 'scatter', mode: 'markers', name: 'Your scenario', x: [opts.point.x], y: [opts.point.y], marker: { color: C.amber, size: 11, line: { color: '#000', width: 2 } }, hovertemplate: 'scenario %{y:+$,.0f}<extra></extra>', showlegend: false });
  }
  const shapes = [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: C.axis, width: 1 } }], notes = [];
  const add = m => { shapes.push(m.shape); notes.push(m.note); };
  if (opts.spot != null) add(vline(opts.spot, `now ${F.price(opts.spot)}`, C.ink2));
  a.breakevens.forEach(b => add(vline(b, `break-even ${F.price(b)}`, C.muted, 'dot', 'bottom')));
  if (opts.showRange && a.range) shapes.push({ type: 'rect', x0: a.range[0], x1: a.range[1], yref: 'paper', y0: 0, y1: 1, fillcolor: 'rgba(255,176,0,0.06)', line: { width: 0 }, layer: 'below' });
  // Keep unlimited payoffs from flattening the picture: show from the worst case to a sensible cap.
  const finite = [...y, ...a.today].filter(Number.isFinite);
  const lo = Math.min(...finite), hi = Math.max(...finite), pad = (hi - lo) * 0.08 || 1;
  plot(el, traces, {
    showlegend: true, hovermode: 'x unified', margin: { l: 58, r: 12, t: 26, b: 38 },
    xaxis: { title: { text: 'Price at expiry' }, tickprefix: '$' },
    yaxis: { title: { text: 'Profit or loss' }, tickprefix: '$', tickformat: ',.0f', range: [lo - pad, hi + pad] },
    shapes, annotations: notes,
  });
  return pointIndex;
}

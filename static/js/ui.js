// Small UI toolkit: DOM builder, themed Plotly wrapper, hover tips, modal and common controls.
import { TERMS } from './glossary.js';

// Chart palette for the dark terminal surface. Validated for contrast and colour-blind separation;
// calls are always blue and puts always orange, green and red are reserved for profit and loss.
export const C = {
  surface: '#0c0c0b', grid: '#1e1e1c', axis: '#3a3a37', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781',
  amber: '#ffb000', up: '#0ca30c', down: '#e66767', loss: '#d03b3b', call: '#3987e5', put: '#d95926',
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'],
  ramp: ['#cde2fb', '#86b6ef', '#3987e5', '#256abf', '#184f95'],              // ordered: near to far
  seq: [[0, '#0d2a52'], [0.25, '#184f95'], [0.5, '#256abf'], [0.75, '#6da7ec'], [1, '#cde2fb']],   // low to high
};
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/** h('div', { class: 'x', onclick: fn, tip: 'delta' }, 'text', child, [more]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;                       // trusted static markup only
    else if (k === 'tip') el.dataset.tip = v;
    else if (k === 'tiptext') el.dataset.tiptext = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, ...kids) {
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
export const mount = (el, ...kids) => { el.replaceChildren(); return append(el, kids); };

// ---------------------------------------------------------------- charts

const plots = new Set();
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return out; };
const AXIS = { gridcolor: C.grid, linecolor: C.axis, zerolinecolor: C.axis, tickcolor: C.axis, tickfont: { size: 10.5, color: C.muted },
               title: { font: { size: 11, color: C.muted }, standoff: 8 }, automargin: true };

/** Draw (or redraw) a chart with the terminal theme. Returns the element. */
export function plot(el, traces, layout = {}, config = {}) {
  if (!window.Plotly) {
    el.className += ' empty';
    el.textContent = 'Charts could not load (the Plotly library is fetched from the internet). Check the connection and reload.';
    return el;
  }
  let full = merge({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { family: MONO, size: 11, color: C.ink2 },
    margin: { l: 50, r: 14, t: 10, b: 38 }, colorway: C.series, showlegend: false, hovermode: 'closest', dragmode: false,
    hoverlabel: { bgcolor: '#161614', bordercolor: C.amber, font: { family: MONO, size: 12, color: C.ink }, align: 'left' },
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11, color: C.ink2 }, bgcolor: 'rgba(0,0,0,0)' },
  }, layout);
  // Plotly writes computed values (type, range) back into the layout it is given, so every axis
  // gets its own copy of the defaults.
  if (!full.scene) { full.xaxis ??= {}; full.yaxis ??= {}; }
  for (const key of Object.keys(full)) if (/^[xy]axis\d*$/.test(key)) full[key] = merge(structuredClone(AXIS), full[key]);
  window.Plotly.react(el, traces, full, { displayModeBar: false, responsive: true, ...config });
  plots.add(el);
  return el;
}
/** Free every chart that is no longer in the page (call before re-rendering a view). */
export function purgePlots() {
  for (const el of plots) if (!el.isConnected) { window.Plotly?.purge(el); plots.delete(el); }
}
export const chart = (cls = '') => h('div', { class: 'chart ' + cls });
export const scene3d = title => ({ title: { text: title, font: { size: 11, color: C.muted } }, backgroundcolor: 'rgba(0,0,0,0)',
  gridcolor: '#2a2a27', zerolinecolor: C.axis, linecolor: C.axis, tickfont: { size: 10, color: C.muted }, showbackground: false });
/** Vertical marker line with a label, as a Plotly shape plus annotation. */
export const vline = (x, text, color = C.ink2, dash = 'dot', yanchor = 'top') => ({
  shape: { type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1, line: { color, width: 1, dash } },
  note: { x, yref: 'paper', y: yanchor === 'top' ? 1 : 0, yanchor, text, showarrow: false, font: { size: 10.5, color }, xanchor: 'left', xshift: 4, bgcolor: 'rgba(12,12,11,0.75)' },
});
export const hline = (y, text, color = C.ink2, dash = 'dot') => ({
  shape: { type: 'line', y0: y, y1: y, xref: 'paper', x0: 0, x1: 1, line: { color, width: 1, dash } },
  note: { y, xref: 'paper', x: 1, xanchor: 'right', yanchor: 'bottom', text, showarrow: false, font: { size: 10.5, color }, bgcolor: 'rgba(12,12,11,0.75)' },
});

// ---------------------------------------------------------------- hover tips

let tipEl;
export function initTips() {
  tipEl = h('div', { id: 'tip', role: 'tooltip' });
  document.body.append(tipEl);
  const show = target => {
    const key = target.dataset.tip, entry = key && TERMS[key];
    const text = target.dataset.tiptext || entry?.short;
    if (!text) return;
    mount(tipEl, entry ? h('b', null, entry.term) : null, h('span', null, text));
    tipEl.style.display = 'block';
    const r = target.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
    const top = r.bottom + 8 + t.height > innerHeight ? r.top - t.height - 8 : r.bottom + 8;
    tipEl.style.left = left + 'px'; tipEl.style.top = Math.max(8, top) + 'px';
  };
  const hide = () => { tipEl.style.display = 'none'; };
  const find = e => e.target.closest?.('[data-tip],[data-tiptext]');
  document.addEventListener('mouseover', e => { const t = find(e); if (t) show(t); });
  document.addEventListener('mouseout', e => { if (find(e)) hide(); });
  document.addEventListener('focusin', e => { const t = find(e); if (t) show(t); });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
}
/** A word with a dotted underline that explains itself on hover. */
export const term = (key, text) => h('span', { class: 'term', tip: key, tabIndex: 0 }, text ?? TERMS[key]?.term ?? key);

// ---------------------------------------------------------------- modal

let modalEl;
export function openModal(title, body, { wide = false } = {}) {
  closeModal();
  modalEl = h('div', { class: 'modal-back', onclick: e => { if (e.target === modalEl) closeModal(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'btn ghost', onclick: closeModal, 'aria-label': 'Close' }, 'ESC ✕')),
      h('div', { class: 'modal-body' }, body)));
  document.body.append(modalEl);
}
export function closeModal() { modalEl?.remove(); modalEl = null; }
export const modalOpen = () => !!modalEl;

// ---------------------------------------------------------------- controls

/** Segmented buttons. options: ['a', 'b'] or [['value', 'Label', 'tip text'], ...]. */
export function seg(options, value, onPick, label) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const opt of options) {
    const [val, text, tiptext] = Array.isArray(opt) ? opt : [opt, opt];
    box.append(h('button', { class: val === value ? 'on' : '', tiptext, onclick: () => onPick(val) }, text ?? val));
  }
  return label ? h('label', { class: 'field' }, h('span', null, label), box) : box;
}
export function select(options, value, onChange, label) {
  const el = h('select', { onchange: e => onChange(e.target.value) },
    options.map(opt => { const [val, text] = Array.isArray(opt) ? opt : [opt, opt]; return h('option', { value: val, selected: String(val) === String(value) }, text); }));
  return label ? h('label', { class: 'field' }, h('span', null, label), el) : el;
}
/** Labelled slider. format(value) renders the readout; onInput fires while dragging. */
export function slider({ label, min, max, step, value, format = String, onInput, tip }) {
  const out = h('output', null, format(value));
  const input = h('input', { type: 'range', min, max, step, value, oninput: e => { const v = +e.target.value; out.textContent = format(v); onInput(v); } });
  const el = h('label', { class: 'slider' }, h('span', { tip }, label), input, out);
  el.set = v => { input.value = v; out.textContent = format(+v); };
  return el;
}
export function numberInput({ label, value, step = 'any', min, max, onChange, width, tip }) {
  const input = h('input', { type: 'number', value, step, min, max, style: width ? { width } : null,
    onchange: e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v); } });
  return label ? h('label', { class: 'field' }, h('span', { tip }, label), input) : input;
}
export const btn = (text, onclick, cls = '', tiptext) => h('button', { class: 'btn ' + cls, onclick, tiptext }, text);
export const check = (label, checked, onChange, tiptext) =>
  h('label', { class: 'check', tiptext }, h('input', { type: 'checkbox', checked, onchange: e => onChange(e.target.checked) }), label);

/** A titled panel. opts: { code, cls, tools: [nodes], lesson: [id, onOpen] } */
export function panel(title, opts = {}, ...body) {
  return h('section', { class: 'panel ' + (opts.cls || '') },
    h('header', null, h('h2', null, title), h('div', { class: 'tools' }, opts.tools || null,
      opts.lesson ? h('button', { class: 'btn ghost', onclick: opts.lesson[1], tiptext: 'Open the lesson that explains this panel' }, '? LEARN') : null,
      opts.code ? h('span', { class: 'code' }, opts.code) : null)),
    h('div', { class: 'panel-body' }, body));
}
/** Label over value. opts: { tip, tone: 'up' | 'down' | 'amber', sub } */
export const stat = (label, value, opts = {}) =>
  h('div', { class: 'stat' }, h('span', { class: 'k', tip: opts.tip, tiptext: opts.tiptext }, label), h('span', { class: 'v ' + (opts.tone || '') }, value), opts.sub ? h('span', { class: 'sub' }, opts.sub) : null);
export const tone = x => (x > 0 ? 'up' : x < 0 ? 'down' : '');
export const empty = (...text) => h('div', { class: 'empty' }, text);
/** Label-and-sentence list for the plain-English readings: items are { k, text, tone }. */
export const story = items => h('dl', { class: 'story' }, items.map(i => [h('dt', { class: i.tone === 'warn' ? 'warn' : '' }, i.k), h('dd', null, i.text)]));
export const note = (...text) => h('p', { class: 'note' }, text);

/**
 * Simple data table. columns: [{ label, tip, tiptext, cls, cell: row => node | string }].
 * opts: { onRow: row => void, rowClass: row => string }
 */
export function table(columns, rows, opts = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid ' + (opts.cls || '') },
    h('thead', null, h('tr', null, columns.map(c => h('th', { class: c.cls, tip: c.tip, tiptext: c.tiptext }, c.label)))),
    h('tbody', null, rows.map(row => h('tr', { class: (opts.rowClass?.(row) || '') + (opts.onRow ? ' click' : ''), onclick: opts.onRow ? () => opts.onRow(row) : null },
      columns.map(c => h('td', { class: c.cls }, c.cell(row))))))));
}

const KEY = 'optionsTerminal.';
/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(KEY + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(KEY + key, JSON.stringify(value)); } catch { /* storage unavailable: settings last for this visit only */ } },
};

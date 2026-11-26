// Option chain: expiry strip, the calls | strike | puts table, a heatmap, and the contract explainer.
import * as M from './model.js';
import * as F from './fmt.js';
import { h, append, mount, plot, chart, panel, stat, note, story, seg, select, slider, btn, flash, values, C } from './ui.js';
import { expiryPicker } from './expiries.js';
import { expiryStory, contractStory } from './explain.js';
import { drawPayoff } from './payoff.js';

// Cell formatters. mult is 1 for "per share" (prices as quoted) or 100 for "per contract".
// Per-share prices keep the feed's own precision; per-contract figures are dollars, shown whole from $1,000 up.
const money = (v, mult) => (v == null ? '—' : mult === 1 ? F.price(v) : F.num(v * mult, Math.abs(v * mult) >= 1000 ? 0 : 2));
const small = (v, mult) => (v == null ? '—' : mult === 1 ? F.greek(v, Math.abs(v) < 0.01 ? 4 : 3) : F.num(v * mult, 2));
// The table's columns. get(contract, mult) gives the cell text; dim, est and tone say how to style it.
const COLS = {
  bid: { label: 'Bid', tip: 'bid', get: (c, mult) => (c.bid > 0 ? money(c.bid, mult) : '—'), dim: c => !(c.bid > 0) },
  ask: { label: 'Ask', tip: 'ask', get: (c, mult) => (c.ask > 0 ? money(c.ask, mult) : '—'), dim: c => !(c.ask > 0) },
  last: { label: 'Last', tip: 'last', get: (c, mult) => money(c.last, mult), dim: () => true },
  chg: { label: 'Chg', tiptext: 'Change in the last traded price since the previous close.', get: (c, mult) => (c.chg ? (c.chg > 0 ? '+' : '') + money(c.chg, mult) : '—'), tone: c => (c.chg > 0 ? 'up' : c.chg < 0 ? 'down' : 'dim') },
  vol: { label: 'Vol', tip: 'volume', get: c => (c.vol ? F.int(c.vol) : '—'), bar: 'vol', dim: c => !c.vol },
  oi: { label: 'OI', tip: 'oi', get: c => (c.oi ? F.int(c.oi) : '—'), bar: 'oi', dim: c => !c.oi },
  iv: { label: 'IV', tip: 'iv', get: c => F.iv(c.sigma), est: c => c.sigmaSrc === 'smile' },
  // Per share: the delta itself (a tiny one keeps its digits rather than printing 0.00). Per contract: the shares it behaves like.
  delta: { label: 'Delta', tip: 'delta', get: (c, mult) => (c.delta == null ? '—' : mult === 1 ? F.greek(c.delta, 2) : F.num(c.delta * 100, Math.abs(c.delta) < 0.005 ? 1 : 0)) },
  gamma: { label: 'Gamma', tip: 'gamma', get: (c, mult) => small(c.gamma, mult) },
  theta: { label: 'Theta', tip: 'theta', get: (c, mult) => small(c.theta, mult) },
  vega: { label: 'Vega', tip: 'vega', get: (c, mult) => small(c.vega, mult) },
  prob: { label: 'ITM %', tip: 'probitm', get: c => F.pct(c.probITM, 0) },
  ext: { label: 'Time val', tip: 'extrinsic', get: (c, mult) => money(c.extrinsic, mult) },
  spr: { label: 'Sprd %', tip: 'spread', get: c => F.pct(c.spreadPct, 0), tone: c => (c.spreadPct > 0.15 ? 'down' : '') },
};
const PRESETS = {
  basic: ['oi', 'vol', 'iv', 'delta', 'bid', 'ask'],
  greeks: ['iv', 'delta', 'gamma', 'theta', 'vega', 'bid', 'ask'],
  all: ['oi', 'vol', 'last', 'chg', 'spr', 'ext', 'prob', 'iv', 'delta', 'gamma', 'theta', 'vega', 'bid', 'ask'],
};
// What the heatmap can colour by: [label, value of a contract, formatter].
const METRICS = { oi: ['Open interest', c => c.oi, F.compact], vol: ['Volume today', c => c.vol, F.compact], iv: ['Implied volatility', c => (c.sigma == null ? null : c.sigma * 100), v => F.num(v, 0) + '%'],
                  mark: ['Price (mid)', c => c.mark, F.price], spr: ['Spread % of price', c => (c.spreadPct == null ? null : c.spreadPct * 100), v => F.num(v, 0) + '%'] };
const HEAT_EXPIRIES = 24;      // the heatmap shows this many expiries at most: more would not be readable
// The toolbar's choices. The saved settings are checked against these lists (see ctx.prefs).
const MODES = [['table', 'Table'], ['heat', 'Heatmap']];
const WINDOWS = [[6, '±6'], [10, '±10'], [20, '±20'], [0, 'All']];
const COLUMN_SETS = [['basic', 'Basic'], ['greeks', 'Greeks'], ['all', 'Everything']];
const UNITS = [[1, 'Per share', 'Prices as quoted. One contract is 100 shares.'], [100, 'Per contract', 'Everything multiplied by 100: what one contract costs, and its Greeks in dollars and shares.']];

// Things this view remembers between redraws but never saves:
let cursor = null;      // id of the contract under the keyboard cursor
let revealed = null;    // id of the chosen contract the table was last slid sideways to show
let centred = null;     // which table (ticker, expiry, strike window) was last scrolled to the money
let whatIf = null;      // the what-if sliders of the open contract: { id, S, days, vol }

export function render(root, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote;
  if (!chain) return append(root, ctx.noChain());
  const p = ctx.prefs('chain', { window: 10, cols: 'basic', unit: 1, mode: 'table', metric: 'oi' },
    { window: values(WINDOWS), cols: values(COLUMN_SETS), unit: values(UNITS), mode: values(MODES), metric: Object.keys(METRICS) });
  const set = patch => { Object.assign(p, patch); ctx.savePrefs(); ctx.rerenderView(); };
  const exp = ctx.expiry() || chain.expiries[0], selected = ctx.contract();

  append(root,
    expiryPicker(chain.expiries, { on: e => e === exp, onPick: e => ctx.setExpiry(e.label) }),
    h('div', { class: 'toolbar' },
      seg(MODES, p.mode, mode => set({ mode }), 'View'),
      seg(WINDOWS, p.window, window => set({ window }), 'Strikes'),
      p.mode === 'table' ? seg(COLUMN_SETS, p.cols, cols => set({ cols }), 'Columns') : null,
      p.mode === 'table' ? seg(UNITS, p.unit, unit => set({ unit }), null, 'Units') : null,
      p.mode === 'heat' ? select(Object.entries(METRICS).map(([k, m]) => [k, m[0]]), p.metric, metric => set({ metric }), 'Colour by') : null));

  // The details of a chosen contract sit beside the table: in the side column on a wide window, as a
  // drawer next to the chain on a narrower one (the stylesheet decides), so the chain stays in view.
  const layout = h('div', { class: 'chain-layout' + (selected ? ' has-detail' : '') });
  append(root, layout);
  const side = h('div', { class: 'chain-side' });
  if (p.mode === 'heat') {
    const calls = chart('tall'), puts = chart('tall');
    append(layout, h('div', { class: 'chain-main' },
      panel(`Calls: ${METRICS[p.metric][0].toLowerCase()} by strike and expiry`, { cls: 'flush', code: 'HEAT' }, calls),
      panel(`Puts: ${METRICS[p.metric][0].toLowerCase()} by strike and expiry`, { cls: 'flush' }, puts),
      note('Brighter cells hold more. Hover a cell for the number, click it to open that contract in the table.',
        chain.expiries.length > HEAT_EXPIRIES ? ` Only the first ${HEAT_EXPIRIES} of ${chain.expiries.length} expiries fit here.` : '')), side);
    heatmap(calls, chain, false, p, ctx); heatmap(puts, chain, true, p, ctx);
  } else {
    append(layout, h('div', { class: 'chain-main' }, tablePanel(exp, chain, q, p, selected, ctx)), side);
  }
  if (selected) append(side, panel(contractStory(selected, chain, q).title, { cls: 'chain-detail', code: selected.symbol,
    tools: h('button', { class: 'btn ghost', key: 'close-detail', 'aria-label': 'Close the contract details', tiptext: 'Close (Esc)', onclick: () => ctx.select(null) }, '✕') }, contractDetail(selected, ctx)));
  append(side, panel(`${F.date(exp.date)} in plain English`, { cls: 'chain-story', lesson: ['chain', () => ctx.openLesson('chain')] }, story(expiryStory(exp, chain, q))));

  // Beside the details the table can be wider than its box: slide it once so the chosen contract shows.
  if (!selected) revealed = null;
  else if (revealed !== selected.id) {
    revealed = selected.id;
    requestAnimationFrame(() => {
      const wrap = document.querySelector('.chain-wrap'), cells = wrap?.querySelectorAll('td.sel');
      if (!cells?.length) return;
      const box = wrap.getBoundingClientRect(), a = cells[0].getBoundingClientRect(), b = cells[cells.length - 1].getBoundingClientRect();
      if (b.right > box.right) wrap.scrollLeft += b.right - box.right;
      else if (a.left < box.left) wrap.scrollLeft -= box.left - a.left;
    });
  }

  // Centre the table on the money when the expiry or strike window changes.
  const key = `${app.symbol}|${exp.label}|${p.window}|${p.mode}`;
  if (centred !== key) {
    centred = key;
    requestAnimationFrame(() => {
      const wrap = document.querySelector('.chain-wrap'), spot = wrap?.querySelector('tr.spot');
      if (spot) wrap.scrollTop = spot.offsetTop - wrap.clientHeight / 2;
    });
  }
}

function tablePanel(exp, chain, q, p, selected, ctx) {
  const sym = q.symbol.replace('^', ''), mult = p.unit;
  const cols = PRESETS[p.cols], rest = cols.filter(c => c !== 'bid' && c !== 'ask');
  const callCols = [...rest, 'bid', 'ask'], putCols = ['bid', 'ask', ...[...rest].reverse()];
  let strikes = exp.strikes;
  if (p.window) {
    const at = strikes.indexOf(exp.atmStrike);
    strikes = strikes.filter((s, i) => Math.abs(i - at) <= p.window || (selected && selected.exp === exp && selected.strike === s));
  }
  const rows = strikes.map(s => exp.rows.get(s));
  const max = key => Math.max(1, ...rows.flatMap(r => [r.call?.[key] || 0, r.put?.[key] || 0]));
  const maxes = { vol: max('vol'), oi: max('oi') };

  const cell = (c, key, side) => {
    const col = COLS[key];
    if (!c) return h('td', { class: side + ' dim' }, '');
    const cls = [side, c.itm ? 'itm' : '', c === selected ? 'sel' : '', col.dim?.(c) ? 'dim' : '', col.est?.(c) ? 'est' : '', col.tone?.(c) || ''].join(' ');
    const td = h('td', { class: cls }, col.bar && c[col.bar] ? h('i', { class: 'bar', style: { width: Math.max(c[col.bar] / maxes[col.bar] * 100, 2) + '%' } }) : null, h('span', null, col.get(c, mult)));
    td.dataset.id = c.id;
    return key === 'bid' || key === 'ask' ? flash(td, `${c.symbol}|${key}`, c[key]) : td;
  };
  const open = c => { cursor = c.id; ctx.select(c === selected ? null : c); };       // a second click closes the details
  const body = h('tbody', { onclick: ev => {
    const id = ev.target.closest('td[data-id]')?.dataset.id, c = id && chain.contracts.find(x => x.id === id);
    if (c) open(c);
  } });

  // Keyboard: the table is one tab stop. Arrows move a cursor between contracts (up and down through
  // strikes, left for the call, right for the put), Enter opens the one under it.
  const at = id => rows.flatMap(r => [r.call, r.put]).find(c => c && c.id === id);
  if (!at(cursor)) {
    const start = rows.find(r => r.strike === exp.atmStrike) || rows[0];
    cursor = (selected && at(selected.id) ? selected : start?.call || start?.put)?.id ?? null;
  }
  const paint = (scroll = false) => {
    body.querySelectorAll('td.cur').forEach(td => td.classList.remove('cur'));
    body.querySelector('#chain-cursor')?.removeAttribute('id');
    const c = at(cursor), cells = c ? body.querySelectorAll(`td[data-id="${CSS.escape(c.id)}"]`) : [];
    cells.forEach(td => td.classList.add('cur'));
    if (!cells.length) return;
    cells[0].id = 'chain-cursor';
    cells[0].setAttribute('aria-label', `${F.contractName(c)}, bid ${c.bid > 0 ? F.price(c.bid) : 'none'}, ask ${c.ask > 0 ? F.price(c.ask) : 'none'}`);
    if (scroll) cells[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const move = (by, toSide) => {
    const cur = at(cursor), side = toSide || (cur?.put ? 'put' : 'call'), step = by < 0 ? -1 : 1;
    let i = Math.max(rows.findIndex(r => r.strike === (cur ? cur.strike : exp.atmStrike)), 0);
    i = Math.min(Math.max(i + by, 0), rows.length - 1);
    while (!rows[i][side] && rows[i + step]) i += step;          // skip strikes that list only the other side
    const next = rows[i][side] || rows[i].call || rows[i].put;
    if (next) { cursor = next.id; paint(true); }
  };
  const onKey = ev => {
    const by = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -1e6, End: 1e6 }[ev.key];
    if (by) move(by);
    else if (ev.key === 'ArrowLeft') move(0, 'call');
    else if (ev.key === 'ArrowRight') move(0, 'put');
    else if ((ev.key === 'Enter' || ev.key === ' ') && at(cursor)) open(at(cursor));
    else return;
    ev.preventDefault();
  };
  // The row that marks the money sits at the price the options imply (exp.S). When that differs from
  // the quoted price by enough to matter (a strike lies between the two, or half a percent), say so.
  const apart = Math.abs(exp.basis - 1) > 0.005 || exp.strikes.some(s => (s - chain.spot) * (s - exp.S) < 0);
  let marked = false;
  const marker = () => h('tr', { class: 'spot' }, h('td', { colSpan: callCols.length + putCols.length + 1 },
    `▲ lower strikes     ${sym} ${F.price(chain.spot)}${apart ? `  ·  option quotes imply ${F.price(exp.S)}` : ''}     higher strikes ▼`));
  for (const r of rows) {
    if (!marked && r.strike > exp.S) { body.append(marker()); marked = true; }
    body.append(h('tr', null, callCols.map(key => cell(r.call, key, 'c')), h('td', { class: 'k' }, F.strike(r.strike)), putCols.map(key => cell(r.put, key, 'p'))));
  }
  if (!marked) body.append(marker());
  paint();        // the cursor is always marked; the stylesheet shows it only while the table has focus
  const head = key => h('th', { tip: COLS[key].tip, tiptext: COLS[key].tiptext }, COLS[key].label);
  const hidden = exp.strikes.length - rows.length;
  return panel(`${sym} ${F.dateLong(exp.date)} · ${F.days(exp.days)} to expiry`, { cls: 'flush', code: 'OC' },
    h('div', { class: 'chain-wrap', key: 'chain-table', tabIndex: 0, role: 'group', 'aria-activedescendant': 'chain-cursor', onkeydown: onKey,
               'aria-label': 'Option chain. Arrow keys move between contracts, Enter opens the one under the cursor.' }, h('table', { class: 'chain' },
      h('thead', null,
        h('tr', null, h('th', { class: 'side c', colSpan: callCols.length, tip: 'call' }, 'CALLS'), h('th', { class: 'side', tip: 'strike' }, 'STRIKE'), h('th', { class: 'side p', colSpan: putCols.length, tip: 'put' }, 'PUTS')),
        h('tr', null, callCols.map(head), h('th', null, ''), putCols.map(head))),
      body)),
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: 'var(--call-bg)', border: '1px solid var(--call)' } }), h('i', { style: { background: 'var(--put-bg)', border: '1px solid var(--put)' } }), 'shaded = in the money'),
      h('span', null, h('i', { style: { borderTop: '2px solid var(--amber)', height: '2px' } }), 'where the price is'),
      h('span', null, h('em', null, 'italic IV'), ' = read off the volatility curve, not this contract\'s own quote'),
      h('span', null, 'bars = volume and open interest'),
      h('span', null, 'keys: ← ↑ ↓ → move between contracts, Enter opens one'),
      h('span', null, mult === 100 ? 'figures are per contract (×100)' : 'prices are per share: ×100 for one contract'),
      hidden > 0 ? h('span', { class: 'amber' }, `${hidden} more strikes hidden: choose All`) : null));
}

function heatmap(el, chain, put, p, ctx) {
  const [label, value, fmt] = METRICS[p.metric];
  const all = [...new Set(chain.expiries.flatMap(e => e.strikes))].sort((a, b) => a - b);
  let strikes = all;
  if (p.window) {
    const at = all.reduce((best, s, i) => (Math.abs(s - chain.spot) < Math.abs(all[best] - chain.spot) ? i : best), 0);
    strikes = all.filter((s, i) => Math.abs(i - at) <= p.window * 2);
  }
  const exps = chain.expiries.slice(0, HEAT_EXPIRIES);
  const pick = (e, s) => e.rows.get(s)?.[put ? 'put' : 'call'];
  const z = strikes.map(s => exps.map(e => { const c = pick(e, s), v = c ? value(c) : null; return v > 0 ? v : null; }));
  const text = z.map(row => row.map(v => (v == null ? '' : fmt(v))));
  const log = p.metric === 'oi' || p.metric === 'vol';
  const x = exps.map(F.expiryName);
  plot(el, [{ type: 'heatmap', x, y: strikes.map(s => F.strike(s)), z: log ? z.map(r => r.map(v => (v == null ? null : Math.log10(1 + v)))) : z, text, customdata: text,
    texttemplate: strikes.length <= 26 && exps.length <= 14 ? '%{text}' : '', textfont: { size: 10 }, xgap: 2, ygap: 2, colorscale: C.seq, hoverongaps: false,
    colorbar: { thickness: 10, outlinewidth: 0, tickfont: { size: 10, color: C.muted }, ...(log ? { tickvals: [0, 1, 2, 3, 4, 5], ticktext: ['0', '10', '100', '1k', '10k', '100k'] } : {}) },
    hovertemplate: `<b>%{y} ${put ? 'put' : 'call'}, %{x}</b><br>${label}: %{customdata}<extra></extra>` }],
    { margin: { l: 56, r: 10, t: 34, b: 10 }, xaxis: { type: 'category', side: 'top', showgrid: false }, yaxis: { type: 'category', showgrid: false, title: { text: 'Strike' } } });
  el.on?.('plotly_click', ev => {
    const pt = ev.points[0], c = pick(exps[pt.pointIndex[1]], strikes[pt.pointIndex[0]]);
    if (c) { p.mode = 'table'; ctx.savePrefs(); ctx.select(c); }
  });
}

/** Everything about one contract: quote, plain-English reading, Greeks in dollars, payoff and what-if. */
function contractDetail(c, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote, e = c.exp;
  const s = contractStory(c, chain, q), color = c.put ? 'var(--put)' : 'var(--call)';
  const buyAt = c.ask > 0 ? c.ask : c.mark ?? c.theo ?? 0;
  const leg = M.legFromContract(c, 1, 1, buyAt);
  const now = Date.now() / 1000;
  const a = M.analysePosition([leg], { S: chain.spot, r: chain.rate, now, vol: c.sigma ?? e.atmIV });
  const payoff = chart('short'), say = h('p', { class: 'say' });
  // The sliders keep their place when the minute's refresh redraws this panel for the same contract.
  const state = whatIf?.id === c.id ? whatIf : (whatIf = { id: c.id, S: chain.spot, days: 0, vol: 0 });
  let pointIndex = -1;
  const update = () => {
    const t = now + state.days * 86400;
    const value = M.legValue(leg, state.S, t, chain.rate, state.vol), pl = (value - buyAt) * 100;
    mount(say, 'If ', h('b', null, `${q.symbol.replace('^', '')} is at ${F.usd(state.S)}`), state.days ? ` in ${Math.round(state.days)} days` : ' right now',
      state.vol ? ` and implied volatility ${state.vol > 0 ? 'rises' : 'falls'} ${F.num(Math.abs(state.vol) * 100, 0)} points` : '',
      `, this option is worth about ${F.usd(value)} a share: `, h('b', { class: pl >= 0 ? 'up' : 'down' }, `${F.pnl(pl)} per contract`),
      buyAt > 0 ? ` (${F.signedPct(value / buyAt - 1, 0)}) on a ${F.money(buyAt * 100)} purchase.` : '.');
    if (pointIndex >= 0 && window.Plotly && payoff.data) window.Plotly.restyle(payoff, { x: [[state.S]], y: [[pl]] }, [pointIndex]);
  };
  const lo = a.grid[0], hi = a.grid[a.grid.length - 1], maxDays = Math.max(Math.floor(e.days), 0);
  state.S = Math.min(Math.max(state.S, lo), hi); state.days = Math.min(state.days, maxDays);
  const ownIV = c.sigmaSrc === 'own' && c.ivBid != null && c.ivAsk != null;
  const timeValue = c.extrinsic == null || Math.abs(c.extrinsic) < 0.005 ? 0 : c.extrinsic;      // negative when priced below intrinsic value
  const box = h('div', null,
    h('div', { class: 'stats' },
      stat('Bid', c.bid > 0 ? F.price(c.bid) : '—', { tip: 'bid' }), stat('Ask', c.ask > 0 ? F.price(c.ask) : '—', { tip: 'ask' }),
      stat('Mid', F.price(c.mid), { tip: 'mid' }), stat('Last', F.price(c.last), { tip: 'last' }),
      stat('Spread', c.spread != null ? `${F.price(c.spread)} (${F.pct(c.spreadPct, 0)})` : '—', { tip: 'spread', tone: c.spreadPct > 0.15 ? 'down' : '' }),
      stat('Volume / OI', `${F.int(c.vol)} / ${F.int(c.oi)}`, { tip: 'oi' }),
      stat('Implied vol', F.iv(c.sigma), { tip: 'iv', tone: 'amber', sub: ownIV ? `bid ${F.iv(c.ivBid)} · ask ${F.iv(c.ivAsk)}` : c.sigmaSrc === 'smile' ? 'read off the curve' : null }),
      stat('Model value', F.price(c.theo), { tiptext: 'What the pricing model says the option is worth at this volatility.' })),
    h('div', { class: 'row', style: { margin: '8px 0' } },
      btn('BUY → STRATEGY', () => { ctx.addLeg(c, 1); ctx.go('strategy'); }, 'buy', 'Add one bought contract to the strategy builder'),
      btn('SELL → STRATEGY', () => { ctx.addLeg(c, -1); ctx.go('strategy'); }, 'sell', 'Add one sold contract to the strategy builder'),
      btn('CALCULATOR', () => { ctx.prefs('calc', {}); Object.assign(app.ui.calc, { symbol: app.symbol, usedChain: true, market: null, put: c.put, S: e.S, K: c.strike, days: Math.max(+(e.T * 365).toFixed(2), 0.01), vol: Math.round((c.sigma ?? e.atmIV ?? 0.5) * 1000) / 10, q: e.q * 100 }); ctx.savePrefs(); ctx.go('calc'); }, '', 'Open this contract in the pricing calculator')),
    h('div', { class: 'prose' }, s.paragraphs.map(t => h('p', null, t))),
    s.warnings.length ? h('ul', { class: 'warnlist' }, s.warnings.map(w => h('li', null, w))) : null,
    c.mark != null ? [
      h('div', { class: 'split', tiptext: 'Left: intrinsic value. Right: time value.' },
        h('div', { style: { width: (c.mark ? c.intrinsic / Math.max(c.mark, c.intrinsic) * 100 : 0) + '%', background: color } }),
        h('div', { style: { flex: 1, background: `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 6px)`, opacity: 0.8 } })),
      h('p', { class: 'note small' }, `Price ${F.usd(c.mark)} = intrinsic ${F.usd(c.intrinsic)} ${timeValue < 0 ? '−' : '+'} time value ${F.usd(Math.abs(timeValue))}`)] : null,
    s.greeks.length ? [h('h2', { class: 'sub' }, 'The Greeks, in dollars per contract'),
      h('div', { class: 'greeks' }, s.greeks.map(g => [h('span', { class: 'g', tip: g.key }, g.key), h('span', { class: 'n' }, g.value), h('span', { class: 't' }, g.text)])),
      h('p', { class: 'note small' }, h('a', { href: '#', onclick: ev => { ev.preventDefault(); ctx.openLesson('delta'); } }, 'Learn what each Greek means →'))] : null,
    h('h2', { class: 'sub' }, `Buying one contract at ${F.usd(buyAt)}`),
    payoff,
    h('h2', { class: 'sub' }, 'What if…'),
    slider({ label: 'Stock price', min: lo, max: hi, step: (hi - lo) / 400, value: state.S, format: F.usd, onInput: v => { state.S = v; update(); } }),
    slider({ label: 'Days from now', min: 0, max: maxDays, step: 1, value: state.days, format: v => `${v}d`, onInput: v => { state.days = v; update(); }, tip: 'theta' }),
    slider({ label: 'Implied volatility', min: -0.5, max: 0.5, step: 0.01, value: state.vol, format: v => `${v >= 0 ? '+' : ''}${F.num(v * 100, 0)} pts`, onInput: v => { state.vol = v; update(); }, tip: 'vega' }),
    say);
  requestAnimationFrame(() => {
    if (!payoff.isConnected) return;
    pointIndex = drawPayoff(payoff, a, { spot: chain.spot, point: { x: state.S, y: (M.legValue(leg, state.S, now, chain.rate) - buyAt) * 100 } }).point;
    update();
  });
  return box;
}

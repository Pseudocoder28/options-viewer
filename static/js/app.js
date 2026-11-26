// App core: state, data loading, routing, command line, watchlist, keyboard and the page chrome.
// Each view is a function render(root, ctx) in a views-*.js module.
import * as M from './model.js';
import * as Q from './quant.js';
import * as F from './fmt.js';
import { h, mount, append, initTips, openModal, closeModal, modalOpen, purgePlots, store as disk, btn, tone, check } from './ui.js';
import { TERMS } from './glossary.js';
import { anchorExpiry } from './explain.js';
import * as market from './views-market.js';
import * as chainView from './views-chain.js';
import * as volView from './views-vol.js';
import * as stratView from './views-strategy.js';
import * as learn from './learn.js';

const VIEWS = [
  { id: 'overview', label: 'OVERVIEW', render: market.overview },
  { id: 'price', label: 'PRICE', render: market.price },
  { id: 'chain', label: 'CHAIN', render: chainView.render },
  { id: 'vol', label: 'VOLATILITY', render: volView.vol },
  { id: 'oi', label: 'OPEN INTEREST', render: volView.oi },
  { id: 'strategy', label: 'STRATEGY', render: stratView.strategy },
  { id: 'calc', label: 'CALCULATOR', render: stratView.calc },
  { id: 'learn', label: 'LEARN', render: learn.render },
];
// Words that switch view. Short codes only count after a ticker ("SPY OC"), so that real tickers
// such as PL or OC still load when typed on their own.
const WORDS = { OVERVIEW: 'overview', PRICE: 'price', CHAIN: 'chain', VOLATILITY: 'vol', STRATEGY: 'strategy', CALCULATOR: 'calc', LEARN: 'learn' };
const CODES = { ...WORDS, OV: 'overview', DES: 'overview', GP: 'price', CHART: 'price', OC: 'chain', OMON: 'chain', VOL: 'vol', SKEW: 'vol', SURF: 'vol',
                OI: 'oi', FLOW: 'oi', GEX: 'oi', STRAT: 'strategy', PL: 'strategy', CALC: 'calc', EDU: 'learn' };
const DEFAULT_WATCH = ['SPY', 'QQQ', 'IWM', '^SPX', '^VIX', 'AAPL', 'NVDA', 'TSLA'];
const $ = id => document.getElementById(id);

export const app = {
  symbol: null, quote: null, chain: null, chainError: null, hv: null, hist: {}, loading: false, error: null, loadedAt: 0,
  view: 'overview', expiry: null, selected: null,
  ui: disk.get('ui', {}), watch: disk.get('watch', DEFAULT_WATCH), watchQuotes: {},
  legs: disk.get('legs', {}), saved: disk.get('saved', []), lesson: disk.get('lesson', 'basics'), done: disk.get('done', {}),
  autoRefresh: disk.get('auto', true), message: null,
};
let loadToken = 0;

async function api(path) {
  let res;
  try { res = await fetch(path); } catch { throw new Error('Cannot reach the local data server. Is "uv run server.py" still running?'); }
  const body = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
  if (!res.ok || body.error) throw new Error(body.error || res.statusText);
  return body;
}

const ctx = {
  app, api,
  /** Per-view preferences that survive re-renders and reloads. */
  prefs(view, defaults) { app.ui[view] = { ...defaults, ...app.ui[view] }; return app.ui[view]; },
  savePrefs() { disk.set('ui', app.ui); },
  go(view) { if (app.view !== view) { app.view = view; setHash(); } render(); scrollTo(0, 0); },
  load: symbol => { location.hash = `#/${encodeURIComponent(symbol.toUpperCase())}/${app.view}`; },
  render: () => render(),
  rerenderView: () => renderView(),
  expiry: () => app.chain?.expiries.find(e => e.label === app.expiry) || null,
  setExpiry(label) { app.expiry = label; app.selected = null; render(); },
  contract: () => app.chain?.contracts.find(c => c.id === app.selected) || null,
  select(c) { app.selected = c ? c.id : null; if (c) app.expiry = c.exp.label; renderView(); },
  legs: () => app.legs[app.symbol] || [],
  setLegs(legs) { app.legs[app.symbol] = legs; disk.set('legs', app.legs); },
  addLeg(c, side, qty = 1) { ctx.setLegs([...ctx.legs(), M.legFromContract(c, side, qty)]); ctx.status(`Added to strategy: ${side > 0 ? 'buy' : 'sell'} ${qty} × ${F.contractName(c)}`); },
  saved: () => app.saved,
  setSaved(list) { app.saved = list; disk.set('saved', list); },
  openSaved(s) {
    app.legs[s.symbol] = s.legs.map(l => ({ ...l })); disk.set('legs', app.legs); app.view = 'strategy';
    if (s.symbol === app.symbol) { setHash(); render(); } else ctx.load(s.symbol);
  },
  openLesson(id) { app.lesson = id; disk.set('lesson', id); ctx.go('learn'); },
  markDone(id) { app.done[id] = true; disk.set('done', app.done); },
  setLesson(id) { app.lesson = id; disk.set('lesson', id); renderView(); scrollTo(0, 0); },
  status(text, isError = false) { app.message = { text, isError, at: Date.now() }; renderStatus(); },
  async history(range) {
    const key = `${app.symbol}|${range}`, hit = app.hist[key];
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await api(`/api/history?symbol=${encodeURIComponent(app.symbol)}&range=${range}`);
    app.hist[key] = { at: Date.now(), data };
    return data;
  },
  year: () => app.hist[`${app.symbol}|1Y`]?.data || null,
};

// ---------------------------------------------------------------- loading

async function load(symbol, { quiet = false } = {}) {
  symbol = symbol.toUpperCase();
  const token = ++loadToken;
  if (!quiet) { app.loading = true; ctx.status(`Loading ${symbol}…`); renderChrome(); }
  try {
    const quote = await api('/api/quote?symbol=' + encodeURIComponent(symbol));
    if (token !== loadToken) return;
    const changed = app.symbol !== symbol;
    if (changed) app.hist = {};
    const [raw, year] = await Promise.all([
      api('/api/chain?symbol=' + encodeURIComponent(symbol)).catch(e => ({ error: e.message })),
      api(`/api/history?symbol=${encodeURIComponent(symbol)}&range=1Y`).catch(() => null),
    ]);
    if (token !== loadToken) return;
    app.symbol = symbol; app.quote = quote; app.error = null; app.loadedAt = Date.now();
    app.chainError = raw.error || null;
    app.chain = raw.error || !raw.rows.length ? null : M.buildChain(raw, quote);
    if (app.chain && !app.chain.expiries.length) app.chain = null;
    if (year) app.hist[`${symbol}|1Y`] = { at: Date.now(), data: year };
    app.hv = year ? { d10: Q.realizedVol(year.c, 10), d20: Q.realizedVol(year.c, 20), d60: Q.realizedVol(year.c, 60),
                      d250: Q.realizedVol(year.c, Math.min(250, year.c.length - 1)) } : null;
    if (changed) { app.selected = null; app.expiry = null; }
    if (app.chain && !ctx.expiry()) app.expiry = (app.chain.expiries.find(e => e.days >= 2) || app.chain.expiries[0]).label;
    disk.set('last', symbol);
    if (!quiet) ctx.status(`${symbol} loaded`);
  } catch (e) {
    if (token !== loadToken) return;
    if (!quiet || !app.quote) app.error = e.message;
    if (app.symbol) setHash();          // keep the address on the ticker that is still showing
    ctx.status(e.message, true);
  } finally {
    if (token === loadToken) { app.loading = false; render(); }
  }
}

async function refreshWatch() {
  if (!app.watch.length) return;
  try {
    const { quotes } = await api('/api/quotes?symbols=' + app.watch.map(encodeURIComponent).join(','));
    for (const q of quotes) app.watchQuotes[q.symbol] = q;
    renderWatch();
  } catch { /* the strip keeps its last values */ }
}

// ---------------------------------------------------------------- routing

function parseHash() {
  const [, sym, view] = location.hash.split('/');
  return { symbol: sym ? decodeURIComponent(sym).toUpperCase() : null, view: VIEWS.some(v => v.id === view) ? view : null };
}
function setHash() {
  const next = `#/${encodeURIComponent(app.symbol || '')}/${app.view}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}
function onHash() {
  const { symbol, view } = parseHash();
  if (view) app.view = view;
  if (symbol && symbol !== app.symbol) load(symbol);
  else render();
}

// ---------------------------------------------------------------- chrome

function renderTabs() {
  mount($('tabs'), VIEWS.map((v, i) => h('button', { class: v.id === app.view ? 'on' : '', onclick: () => ctx.go(v.id) }, h('span', { class: 'key' }, i + 1), v.label)));
}

function renderQuote() {
  const q = app.quote, el = $('quote');
  if (!q) return mount(el, app.loading ? h('span', { class: 'muted' }, h('span', { class: 'spin' }), ' Loading…') : h('span', { class: 'muted' }, 'No security loaded.'));
  const c = app.chain, e = c && anchorExpiry(c);
  const state = { REGULAR: ['OPEN', 'open'], PRE: ['PRE-MARKET', 'warn'], POST: ['AFTER HOURS', 'warn'], POSTPOST: ['CLOSED', 'closed'], PREPRE: ['CLOSED', 'closed'], CLOSED: ['CLOSED', 'closed'] }[q.marketState] || [q.marketState || '', 'closed'];
  const block = (label, value, tip) => h('div', { class: 'q' }, h('span', { tip }, label), h('span', null, value));
  const watched = app.watch.includes(q.symbol);
  mount(el,
    h('span', { class: 'sym' }, q.symbol),
    h('span', { class: 'name' }, q.name, h('span', { class: 'muted' }, `  ${q.exchange} · ${q.type}`)),
    h('span', { class: 'px' }, F.price(q.price)),
    h('span', { class: tone(q.change) }, `${F.signed(q.change, q.price < 10 ? 3 : 2)} (${F.signedPct(q.changePct / 100)})`),
    q.extPrice && state[1] === 'warn' ? h('span', { class: 'muted' }, `${state[0].toLowerCase()} ${F.price(q.extPrice)} `, h('span', { class: tone(q.extChangePct) }, F.signedPct(q.extChangePct / 100))) : null,
    state[0] ? h('span', { class: 'badge ' + state[1] }, state[0]) : null,
    block('Day range', `${F.price(q.dayLow)} – ${F.price(q.dayHigh)}`),
    block('52-week', `${F.price(q.yearLow)} – ${F.price(q.yearHigh)}`),
    block('Volume', `${F.compact(q.volume)}${q.avgVolume ? ` (${F.num(q.volume / q.avgVolume, 1)}× avg)` : ''}`),
    q.marketCap ? block('Mkt cap', '$' + F.compact(q.marketCap)) : null,
    c ? block('IV 30d', F.iv(c.iv30), 'iv') : null,
    app.hv?.d20 != null ? block('Realized 20d', F.iv(app.hv.d20), 'hv') : null,
    e ? block(`Exp. move ${F.date(e.date)}`, `±${F.usd(e.em)} (${F.pct(e.em / e.F)})`, 'em') : null,
    h('button', { class: 'star', tiptext: watched ? 'Remove from the watch strip' : 'Add to the watch strip', onclick: () => {
      app.watch = watched ? app.watch.filter(s => s !== q.symbol) : [...app.watch, q.symbol];
      disk.set('watch', app.watch); renderQuote(); renderWatch(); refreshWatch();
    } }, watched ? '★ WATCHING' : '☆ WATCH'));
}

function renderWatch() {
  mount($('watch'), h('span', { class: 'label' }, 'WATCH'), app.watch.map(sym => {
    const q = app.watchQuotes[sym];
    return h('button', { class: 'w' + (sym === app.symbol ? ' on' : ''), onclick: () => ctx.load(sym) },
      h('b', null, sym.replace('^', '')), h('span', null, q?.price != null ? F.price(q.price) : '…'),
      q?.changePct != null ? h('span', { class: tone(q.changePct) }, F.signedPct(q.changePct / 100, 1)) : null,
      h('span', { class: 'x', tiptext: 'Remove', onclick: ev => { ev.stopPropagation(); app.watch = app.watch.filter(s => s !== sym); disk.set('watch', app.watch); renderWatch(); renderQuote(); } }, '✕'));
  }));
}

function renderStatus() {
  const c = app.chain, m = app.message, fresh = m && Date.now() - m.at < 8000;
  mount($('status'),
    app.loading ? h('span', null, h('span', { class: 'spin' }), ' loading') : null,
    c ? h('span', null, `Chain: ${c.source}`, c.stale ? ' (cached, source unreachable)' : '') : null,
    h('span', null, 'Quotes: Yahoo'),
    h('span', { tiptext: 'Free data feeds are delayed by about 15 minutes. Do not use these prices to time an order.' }, '≈15 min delayed'),
    app.loadedAt ? h('span', null, 'Updated ' + F.time(app.loadedAt / 1000) + ' NY') : null,
    c?.mode === 'last' ? h('span', { class: 'badge warn', tiptext: 'Live quotes are blank (market closed), so prices are last trades.' }, 'LAST-TRADE PRICES') : null,
    fresh ? h('span', { class: m.isError ? 'err' : 'msg' }, m.text) : null,
    h('span', { class: 'sp' }),
    check('auto-refresh 60s', app.autoRefresh, v => { app.autoRefresh = v; disk.set('auto', v); }),
    h('span', null, h('kbd', null, '/'), ' command  ', h('kbd', null, '1'), '–', h('kbd', null, '8'), ' views  ', h('kbd', null, '['), h('kbd', null, ']'), ' expiry  ', h('kbd', null, '?'), ' help'));
}

function renderTop() {
  mount($('topbtns'),
    h('span', { class: 'clock', id: 'clock' }),
    btn('GLOSSARY', showGlossary, '', 'Every term in plain English'),
    btn('HELP', showHelp, '', 'Commands and shortcuts'));
  tick();
}
function tick() {
  const el = $('clock');
  if (el) el.textContent = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' NY';
}

function renderView() {
  const root = $('view'), keep = document.querySelector('.chain-wrap')?.scrollTop;
  mount(root);
  if (app.error && !app.quote) append(root, h('div', { class: 'banner err' }, app.error), h('div', { class: 'empty' }, 'Type a ticker in the command line above, for example SPY or AAPL.'));
  else if (!app.quote) append(root, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading market data…'));
  else {
    if (app.error) append(root, h('div', { class: 'banner err' }, app.error));
    try { VIEWS.find(v => v.id === app.view).render(root, ctx); } catch (e) {
      console.error(e);
      append(root, h('div', { class: 'banner err' }, `This view hit an error: ${e.message}. The other views still work.`));
    }
  }
  purgePlots();
  const wrap = document.querySelector('.chain-wrap');
  if (wrap && keep) wrap.scrollTop = keep;
}
function renderChrome() { renderTabs(); renderQuote(); renderWatch(); renderStatus(); }
function render() { document.title = app.symbol ? `${app.symbol.replace('^', '')} ${F.price(app.quote?.price)} · Options Terminal` : 'Options Terminal'; renderChrome(); renderView(); }

// ---------------------------------------------------------------- command line

function initCommand() {
  const input = $('cmd'), box = $('suggest');
  let items = [], active = -1, timer = null, seq = 0;
  const close = () => { box.hidden = true; items = []; active = -1; };
  const draw = () => {
    box.hidden = !items.length;
    mount(box, items.map((it, i) => h('div', { class: i === active ? 'on' : '', onmousedown: ev => { ev.preventDefault(); run(it); } },
      h('b', null, it.symbol || it.word), h('span', null, it.name), h('i', null, it.kind))));
  };
  const run = it => {
    input.value = ''; close(); input.blur();
    if (it.view && !it.symbol) return ctx.go(it.view);
    if (it.action) return it.action();
    if (it.view) app.view = it.view;
    ctx.load(it.symbol);
  };
  const parse = text => {
    const [a, b] = text.trim().toUpperCase().split(/\s+/);
    if (!a) return null;
    if (a === 'HELP') return { action: showHelp };
    if (a === 'GLOSSARY') return { action: showGlossary };
    if (a === 'REFRESH') return { action: () => load(app.symbol) };
    if (WORDS[a] && !b) return { view: WORDS[a] };
    return { symbol: a, view: b ? CODES[b] : null };
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (!text) return close();
    timer = setTimeout(async () => {
      const mine = ++seq, first = text.split(/\s+/)[0];
      const words = Object.entries(WORDS).filter(([w]) => w.startsWith(text.toUpperCase())).map(([w, view]) => ({ word: w, name: 'Switch to this view', kind: 'VIEW', view }));
      let found = [];
      try { found = (await api('/api/search?q=' + encodeURIComponent(first))).results; } catch { /* suggestions are optional */ }
      if (mine !== seq) return;
      items = [...words, ...found.map(r => ({ symbol: r.symbol, name: r.name, kind: `${r.type} · ${r.exchange}` }))];
      active = -1; draw();
    }, 170);
  });
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (items.length) { active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; draw(); } }
    else if (ev.key === 'Enter') { const it = active >= 0 ? items[active] : parse(input.value); if (it) run(it); }
    else if (ev.key === 'Escape') { input.value = ''; close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

function initKeys() {
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && modalOpen()) return closeModal();
    if (ev.metaKey || ev.ctrlKey || ev.altKey || modalOpen() || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    const n = Number(ev.key);
    if (n >= 1 && n <= VIEWS.length) ctx.go(VIEWS[n - 1].id);
    else if (ev.key === '/') { ev.preventDefault(); $('cmd').focus(); }
    else if (ev.key === '?') showHelp();
    else if (ev.key === 'g') showGlossary();
    else if (ev.key === 'r' && app.symbol) load(app.symbol);
    else if ((ev.key === '[' || ev.key === ']') && app.chain) {
      const list = app.chain.expiries, i = list.findIndex(e => e.label === app.expiry);
      const next = list[Math.min(Math.max(i + (ev.key === ']' ? 1 : -1), 0), list.length - 1)];
      if (next && next.label !== app.expiry) ctx.setExpiry(next.label);
    } else if (ev.key === 'Escape' && app.selected) ctx.select(null);
  });
}

function showHelp() {
  const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
  openModal('Help', h('div', null,
    h('dl', { class: 'help' },
      row('AAPL ⏎', 'Type any ticker or company name in the command line and press Enter. Stocks, ETFs and indexes all work: SPY, QQQ, ^SPX, ^VIX, ^NDX.'),
      row('SPY CHAIN ⏎', 'Add a view after the ticker to land on it: OVERVIEW (OV), PRICE (GP), CHAIN (OC), VOLATILITY (VOL), OI, STRATEGY (STRAT), CALCULATOR (CALC), LEARN.'),
      row('/', 'Jump to the command line.'),
      row('1 … 8', 'Switch view.'),
      row('[  ]', 'Previous and next expiry.'),
      row('r', 'Reload the current ticker.'),
      row('g  ?', 'Glossary and this help.'),
      row('Esc', 'Close a dialog or deselect a contract.')),
    h('p', { class: 'note' }, 'Hover any dotted-underlined word or column heading for a plain-English definition. Panels with a ? LEARN button open the lesson behind them.'),
    h('p', { class: 'note' }, 'Data: option chains from Nasdaq\'s public feed for stocks and ETFs, Yahoo Finance for indexes; prices, history and search from Yahoo Finance. Everything is delayed about 15 minutes and comes without any guarantee. Volatility and Greeks are computed here from bid and ask prices.'),
    h('p', { class: 'note small' }, 'This is a learning and analysis tool. Nothing in it is investment advice, and it cannot place orders.')));
}

function showGlossary() {
  const list = h('dl', { class: 'gloss' });
  const fill = text => mount(list, Object.entries(TERMS).filter(([, t]) => (t.term + t.short + t.long).toLowerCase().includes(text.toLowerCase()))
    .sort((a, b) => a[1].term.localeCompare(b[1].term))
    .map(([, t]) => [h('dt', null, t.term), h('dd', null, t.long, ' ', t.lesson ? h('a', { href: '#', onclick: ev => { ev.preventDefault(); closeModal(); ctx.openLesson(t.lesson); } }, 'Open the lesson →') : null)]));
  const search = h('input', { type: 'text', placeholder: 'Search the glossary…', style: { width: '100%' }, oninput: ev => fill(ev.target.value) });
  fill('');
  openModal('Glossary', h('div', null, search, list), { wide: true });
  search.focus();
}

// ---------------------------------------------------------------- start

function start() {
  initTips(); initCommand(); initKeys(); renderTop(); renderChrome();
  $('brand').addEventListener('click', () => ctx.go('overview'));
  addEventListener('hashchange', onHash);
  const { symbol, view } = parseHash();
  if (view) app.view = view;
  const first = symbol || disk.get('last', 'SPY');
  if (!symbol) history.replaceState(null, '', `#/${encodeURIComponent(first)}/${app.view}`);
  load(first);
  refreshWatch();
  setInterval(tick, 1000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshWatch(); }, 60000);
  setInterval(() => {
    // Views driven by sliders are left alone so a refresh never yanks a control mid-drag.
    if (app.autoRefresh && document.visibilityState === 'visible' && app.symbol && !app.loading && !modalOpen() && !['learn', 'calc', 'strategy'].includes(app.view)) load(app.symbol, { quiet: true });
  }, 60000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

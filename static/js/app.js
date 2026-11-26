// App core: state, data loading, routing, command line, watchlist, keyboard and the page chrome.
// Each view is a function render(root, ctx) in a views-*.js module.
import * as M from './model.js';
import * as Q from './quant.js';
import * as F from './fmt.js';
import { h, mount, append, initTips, openModal, closeModal, modalOpen, purgePlots, store as disk, btn, seg, tone, check, empty, skeleton, keepFocus, flash } from './ui.js';
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
const FRESH_MS = 55000;      // a ticker loaded more recently than this is shown without asking the server again
const KEEP_TICKERS = 6;      // how many recent tickers stay in memory, ready to show at once
const $ = id => document.getElementById(id);

export const app = {
  symbol: null, quote: null, chain: null, chainError: null, hv: null, hist: {}, loadedAt: 0,
  error: null, failed: null,   // the message of a load that failed, and the ticker it was for (RETRY loads it again)
  loading: false,        // a request is in flight (drives the progress bar)
  pending: null,         // ticker that was asked for but has no data yet (drives the placeholders)
  chainLoading: false,   // the price is in, the option chain is still on its way
  want: null,            // { exp, c, legs } from the address bar, applied once the chain is there
  view: 'overview', expiry: null, selected: null,
  ui: disk.get('ui', {}), watch: disk.get('watch', DEFAULT_WATCH), watchQuotes: {},
  legs: disk.get('legs', {}), saved: disk.get('saved', []), lesson: disk.get('lesson', 'basics'), done: disk.get('done', {}),
  autoRefresh: disk.get('auto', true), message: null,
  text: disk.get('text', 1),   // text size multiplier (the A A A control)
};
const recent = new Map();     // ticker -> { quote, chain, chainError, hv, loadedAt, expiry }
let loadToken = 0, rerenderTimer = 0;

async function api(path) {
  let res;
  try { res = await fetch(path); } catch { throw new Error('Cannot reach the local data server. Open the Options Terminal app again (or run "uv run server.py") to restart it.'); }
  const body = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
  if (!res.ok || body.error) throw new Error(body.error || res.statusText);
  return body;
}

const ctx = {
  app, api,
  /** Per-view preferences that survive re-renders and reloads. */
  prefs(view, defaults) { app.ui[view] = { ...defaults, ...app.ui[view] }; return app.ui[view]; },
  savePrefs() { disk.set('ui', app.ui); },
  /** Switch view. Each switch is a step the Back button can undo. */
  go(view) { if (app.view !== view) { app.view = view; syncUrl(true); } render(); scrollTo(0, 0); },
  load: (symbol, view) => navigate(symbol, view),
  render: () => render(),
  /** Redraw the view on the next tick, so a Tab or click that caused the change lands first and focus is kept. */
  rerenderView() { clearTimeout(rerenderTimer); rerenderTimer = setTimeout(renderView, 0); },
  expiry: () => app.chain?.expiries.find(e => e.label === app.expiry) || null,
  setExpiry(label) { app.expiry = label; app.selected = null; syncUrl(); render(); },
  contract: () => app.chain?.contracts.find(c => c.id === app.selected) || null,
  select(c) { app.selected = c ? c.id : null; if (c) app.expiry = c.exp.label; syncUrl(); renderView(); },
  legs: () => app.legs[app.symbol] || [],
  setLegs(legs) { app.legs[app.symbol] = legs; disk.set('legs', app.legs); syncUrl(); },
  addLeg(c, side, qty = 1) { ctx.setLegs([...ctx.legs(), M.legFromContract(c, side, qty)]); ctx.status(`Added to strategy: ${side > 0 ? 'buy' : 'sell'} ${qty} × ${F.contractName(c)}`); },
  saved: () => app.saved,
  setSaved(list) { app.saved = list; disk.set('saved', list); },
  openSaved(s) {
    app.legs[s.symbol] = s.legs.map(l => ({ ...l })); disk.set('legs', app.legs);
    navigate(s.symbol, 'strategy');
  },
  openLesson(id) { app.lesson = id; disk.set('lesson', id); if (app.view === 'learn') ctx.setLesson(id); else ctx.go('learn'); },
  markDone(id) { app.done[id] = true; disk.set('done', app.done); },
  setLesson(id) { app.lesson = id; disk.set('lesson', id); syncUrl(true); renderView(); scrollTo(0, 0); },
  status(text, isError = false) { app.message = { text, isError, at: Date.now() }; renderStatus(); },
  async history(range) {
    const key = `${app.symbol}|${range}`, hit = app.hist[key];
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const data = await api(`/api/history?symbol=${encodeURIComponent(app.symbol)}&range=${range}`);
    app.hist[key] = { at: Date.now(), data };
    return data;
  },
  year: () => app.hist[`${app.symbol}|1Y`]?.data || null,
  /** What a view that needs the chain shows without one: a placeholder while it loads, the reason when there is none. */
  noChain: () => (app.chainLoading ? skeleton('Loading the option chain…', 8)
    : app.chainError ? empty(app.chainError, '  ', btn('RETRY', () => load(app.symbol), '', 'Ask for the option chain again'))
    : empty(`No options are listed for ${app.symbol} on the free data sources (crypto, futures, funds and many foreign shares have none there). The price views still work.`)),
};

// ---------------------------------------------------------------- loading

/** Put a remembered ticker on screen. */
function show(symbol, snap) {
  Object.assign(app, { symbol, quote: snap.quote, chain: snap.chain, chainError: snap.chainError, hv: snap.hv, loadedAt: snap.loadedAt,
                       expiry: snap.expiry ?? null, selected: null, error: null, pending: null, chainLoading: false });
  pickExpiry();
}
function pickExpiry() {
  if (app.chain && !ctx.expiry()) app.expiry = (app.chain.expiries.find(e => e.days >= 2) || app.chain.expiries[0]).label;
}
function remember() {
  recent.delete(app.symbol);
  recent.set(app.symbol, { quote: app.quote, chain: app.chain, chainError: app.chainError, hv: app.hv, loadedAt: app.loadedAt, expiry: app.expiry });
  while (recent.size > KEEP_TICKERS) recent.delete(recent.keys().next().value);
}
/** Apply what the address bar asked for (an expiry, a contract, strategy legs) once the chain is there. */
function applyWants() {
  const w = app.want;
  if (!w || !app.chain) return;
  app.want = null;
  const c = w.c && app.chain.contracts.find(x => x.symbol === w.c);
  if (c) { app.selected = c.id; app.expiry = c.exp.label; }
  else if (w.exp && app.chain.expiries.some(e => e.label === w.exp)) app.expiry = w.exp;
  const legs = w.legs ? M.decodeLegs(w.legs, app.chain) : [];
  if (legs.length) { app.legs[app.symbol] = legs; disk.set('legs', app.legs); }
}

/**
 * Load a ticker. A ticker seen in the last few minutes appears at once and is refreshed behind the
 * scenes. A new one shows placeholders immediately, then its price, then its option chain.
 */
async function load(symbol, { quiet = false } = {}) {
  symbol = symbol.toUpperCase();
  const token = ++loadToken;
  if (symbol !== app.symbol) {
    const leaving = recent.get(app.symbol);
    if (leaving) leaving.expiry = app.expiry;
    const snap = recent.get(symbol);
    if (snap) {
      app.message = null;       // "GEMI loaded" must not linger under another ticker
      show(symbol, snap); applyWants(); disk.set('last', symbol); syncUrl(); render();
      if (Date.now() - snap.loadedAt < FRESH_MS) { app.loading = false; return renderChrome(); }
      quiet = true;
    } else app.pending = symbol;
  }
  app.loading = true;
  if (!quiet) ctx.status(`Loading ${symbol}…`);
  if (app.pending) render(); else renderChrome();

  const q = encodeURIComponent(symbol);
  const chainReq = api('/api/chain?symbol=' + q).catch(e => ({ error: e.message }));
  const yearReq = api(`/api/history?symbol=${q}&range=1Y`).catch(() => null);
  try {
    const quote = await api('/api/quote?symbol=' + q);
    if (token !== loadToken) return;
    if (app.pending) {      // the price is in: show it now, the chain usually lands a moment later
      Object.assign(app, { symbol, quote, chain: null, chainError: null, hv: null, expiry: null, selected: null, error: null, pending: null, chainLoading: true });
      render();
    }
    const [raw, year] = await Promise.all([chainReq, yearReq]);
    if (token !== loadToken) return;
    const chain = raw.error || !raw.rows.length ? null : M.buildChain(raw, quote);
    if (year) app.hist[`${symbol}|1Y`] = { at: Date.now(), data: year };
    Object.assign(app, {
      symbol, quote, chain: chain?.expiries.length ? chain : null, chainError: raw.error || null, loadedAt: Date.now(), error: null, chainLoading: false,
      hv: year ? { d10: Q.realizedVol(year.c, 10), d20: Q.realizedVol(year.c, 20), d60: Q.realizedVol(year.c, 60), d250: Q.realizedVol(year.c, Math.min(250, year.c.length - 1)) } : null,
    });
    pickExpiry(); applyWants(); remember();
    disk.set('last', symbol);
    if (!quiet) ctx.status(`${symbol} loaded`);
  } catch (e) {
    if (token !== loadToken) return;
    if (!quiet || !app.quote) Object.assign(app, { error: e.message, failed: symbol });
    ctx.status(e.message, true);
  } finally {
    if (token === loadToken) { Object.assign(app, { loading: false, pending: null, chainLoading: false }); syncUrl(); render(); }
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
// The address holds everything needed to come back to a screen:
//   #/GEMI/chain?c=GEMI261204P00002000      #/SPY/oi?exp=2026-12-18      #/GEMI/strategy?legs=12xGEMI261204P00002000@0.4
// Changing view, ticker or lesson adds a step for the Back button; refining a screen (expiry, contract, legs) does not.

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const [, sym = '', view] = path.split('/');
  const q = new URLSearchParams(query);
  let symbol = null;
  try { symbol = decodeURIComponent(sym).toUpperCase() || null; } catch { /* a mangled address: fall back to the last ticker */ }
  return { symbol, view: VIEWS.some(v => v.id === view) ? view : null, exp: q.get('exp'), c: q.get('c'), legs: q.get('legs'), lesson: q.get('lesson') };
}
function buildHash() {
  const q = new URLSearchParams();
  if (app.chain) {
    const c = app.view === 'chain' && ctx.contract();
    if (c) q.set('c', c.symbol);
    else if (app.expiry && ['chain', 'oi', 'strategy'].includes(app.view)) q.set('exp', app.expiry);
    if (app.view === 'strategy' && ctx.legs().length) q.set('legs', M.encodeLegs(ctx.legs()));
  }
  if (app.view === 'learn') q.set('lesson', app.lesson);
  const query = q.toString();
  return `#/${encodeURIComponent(app.symbol || '')}/${app.view}${query ? '?' + query : ''}`;
}
function syncUrl(push = false) {
  if (!app.symbol) return;
  const next = buildHash();
  if (next !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', next);
}
/** Go to a ticker (and optionally a view) as a new step in the history. */
function navigate(symbol, view) {
  symbol = symbol.toUpperCase();
  if (view) app.view = view;
  app.want = null;
  if (symbol === app.symbol && !app.pending) { syncUrl(true); render(); return; }
  history.pushState(null, '', `#/${encodeURIComponent(symbol)}/${app.view}`);
  load(symbol);
}
/** The address changed under us: Back, Forward, or an edit in the address bar. */
function applyUrl() {
  if (location.hash === buildHash()) return;          // the page already shows this address
  const u = parseHash();
  if (u.view) app.view = u.view;
  if (u.lesson) app.lesson = u.lesson;
  app.want = { exp: u.exp, c: u.c, legs: u.legs };
  if (u.symbol && u.symbol !== app.symbol) return load(u.symbol);
  app.selected = null;
  applyWants(); syncUrl(); render();
}

// ---------------------------------------------------------------- chrome

function renderTabs() {
  const q = app.pending ? null : app.quote;
  mount($('tabs'),
    VIEWS.map((v, i) => h('button', { class: v.id === app.view ? 'on' : '', key: 'tab:' + v.id, onclick: () => ctx.go(v.id) }, h('span', { class: 'key' }, i + 1), v.label)),
    // The ticker and its price, shown by the stylesheet once the quote bar has scrolled out of sight.
    q ? h('button', { id: 'mini', key: 'mini', tiptext: 'Back to the top', onclick: () => scrollTo(0, 0) },
      h('b', null, q.symbol), h('span', null, F.price(q.price)), h('span', { class: tone(q.changePct) }, F.signedPct(q.changePct / 100))) : null);
}

function renderQuote() {
  const q = app.quote, el = $('quote');
  if (app.pending) return mount(el, h('span', { class: 'sym' }, app.pending), h('span', { class: 'skel-inline' }), h('span', { class: 'skel-inline short' }), h('span', { class: 'skel-inline short' }));
  if (!q) return mount(el, h('span', { class: 'muted' }, 'No security loaded.'));
  const c = app.chain, e = c && anchorExpiry(c), wait = app.chainLoading;
  const state = { REGULAR: ['OPEN', 'open'], PRE: ['PRE-MARKET', 'warn'], POST: ['AFTER HOURS', 'warn'], POSTPOST: ['CLOSED', 'closed'], PREPRE: ['CLOSED', 'closed'], CLOSED: ['CLOSED', 'closed'] }[q.marketState] || [q.marketState || '', 'closed'];
  const block = (label, value, tip) => h('div', { class: 'q' }, h('span', { tip }, label), h('span', null, value));
  const watched = app.watch.includes(q.symbol);
  mount(el,
    h('span', { class: 'sym' }, q.symbol),
    h('span', { class: 'name' }, q.name, h('span', { class: 'muted' }, `  ${q.exchange} · ${q.type}`)),
    flash(h('span', { class: 'px' }, F.price(q.price)), 'quote:' + q.symbol, q.price),
    h('span', { class: tone(q.change) }, `${F.signed(q.change, q.price < 10 ? 3 : 2)} (${F.signedPct(q.changePct / 100)})`),
    q.extPrice && state[1] === 'warn' ? h('span', { class: 'muted' }, `${state[0].toLowerCase()} ${F.price(q.extPrice)} `, h('span', { class: tone(q.extChangePct) }, F.signedPct(q.extChangePct / 100))) : null,
    state[0] ? h('span', { class: 'badge ' + state[1] }, state[0]) : null,
    block('Day range', `${F.price(q.dayLow)} – ${F.price(q.dayHigh)}`),
    block('52-week', `${F.price(q.yearLow)} – ${F.price(q.yearHigh)}`),
    block('Volume', `${F.compact(q.volume)}${q.avgVolume ? ` (${F.num(q.volume / q.avgVolume, 1)}× avg)` : ''}`),
    q.marketCap ? block('Mkt cap', '$' + F.compact(q.marketCap)) : null,
    // While the chain is on its way these keep their place, so the bar does not jump when it lands.
    c || wait ? block('IV 30d', c ? F.iv(c.iv30) : '…', 'iv') : null,
    app.hv?.d20 != null || wait ? block('Realized 20d', wait ? '…' : F.iv(app.hv.d20), 'hv') : null,
    e || wait ? block(e ? `Exp. move ${F.date(e.date)}` : 'Exp. move', e ? `±${F.usd(e.em)} (${F.pct(e.em / e.F)})` : '…', 'em') : null,
    h('button', { class: 'star', key: 'star', tiptext: watched ? 'Remove from the watch strip' : 'Add to the watch strip', onclick: () => {
      app.watch = watched ? app.watch.filter(s => s !== q.symbol) : [...app.watch, q.symbol];
      disk.set('watch', app.watch); keepFocus(() => { renderQuote(); renderWatch(); }); refreshWatch();
    } }, watched ? '★ WATCHING' : '☆ WATCH'));
}

function renderWatch() {
  const current = app.pending || app.symbol;
  mount($('watch'), h('span', { class: 'label' }, 'WATCH'), app.watch.map(sym => {
    const q = app.watchQuotes[sym];
    return h('button', { class: 'w' + (sym === current ? ' on' : ''), key: 'watch:' + sym, onclick: () => ctx.load(sym) },
      h('b', null, sym.replace('^', '')), flash(h('span', null, q?.price != null ? F.price(q.price) : '…'), 'watch:' + sym, q?.price),
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
    h('span', { class: 'keys' }, h('kbd', null, '/'), ' command  ', h('kbd', null, '1'), '–', h('kbd', null, '8'), ' views  ', h('kbd', null, '['), h('kbd', null, ']'), ' expiry  ', h('kbd', null, '?'), ' help'));
}

const applyText = () => document.documentElement.style.setProperty('--text', app.text);
function renderTop() {
  const sizes = seg([[1, 'A', 'Normal text'], [1.12, 'A', 'Larger text'], [1.25, 'A', 'Largest text']], app.text, size => {
    app.text = size; disk.set('text', size); applyText();
    keepFocus(() => { renderTop(); render(); });        // charts take their text size when drawn, so draw them again
  }, null, 'Text size');
  sizes.classList.add('textsize');
  mount($('topbtns'),
    h('span', { class: 'clock', id: 'clock' }),
    sizes,
    btn('GLOSSARY', showGlossary, '', 'Every term in plain English'),
    btn('HELP', showHelp, '', 'Commands and shortcuts'));
  tick();
}
function tick() {
  const el = $('clock');
  if (el) el.textContent = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' NY';
}

const errorBanner = () => h('div', { class: 'banner err' }, app.error, '  ', btn('RETRY', () => load(app.failed || app.symbol), '', 'Try loading it again'));

function renderView() {
  const root = $('view'), old = document.querySelector('.chain-wrap'), keep = old && [old.scrollTop, old.scrollLeft];
  keepFocus(() => {
    mount(root);
    if (app.pending) append(root, skeleton(`Loading ${app.pending}…`, 7, 's7'), skeleton('Snapshot', 7, 's5'), skeleton('Price', 5, 's7'), skeleton('Expiries', 5, 's5'));
    else if (!app.quote) append(root, app.error ? errorBanner() : null, empty('Type a ticker in the command line above, for example SPY or AAPL.'));
    else {
      if (app.error) append(root, errorBanner());
      try { VIEWS.find(v => v.id === app.view).render(root, ctx); } catch (e) {
        console.error(e);
        append(root, h('div', { class: 'banner err' }, `This view hit an error: ${e.message}. The other views still work.`));
      }
    }
  });
  purgePlots();
  const wrap = document.querySelector('.chain-wrap');
  if (wrap && keep) [wrap.scrollTop, wrap.scrollLeft] = keep;
}
function renderChrome() { $('top').classList.toggle('busy', app.loading); renderTabs(); renderQuote(); renderWatch(); renderStatus(); }
function render() {
  document.title = app.pending ? `Loading ${app.pending.replace('^', '')}… · Options Terminal`
    : app.symbol ? `${app.symbol.replace('^', '')} ${F.price(app.quote?.price)} · Options Terminal` : 'Options Terminal';
  keepFocus(() => { renderChrome(); renderView(); });
}

/**
 * The command bar tucks away while you scroll down and comes back as soon as you scroll up, so the
 * views get the room. The tab bar always stays, and carries the ticker once the quote bar is out of sight.
 * The stylesheet does the moving; this keeps its two numbers (--top-h, --tabs-h) true.
 */
function initChrome() {
  const top = $('top'), tabs = $('tabs'), body = document.body, root = document.documentElement;
  let anchor = scrollY;
  const measure = () => {
    root.style.setProperty('--top-h', (body.classList.contains('tucked') ? 0 : top.offsetHeight) + 'px');
    root.style.setProperty('--tabs-h', tabs.offsetHeight + 'px');
  };
  const tuck = on => { if (body.classList.contains('tucked') !== on) { body.classList.toggle('tucked', on); measure(); } };
  const update = () => {                      // browsers send at most one scroll event per frame, so this needs no throttle
    const y = scrollY;
    if (y < 60 || document.activeElement === $('cmd')) { tuck(false); anchor = y; }
    else if (Math.abs(y - anchor) > 8) { tuck(y > anchor); anchor = y; }        // 8px of travel, so a nudge does not flip it
    body.classList.toggle('scrolled', $('quote').getBoundingClientRect().bottom < tabs.getBoundingClientRect().bottom);
  };
  addEventListener('scroll', update, { passive: true });
  $('cmd').addEventListener('focus', () => tuck(false));
  const watcher = new ResizeObserver(measure);
  watcher.observe(top); watcher.observe(tabs);
}

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
    if (it.action) return it.action();
    if (!it.symbol) return ctx.go(it.view);
    ctx.load(it.symbol, it.view);
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
  // With nothing typed, offer the tickers already in memory: they open instantly.
  const offerRecent = () => {
    items = [...recent.keys()].reverse().filter(s => s !== app.symbol).map(s => ({ symbol: s, name: recent.get(s).quote.name, kind: 'RECENT · opens instantly' }));
    active = -1; draw();
  };
  input.addEventListener('focus', () => { if (!input.value.trim()) offerRecent(); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (!text) { seq++; return offerRecent(); }
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
    if (ev.key !== ' ' && n >= 1 && n <= VIEWS.length) ctx.go(VIEWS[n - 1].id);
    else if (ev.key === '/') { ev.preventDefault(); $('cmd').focus({ preventScroll: true }); }
    else if (ev.key === '?') showHelp();
    else if (ev.key === 'g') showGlossary();
    else if (ev.key === 'r' && app.symbol) load(app.symbol);
    else if ((ev.key === '[' || ev.key === ']') && app.chain) {
      const list = app.chain.expiries, i = list.findIndex(e => e.label === app.expiry);
      const next = list[Math.min(Math.max(i + (ev.key === ']' ? 1 : -1), 0), list.length - 1)];
      if (next && next.label !== app.expiry) ctx.setExpiry(next.label);
    } else if (ev.key.startsWith('Arrow') && app.view === 'chain' && !ev.target.closest('.chain-wrap')) {
      // First arrow press on the chain screen puts the keyboard cursor in the table.
      const table = document.querySelector('.chain-wrap');
      if (table) { ev.preventDefault(); table.focus(); }
    } else if (ev.key === 'Escape' && app.selected) ctx.select(null);
  });
}

function showHelp() {
  const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
  openModal('Help', h('div', null,
    h('dl', { class: 'help' },
      row('AAPL ⏎', 'Type any ticker or company name in the command line and press Enter. Stocks, ETFs and indexes all work: SPY, QQQ, ^SPX, ^VIX, ^NDX.'),
      row('SPY CHAIN ⏎', 'Add a view after the ticker to land on it: OVERVIEW (OV), PRICE (GP), CHAIN (OC), VOLATILITY (VOL), OI, STRATEGY (STRAT), CALCULATOR (CALC), LEARN.'),
      row('/', 'Jump to the command line. With nothing typed it lists recent tickers, which open instantly. The command bar hides as you scroll down a page and returns when you scroll up or press this key.'),
      row('1 … 8', 'Switch view. The browser\'s Back button steps back through the views and tickers you visited.'),
      row('[  ]', 'Previous and next expiry.'),
      row('← ↑ ↓ →', 'On the CHAIN view: move between contracts (left for calls, right for puts). Enter opens the one under the cursor. Home and End jump to the lowest and highest strike.'),
      row('r', 'Reload the current ticker.'),
      row('g  ?', 'Glossary and this help.'),
      row('Esc', 'Close a dialog or deselect a contract.'),
      row('A A A', 'Text size, top right: normal, larger, largest. Charts follow it.')),
    h('p', { class: 'note' }, 'The address bar always describes the screen you are on, including the expiry, the selected contract and the legs of a strategy. Bookmark it or copy it to come straight back.'),
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
  applyText(); initTips(); initCommand(); initKeys(); initChrome(); renderTop();
  $('brand').addEventListener('click', () => ctx.go('overview'));
  addEventListener('popstate', applyUrl);
  addEventListener('hashchange', applyUrl);
  const u = parseHash();
  if (u.view) app.view = u.view;
  if (u.lesson) app.lesson = u.lesson;
  app.want = { exp: u.exp, c: u.c, legs: u.legs };
  load(u.symbol || disk.get('last', 'SPY'));
  refreshWatch();
  setInterval(tick, 1000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshWatch(); }, 60000);
  // Heartbeat: a server started by the app icon stops itself once no page has spoken to it for a while.
  setInterval(() => { fetch('/api/ping').catch(() => {}); }, 60000);
  setInterval(() => {
    // Views driven by sliders are left alone so a refresh never yanks a control mid-drag.
    if (app.autoRefresh && document.visibilityState === 'visible' && app.symbol && !app.loading && !modalOpen() && !['learn', 'calc', 'strategy'].includes(app.view)) load(app.symbol, { quiet: true });
  }, 60000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

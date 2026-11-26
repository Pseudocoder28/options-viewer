// Strategy builder (multi-leg positions with payoff, odds and Greeks) and the pricing calculator.
import * as M from './model.js';
import * as Q from './quant.js';
import * as F from './fmt.js';
import { h, append, mount, plot, chart, panel, stat, empty, note, seg, select, slider, numberInput, btn, tone, C, vline } from './ui.js';
import { strategyStory, niceMove } from './explain.js';
import { drawPayoff } from './payoff.js';

// ---------------------------------------------------------------- strategy builder

/** Refresh each leg's market data (volatility, bid, ask, mark) from the live chain. Entry prices are kept. */
function syncLegs(legs, chain, now) {
  for (const l of legs) {
    if (l.kind === 'S') { l.mark = chain.spot; l.live = true; continue; }
    const c = chain.contracts.find(x => x.id === l.id);
    l.live = !!c;
    if (c) Object.assign(l, { sigma: c.sigma ?? c.exp.atmIV ?? l.sigma, q: c.exp.q, basis: c.exp.basis, t0: now, close: c.exp.close, bid: c.bid, ask: c.ask, mark: c.mark ?? c.theo, delta: c.delta });
    else l.mark = null;
  }
}
/** Point a leg at another contract (new type, expiry or strike), keeping its side and size. */
function relink(leg, chain, want) {
  const exp = chain.expiries.find(e => e.label === (want.expLabel ?? leg.expLabel)) || chain.expiries[0];
  const put = (want.kind ?? leg.kind) === 'P', list = put ? exp.puts : exp.calls;
  if (!list.length) return leg;
  const target = want.strike ?? leg.strike ?? exp.atmStrike;
  const c = list.reduce((a, b) => (Math.abs(b.strike - target) < Math.abs(a.strike - target) ? b : a));
  return M.legFromContract(c, leg.side, leg.kind === 'S' ? 1 : leg.qty);
}

export function strategy(root, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote, sym = q.symbol.replace('^', '');
  if (!chain) return append(root, empty(app.chainError || `No options are listed for ${sym} on the free data sources.`));
  const now = Date.now() / 1000, exp = ctx.expiry() || chain.expiries[0];
  const legs = ctx.legs().map(l => ({ ...l }));
  syncLegs(legs, chain, now);
  const commit = next => { ctx.setLegs(next); ctx.rerenderView(); };
  const patch = (i, change) => commit(legs.map((l, j) => (j === i ? { ...l, ...change } : l)));
  const expOptions = chain.expiries.map(e => [e.label, `${F.date(e.date)}${e.days > 300 ? ` '${e.date.slice(2, 4)}` : ''}${e.label !== e.date ? ' ' + e.root : ''} (${F.days(e.days)})`]);

  let saveName = '';
  append(root, h('div', { class: 'toolbar' },
    select([['', 'Start from a template…'], ...Object.entries(M.TEMPLATES).map(([name, t]) => [name, `${name}  ·  ${t.view}`])], '', name => { if (name) commit(M.buildTemplate(name, exp, chain.spot)); }, 'Template'),
    select(expOptions, exp.label, label => ctx.setExpiry(label), 'Expiry for new legs'),
    btn('+ OPTION LEG', () => commit([...legs, M.legFromContract(exp.rows.get(exp.atmStrike).call || exp.calls[0] || exp.puts[0], 1, 1)]), '', 'Add the at-the-money call of the chosen expiry; change it in the table'),
    btn('+ 100 SHARES', () => commit([...legs, M.stockLeg(1, 100, chain.spot)]), '', 'Add shares, for covered calls, protective puts and collars'),
    legs.length ? btn('CLEAR', () => commit([]), '', 'Remove every leg') : null,
    legs.length ? h('span', { class: 'field' }, h('input', { type: 'text', placeholder: 'name this position', style: { width: '170px' }, oninput: ev => { saveName = ev.target.value; } }),
      btn('SAVE', () => { ctx.setSaved([...ctx.saved(), { name: saveName.trim() || `${sym} ${M.nameOf(legs).toLowerCase()}`, symbol: app.symbol, legs, at: Date.now() }]); ctx.status('Position saved in this browser'); ctx.rerenderView(); }, 'primary', 'Keep this position in this browser so you can track it later')) : null));

  if (!legs.length) {
    append(root, panel('Build a position', { code: 'STRAT', lesson: ['strategies', () => ctx.openLesson('strategies')] }, h('div', { class: 'prose' },
      h('p', null, 'A position is one or more legs: options you buy or sell, plus shares if you hold them. This view shows what the whole thing makes or loses at every price, the odds the market gives it, and how it reacts to time and volatility.'),
      h('p', null, 'Three ways to start: pick a template above; press + OPTION LEG and edit the row; or go to the CHAIN view, click any contract and press BUY or SELL.'),
      h('p', null, 'To track something you already own, add the contract, then type the price you actually paid into the Entry column and the number of contracts into Qty.'))));
    return savedPanel(root, ctx);
  }

  // ---- legs table
  const rowFor = (l, i) => {
    const e = chain.expiries.find(x => x.label === l.expLabel);
    const strikes = e ? (l.kind === 'P' ? e.puts : e.calls).map(c => c.strike) : [l.strike];
    const stock = l.kind === 'S', mult = M.legMult(l);
    const livePnl = l.mark != null ? (l.mark - l.price) * l.side * l.qty * mult : null;
    return h('tr', null,
      h('td', { class: 'l' }, select([[1, 'Buy'], [-1, 'Sell']], l.side, v => patch(i, { side: +v }))),
      h('td', null, numberInput({ value: l.qty, min: 1, step: 1, width: '64px', onChange: v => patch(i, { qty: Math.max(Math.round(v), 1) }) })),
      h('td', { class: 'l' }, select([['C', 'Call'], ['P', 'Put'], ['S', 'Shares']], l.kind, v => commit(legs.map((x, j) => (j !== i ? x : v === 'S' ? M.stockLeg(x.side, 100, chain.spot) : relink({ ...x, expLabel: x.expLabel || exp.label }, chain, { kind: v })))))),
      h('td', { class: 'l' }, stock ? '—' : select(e ? expOptions : [[l.expLabel, `${F.date(l.date)} (not in chain)`], ...expOptions], l.expLabel, v => commit(legs.map((x, j) => (j === i ? relink(x, chain, { expLabel: v }) : x))))),
      h('td', null, stock ? '—' : select(strikes.map(s => [s, F.strike(s)]), l.strike, v => commit(legs.map((x, j) => (j === i ? relink(x, chain, { strike: +v }) : x))))),
      h('td', null, numberInput({ value: +l.price.toFixed(4), min: 0, step: 0.01, width: '82px', onChange: v => patch(i, { price: Math.max(v, 0) }), tip: 'premium' })),
      h('td', { class: 'muted' }, stock ? F.price(chain.spot) : l.live ? `${l.bid > 0 ? F.price(l.bid) : '—'} / ${l.ask > 0 ? F.price(l.ask) : '—'}` : 'not quoted'),
      h('td', null, stock ? '—' : F.iv(l.sigma)),
      h('td', null, stock ? F.int(l.side * l.qty) : l.delta != null ? F.int(l.delta * l.side * l.qty * 100) : '—'),
      h('td', null, F.money(l.side * l.qty * mult * l.price)),
      h('td', { class: tone(livePnl) }, F.pnl(livePnl)),
      h('td', null, btn('✕', () => commit(legs.filter((_, j) => j !== i)), 'ghost', 'Remove this leg')));
  };
  const th = (label, tip, tiptext, cls) => h('th', { tip, tiptext, class: cls }, label);
  append(root, panel(`${sym}: ${M.nameOf(legs)}`, { cls: 'flush', code: 'STRAT', lesson: ['strategies', () => ctx.openLesson('strategies')] },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid legs' },
      h('thead', null, h('tr', null, th('Side', null, 'Buy: you pay the premium and own the right. Sell: you collect the premium and take on the obligation.', 'l'), th('Qty', 'contract', null), th('Type', null, null, 'l'), th('Expiry', 'expiry', null, 'l'), th('Strike', 'strike'),
        th('Entry', null, 'The price per share you paid or received. It starts at the current mid; type your real fill here to track a position you hold.'), th('Bid / ask now', 'spread'), th('IV', 'iv'),
        th('Delta', null, 'This leg\'s share-equivalent: how many shares it currently behaves like.'), th('Cost', 'debit'), th('P/L now', null, 'Profit or loss at the current mid price against your entry price.'), th('', null))),
      h('tbody', null, legs.map(rowFor))))));

  // ---- analysis
  const first = legs.filter(l => l.kind !== 'S').reduce((a, b) => (!a || b.close < a.close ? b : a), null);
  const horizonExp = first && chain.expiries.find(e => e.label === first.expLabel);
  const a = M.analysePosition(legs, { S: chain.spot, r: chain.rate, now, vol: horizonExp?.atmIV ?? null });
  const natural = Q.sum(legs.map(l => l.side * l.qty * M.legMult(l) * (l.kind === 'S' ? l.price : l.side > 0 ? (l.ask > 0 ? l.ask : l.price) : (l.bid > 0 ? l.bid : l.price))));
  const liveKnown = legs.every(l => l.mark != null);
  const livePnl = liveKnown ? Q.sum(legs.map(l => (l.mark - l.price) * l.side * l.qty * M.legMult(l))) : null;
  const g = a.greeks, days = Math.max((a.horizon - now) / 86400, 0);
  append(root,
    h('div', { class: 'stats big' },
      stat(a.cost >= 0 ? 'You pay (debit)' : 'You receive (credit)', F.money(Math.abs(a.cost)), { tip: 'debit', sub: Math.abs(natural - a.cost) > 0.5 ? `${F.money(Math.abs(natural))} at bid/ask prices` : null }),
      stat('Max profit', F.pnl(a.maxProfit), { tone: 'up' }), stat('Max loss', a.maxLoss === -Infinity ? 'Unlimited' : F.pnl(a.maxLoss), { tone: 'down' }),
      stat('Break-even', a.breakevens.length ? a.breakevens.map(F.price).join(' / ') : '—', { tip: 'breakeven', sub: `at ${F.date(a.horizon)}` }),
      stat('Chance of profit', F.pct(a.pop, 0), { tip: 'pop', tone: 'amber' }),
      stat('Reward / risk', Number.isFinite(a.maxProfit) && Number.isFinite(a.maxLoss) && a.maxLoss < 0 ? F.num(a.maxProfit / -a.maxLoss, 2) + '×' : '—', { tiptext: 'Maximum profit divided by maximum loss.' }),
      stat('P/L right now', F.pnl(livePnl), { tone: tone(livePnl), tiptext: 'Value at current mid prices minus what you entered at.' }),
      stat('Net delta', F.int(g.delta) + ' sh', { tip: 'delta', sub: `${F.pnl(g.delta * niceMove(chain.spot))} per ${F.usd(niceMove(chain.spot))} up` }),
      stat('Theta', F.pnl(g.theta) + '/day', { tip: 'theta', tone: tone(g.theta) }),
      stat('Vega', F.pnl(g.vega) + '/pt', { tip: 'vega' }),
      stat('Gamma', F.num(g.gamma, 1) + ' sh/$', { tip: 'gamma', tiptext: 'How many shares of delta the position gains for each $1 the stock rises.' })));

  const payoff = chart('tall'), state = { days: 0, vol: 0 }, sayScenario = h('p', { class: 'say' });
  const scenario = () => a.grid.map(x => M.positionPnl(legs, x, now + state.days * 86400, chain.rate, state.vol));
  const scenarioName = () => `In ${Math.round(state.days)}d${state.vol ? `, IV ${state.vol > 0 ? '+' : ''}${F.num(state.vol * 100, 0)} pts` : ''}`;
  const redraw = () => {
    const y = scenario(), at = M.positionPnl(legs, chain.spot, now + state.days * 86400, chain.rate, state.vol);
    if (window.Plotly && payoff.data) window.Plotly.restyle(payoff, { y: [y], name: [scenarioName()] }, [4]);
    mount(sayScenario, `If ${sym} is still at ${F.usd(chain.spot)} `, h('b', null, state.days ? `${Math.round(state.days)} days from now` : 'today'),
      state.vol ? `, with implied volatility ${state.vol > 0 ? 'up' : 'down'} ${F.num(Math.abs(state.vol) * 100, 0)} points` : '', ', the position shows ',
      h('b', { class: at >= 0 ? 'up' : 'down' }, F.pnl(at)), '. The dotted green line shows that scenario at every price.');
  };
  append(root,
    panel('Profit and loss at every price', { cls: 's8', code: 'P/L' }, payoff,
      slider({ label: 'Move the date', min: 0, max: Math.max(Math.floor(days), 0), step: 1, value: 0, format: v => (v ? `+${v}d` : 'today'), onInput: v => { state.days = v; redraw(); }, tip: 'theta' }),
      slider({ label: 'Shift implied vol', min: -0.5, max: 0.5, step: 0.01, value: 0, format: v => `${v >= 0 ? '+' : ''}${F.num(v * 100, 0)} pts`, onInput: v => { state.vol = v; redraw(); }, tip: 'vega' }),
      sayScenario,
      note('White: profit or loss if held to the first expiry. Amber dashes: if the move happened today. The shaded band is the market\'s typical range by that expiry.')),
    panel('In plain English', { cls: 's4' }, h('div', { class: 'prose' }, strategyStory(a, legs, q, chain.rate).map(t => h('p', null, t)))));
  drawPayoff(payoff, a, { spot: chain.spot, showRange: true, lines: [{ name: scenarioName(), y: scenario(), color: C.series[2] }] });
  redraw();

  // ---- price by date grid
  const sig = a.vol, T = a.T, steps = [2.5, 2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -2, -2.5];
  const prices = [...new Set([...steps.map(z => a.F * Math.exp(z * sig * Math.sqrt(T))), chain.spot])].sort((x, y) => y - x);
  const dates = Array.from({ length: 6 }, (_, j) => now + (a.horizon - now) * j / 5);
  const cells = prices.map(S => dates.map(t => M.positionPnl(legs, S, t, chain.rate)));
  const scale = Math.max(...cells.flat().map(Math.abs), 1);
  append(root, panel('Profit and loss by price and date', { cls: 'flush', code: 'GRID' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', { class: 'l' }, `${sym} at`), h('th', null, 'Move'), dates.map((t, j) => h('th', null, j === 0 ? 'Today' : j === 5 ? `Expiry ${F.date(t)}` : F.date(t))))),
      h('tbody', null, prices.map((S, i) => h('tr', { class: S === chain.spot ? 'on' : '' },
        h('td', { class: 'l' }, F.usd(S), S === chain.spot ? ' ◀ now' : ''), h('td', { class: 'muted' }, F.signedPct(S / chain.spot - 1, 1)),
        cells[i].map(v => h('td', { style: { background: `rgba(${v >= 0 ? '12,163,12' : '208,59,59'},${(Math.min(Math.abs(v) / scale, 1) * 0.5 + (v ? 0.04 : 0)).toFixed(3)})` } }, F.pnl(v)))))))),
    note('Each cell is the position\'s profit or loss if the stock is at that price on that date, with implied volatility unchanged. Read down a column to see the effect of price, across a row to see the effect of time.')));
  savedPanel(root, ctx);
}

function savedPanel(root, ctx) {
  const saved = ctx.saved();
  if (!saved.length) return;
  append(root, panel('Saved positions', { cls: 'flush', code: 'SAVED' }, h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', { class: 'l' }, 'Name'), h('th', { class: 'l' }, 'Ticker'), h('th', { class: 'l' }, 'Legs'), h('th', null, 'Saved'), h('th', null, ''))),
    h('tbody', null, saved.map((s, i) => h('tr', null,
      h('td', { class: 'l' }, s.name), h('td', { class: 'l amber' }, s.symbol),
      h('td', { class: 'l' }, s.legs.map(l => `${l.side > 0 ? '+' : '−'}${l.qty} ${F.legName(l)}`).join(', ')),
      h('td', null, F.date(s.at / 1000)),
      h('td', null, btn('OPEN', () => ctx.openSaved(s), '', 'Load this position into the builder'), ' ',
        btn('DELETE', () => { ctx.setSaved(saved.filter((_, j) => j !== i)); ctx.rerenderView(); }, 'ghost')))))))));
}

// ---------------------------------------------------------------- calculator

const GREEK_CURVES = { price: ['Option value', '$'], delta: ['Delta', ''], gamma: ['Gamma', ''], theta: ['Theta per day', '$'], vega: ['Vega per vol point', '$'] };

export function calc(root, ctx) {
  const { app } = ctx, chain = app.chain, q = app.quote, sym = q.symbol.replace('^', '');
  const e0 = chain && (ctx.expiry() || chain.expiries[0]);
  const fromMarket = () => ({ put: false, S: +(e0 ? e0.S : q.price).toFixed(4), K: e0 ? e0.atmStrike : Math.round(q.price), days: e0 ? Math.max(Math.round(e0.days), 1) : 30,
    vol: e0?.atmIV ? Math.round(e0.atmIV * 1000) / 10 : 30, r: Math.round(q.rate * 10000) / 100, q: Math.round((e0 ? e0.q : q.dividendYield || 0) * 10000) / 100 });
  const p = ctx.prefs('calc', { ...fromMarket(), model: 'bsm', curve: 'price', market: null });
  // A different ticker (or broken numbers) resets the inputs to that ticker's market.
  if (p.symbol !== app.symbol || ['S', 'K', 'days', 'vol', 'r', 'q'].some(k => !Number.isFinite(p[k]))) Object.assign(p, fromMarket(), { symbol: app.symbol, market: null });
  const set = patch => { Object.assign(p, patch); ctx.savePrefs(); ctx.rerenderView(); };
  const o = { S: p.S, K: p.K, T: p.days / 365, r: p.r / 100, q: p.q / 100, vol: p.vol / 100, put: p.put };
  const tree = x => Q.binomial(x, 300, true);
  const g = Q.bsm(o), american = Q.binomial(o, 400, true);
  const out = p.model === 'tree' ? { ...Q.numericGreeks(tree, o), probITM: g.probITM } : g;
  const intrinsic = Q.intrinsic(o.S, o.K, o.put), be = o.put ? o.K - out.price : o.K + out.price;
  const solved = p.market > 0 ? Q.impliedVol(p.market, o.S, o.K, o.T, o.r, o.q, o.put) : null;
  const move = niceMove(o.S), n = (label, key, extra = {}) => numberInput({ label, value: p[key], onChange: v => set({ [key]: v }), ...extra });

  append(root,
    h('div', { class: 'toolbar' },
      seg([[false, 'Call'], [true, 'Put']], p.put, put => set({ put })),
      n('Stock price', 'S', { min: 0, step: 0.01 }), n('Strike', 'K', { min: 0, step: 0.5, tip: 'strike' }), n('Days to expiry', 'days', { min: 0, step: 1, width: '64px', tip: 'expiry' }),
      n('Volatility %', 'vol', { min: 0.1, step: 0.5, width: '70px', tip: 'iv' }), n('Rate %', 'r', { step: 0.05, width: '64px' }), n('Dividend %', 'q', { step: 0.05, width: '64px' }),
      seg([['bsm', 'Black-Scholes', 'The standard formula. Treats the option as exercisable only at expiry (European).'], ['tree', 'Binomial (American)', 'A price tree that allows early exercise, as US stock options do. It matters most for in-the-money puts.']], p.model, model => set({ model }), 'Model'),
      btn(`USE ${sym} NOW`, () => set(fromMarket()), '', `Fill in ${sym}'s current price, at-the-money strike and implied volatility`)),
    h('div', { class: 'stats big' },
      stat('Value per share', F.usd(out.price), { tone: 'amber', sub: `${F.money(out.price * 100)} per contract` }),
      stat('Delta', F.greek(out.delta, 3), { tip: 'delta', sub: `${F.pnl(out.delta * move * 100)} per ${F.usd(move)} up` }),
      stat('Gamma', F.greek(out.gamma, 4), { tip: 'gamma', sub: `delta ${F.signed(out.gamma * move, 3)} per ${F.usd(move)}` }),
      stat('Theta', F.greek(out.theta, 4), { tip: 'theta', sub: `${F.pnl(out.theta * 100)} per day` }),
      stat('Vega', F.greek(out.vega, 4), { tip: 'vega', sub: `${F.pnl(out.vega * 100)} per vol point` }),
      stat('Rho', F.greek(out.rho, 4), { tip: 'rho', sub: `${F.pnl(out.rho * 100)} per rate point` }),
      stat('Intrinsic', F.usd(intrinsic), { tip: 'intrinsic' }), stat('Time value', F.usd(Math.max(out.price - intrinsic, 0)), { tip: 'extrinsic' }),
      stat('Chance in the money', F.pct(out.probITM, 0), { tip: 'probitm' }), stat('Break-even at expiry', F.usd(be), { tip: 'breakeven', sub: F.signedPct(be / o.S - 1, 1) + ' from here' }),
      stat('Early-exercise premium', F.usd(Math.max(american - g.price, 0)), { tiptext: 'How much more the American version is worth than the European one, because it can be exercised early.' }),
      p.model === 'bsm' ? [stat('Vanna', F.greek(g.vanna, 4), { tip: 'vanna', sub: 'delta per vol point' }), stat('Charm', F.greek(g.charm, 4), { tip: 'charm', sub: 'delta per day' }),
        stat('Vomma', F.greek(g.vomma, 4), { tip: 'vomma', sub: 'vega per vol point' })] : null));

  const main = chart('tall'), decay = chart(), volc = chart();
  append(root,
    panel(`${GREEK_CURVES[p.curve][0]} across stock prices`, { cls: 's8', code: 'CALC', lesson: [p.curve === 'price' ? 'value' : p.curve, () => ctx.openLesson(p.curve === 'price' ? 'value' : p.curve)],
      tools: seg(Object.entries(GREEK_CURVES).map(([k, v]) => [k, v[0].split(' ')[0]]), p.curve, curve => set({ curve })) }, main,
      note('Three moments in the option\'s life: today, halfway to expiry, and the last day. Watch how the curve sharpens around the strike as time runs out.')),
    panel('Solve for implied volatility', { cls: 's4' },
      h('div', { class: 'prose' }, h('p', null, 'Type the option\'s market price and the calculator finds the volatility that explains it. That is all implied volatility is.')),
      h('div', { class: 'row' }, numberInput({ label: 'Market price', value: p.market ?? '', min: 0, step: 0.01, onChange: v => set({ market: v }) }),
        solved != null ? btn(`USE ${F.num(solved * 100, 1)}%`, () => set({ vol: Math.round(solved * 1000) / 10 }), 'primary') : null),
      p.market > 0 ? h('p', { class: 'say' }, solved != null ? ['A price of ', h('b', null, F.usd(p.market)), ' implies a volatility of ', h('b', null, F.pct(solved, 1)), '.']
        : 'No volatility can produce that price: it is below what the option is worth with zero volatility, or above the most it can ever be worth.') : null,
      h('h2', { class: 'sub' }, 'What these numbers say'),
      h('div', { class: 'prose' },
        h('p', null, `If the stock rises ${F.usd(move)}, this ${o.put ? 'put' : 'call'} ${out.delta >= 0 ? 'gains' : 'loses'} about ${F.money(Math.abs(out.delta * move * 100))} per contract, and its delta moves to about ${F.greek(out.delta + out.gamma * move, 3)}.`),
        h('p', null, `One day passing costs about ${F.money(Math.abs(out.theta * 100))} per contract. One point more of volatility adds about ${F.money(out.vega * 100)}.`))),
    panel('Value as time passes (stock and volatility unchanged)', { cls: 's6', lesson: ['theta', () => ctx.openLesson('theta')] }, decay),
    panel('Value across volatility levels', { cls: 's6', lesson: ['vega', () => ctx.openLesson('vega')] }, volc));

  const fn = p.model === 'tree' ? (x => (p.curve === 'price' ? tree(x) : Q.numericGreeks(y => Q.binomial(y, 120, true), x)[p.curve])) : (x => Q.bsm(x)[p.curve]);
  const scale = p.curve === 'theta' || p.curve === 'vega' ? 100 : 1;
  const w = Math.min(Math.max(3 * o.vol * Math.sqrt(Math.max(o.T, 5 / 365)), 0.15), 1.5);
  const lo = Math.min(o.S, o.K) * Math.exp(-w), hi = Math.max(o.S, o.K) * Math.exp(w), N = p.model === 'tree' ? 50 : 160;
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + (hi - lo) * i / N);
  const slices = [[o.T, 'Today', C.ramp[0]], [o.T / 2, `${Math.round(p.days / 2)} days left`, C.ramp[2]], [1 / 365, 'Last day', C.ramp[4]]].filter(([T], i) => i === 0 || T < o.T);
  const k = vline(o.K, `strike ${F.strike(o.K)}`, C.muted), s = vline(o.S, `stock ${F.price(o.S)}`, C.amber, 'dot', 'bottom');
  plot(main, slices.map(([T, name, color]) => ({ type: 'scatter', mode: 'lines', name, x: xs, y: xs.map(S => fn({ ...o, S, T }) * scale), line: { color, width: 2 },
    hovertemplate: `${name}: %{y:,.4~f}<extra></extra>` })),
    { showlegend: true, hovermode: 'x unified', margin: { t: 28 }, xaxis: { title: { text: 'Stock price' }, tickprefix: '$' },
      yaxis: { title: { text: GREEK_CURVES[p.curve][0] + (scale === 100 ? ' ($ per contract)' : '') }, tickprefix: p.curve === 'price' ? '$' : '' }, shapes: [k.shape, s.shape], annotations: [k.note, s.note] });

  const dayAxis = Array.from({ length: 81 }, (_, i) => p.days * (1 - i / 80));
  plot(decay, [{ type: 'scatter', mode: 'lines', x: dayAxis, y: dayAxis.map(d => Q.bsPrice(o.S, o.K, d / 365, o.r, o.q, o.vol, o.put)), line: { color: C.amber, width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(255,176,0,0.08)',
    hovertemplate: '%{x:.0f} days left<br>value $%{y:,.3f}<extra></extra>' }],
    { xaxis: { title: { text: 'Days left until expiry' }, autorange: 'reversed' }, yaxis: { title: { text: 'Option value' }, tickprefix: '$', rangemode: 'tozero' },
      shapes: intrinsic > 0 ? [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: intrinsic, y1: intrinsic, line: { color: C.muted, width: 1, dash: 'dot' } }] : [],
      annotations: intrinsic > 0 ? [{ xref: 'paper', x: 0, y: intrinsic, text: `intrinsic value ${F.usd(intrinsic)}`, showarrow: false, xanchor: 'left', yanchor: 'bottom', font: { size: 10.5, color: C.muted } }] : [] });

  const vols = Array.from({ length: 81 }, (_, i) => Math.max(p.vol * 0.2, 1) + (p.vol * 2.2 - Math.max(p.vol * 0.2, 1)) * i / 80);
  const vm = vline(p.vol, `now ${F.num(p.vol, 0)}%`, C.amber);
  plot(volc, [{ type: 'scatter', mode: 'lines', x: vols, y: vols.map(v => Q.bsPrice(o.S, o.K, o.T, o.r, o.q, v / 100, o.put)), line: { color: C.ink, width: 2 }, hovertemplate: 'IV %{x:.0f}%<br>value $%{y:,.3f}<extra></extra>' }],
    { xaxis: { title: { text: 'Implied volatility' }, ticksuffix: '%' }, yaxis: { title: { text: 'Option value' }, tickprefix: '$', rangemode: 'tozero' }, shapes: [vm.shape], annotations: [vm.note] });
}

// Portfolio view: your holdings, where the money really is, and how diversified it is.
//
// The holdings live in the browser (app.portfolio, see app.js). This view asks the server what the
// market says about them, in four parts that arrive on their own: prices, option chains, what each
// holding is, and a year of daily prices. Each part redraws the view when it lands, so the table
// appears first and the slower panels fill in after it. portfolio.js does all the arithmetic.
import * as P from './portfolio.js';
import * as M from './model.js';
import * as F from './fmt.js';
import {
  h,
  append,
  mount,
  plot,
  chart,
  panel,
  stat,
  table,
  empty,
  note,
  story,
  seg,
  select,
  btn,
  tone,
  C,
  openModal,
  closeModal,
  skeletonLines,
  whenVisible,
} from './ui.js';

// How long each part stays fresh before it is asked for again. A part that failed is retried after RETRY_MS.
const AGE = { quotes: 55_000, options: 240_000, profiles: Infinity, history: 1_200_000 };
const RETRY_MS = 30_000;
const MAX_CHAINS = 6; // option chains are large: only this many underlyings are loaded
const MAX_HISTORY = 56; // tickers measured for risk (the server takes 60: these, the exchange rate and two yardsticks)
const MAX_FILE = 2_000_000; // bytes: a holdings report is a few kilobytes
const HEAT_MAX = 16; // positions shown in the "move together" chart

let market = { key: null }; // what the server has said about the holdings on screen, see ensure()
let notice = null; // what the last import did, shown until dismissed: { text, warn }

// ---------------------------------------------------------------- data

const inChunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const listOf = symbols => symbols.map(encodeURIComponent).join(',');

const JOBS = {
  async quotes(api, m, symbols) {
    const parts = await Promise.all(
      inChunks([P.FX, ...symbols], 40).map(part => api('/api/quotes?symbols=' + listOf(part))),
    );
    for (const q of parts.flatMap(part => part.quotes)) if (q.price != null) m.quotes[q.symbol] = q;
    if (!m.quotes[P.FX]) throw new Error('The exchange rate between US and Canadian dollars did not arrive.');
  },
  async options(api, m, symbols, holdings) {
    const wanted = holdings.filter(hd => hd.option);
    const underlyings = [...new Set(wanted.map(hd => hd.symbol))].slice(0, MAX_CHAINS);
    await Promise.all(
      underlyings.map(async symbol => {
        try {
          const q = encodeURIComponent(symbol);
          const [quote, raw] = await Promise.all([api('/api/quote?symbol=' + q), api('/api/chain?symbol=' + q)]);
          const chain = raw.rows.length ? M.buildChain(raw, quote) : null;
          for (const { option } of wanted.filter(hd => hd.symbol === symbol)) {
            const c = chain?.contracts.find(x => x.symbol === option.occ);
            if (c?.mark == null) delete m.options[option.occ];
            else
              m.options[option.occ] = {
                mark: c.mark,
                chg: c.chg,
                delta: c.delta,
                gamma: c.gamma,
                theta: c.theta,
                vega: c.vega,
                iv: c.sigma,
                spot: chain.spot,
              };
          }
        } catch {
          /* no chain for this underlying right now: its options keep the price from the file */
        }
      }),
    );
  },
  async profiles(api, m, symbols) {
    const parts = await Promise.all(inChunks(symbols, 40).map(part => api('/api/profiles?symbols=' + listOf(part))));
    for (const p of parts.flatMap(part => part.profiles)) m.profiles[p.symbol] = p;
  },
  async history(api, m, symbols) {
    if (!symbols.length) return;
    // ponytail: the first MAX_HISTORY tickers only; rank by size first if portfolios ever get that long
    const wanted = [...symbols.slice(0, MAX_HISTORY), P.FX, ...Object.values(P.BENCHMARKS)];
    m.history = await api(`/api/closes?symbols=${listOf(wanted)}&range=1Y`);
  },
};

/** Start whatever part of the market data is missing or has gone stale. Each part redraws the view when it lands. */
function ensure(ctx, holdings) {
  const key = holdings
    .map(hd => `${hd.symbol}:${hd.option?.occ ?? ''}`)
    .sort()
    .join(' ');
  if (market.key !== key)
    market = { key, quotes: {}, options: {}, profiles: {}, history: null, got: {}, failed: {}, busy: {}, problems: {} };
  const m = market,
    now = Date.now();
  const symbols = [...new Set(holdings.map(hd => hd.symbol).filter(Boolean))];
  for (const part of Object.keys(JOBS)) {
    const fresh = m.got[part] && now - m.got[part] < AGE[part];
    const justFailed = now - (m.failed[part] || 0) < RETRY_MS;
    if (m.busy[part] || fresh || justFailed) continue;
    m.busy[part] = true;
    JOBS[part](ctx.api, m, symbols, holdings)
      .then(
        () => {
          m.got[part] = Date.now();
          delete m.problems[part];
        },
        e => {
          m.failed[part] = Date.now();
          m.problems[part] = e.message;
        },
      )
      .finally(() => {
        m.busy[part] = false;
        if (m === market && ctx.app.view === 'portfolio') ctx.rerenderView();
      });
  }
}

// ---------------------------------------------------------------- small pieces

const amount = x => x.toLocaleString('en-US', { maximumFractionDigits: 4 });
const year = new Date().getFullYear();
/** "Dec 17 '27 600 put": an option contract without the ticker it is on. */
const contractText = o =>
  `${F.date(o.expiry)}${+o.expiry.slice(0, 4) !== year ? ` '${o.expiry.slice(2, 4)}` : ''} ` +
  `${F.strike(o.strike)} ${o.put ? 'put' : 'call'}`;
const optionName = o => `${o.underlying} ${contractText(o)}`;
const tag = (text, tiptext, cls = '') => h('span', { class: 'tag ' + cls, tiptext }, text);

/** A list of labelled bars: [{ label, value, share }]. */
const bars = items =>
  h(
    'div',
    { class: 'bars' },
    // a slice under a twentieth of a percent would only be a label with no bar
    items
      .filter(x => Math.abs(x.share) >= 0.0005)
      .map(x =>
        h(
          'div',
          { class: 'barrow' },
          h('span', { class: 'lab', tiptext: x.label }, x.label),
          h('span', { class: 'track' }, h('i', { style: { width: Math.min(Math.abs(x.share) * 100, 100) + '%' } })),
          h('span', { class: 'pct' }, F.pct(x.share)),
          h('span', { class: 'amt' }, F.money(x.value)),
        ),
      ),
  );

// ---------------------------------------------------------------- importing and editing

function readFile(ctx, file) {
  if (!file) return;
  if (file.size > MAX_FILE) return say(ctx, `${file.name} is too large to be a holdings report.`, true);
  file.text().then(
    text => importText(ctx, text, file.name),
    () => say(ctx, `${file.name} could not be read.`, true),
  );
}
function say(ctx, text, warn = false) {
  notice = { text, warn };
  ctx.rerenderView();
}

/** Turn the text of a holdings file into the portfolio. Asks first when there are holdings to replace. */
function importText(ctx, text, name) {
  let read;
  try {
    read = P.readHoldings(text);
  } catch (e) {
    return say(ctx, `${name}: ${e.message}`, true);
  }
  const { holdings, skipped, asOf } = read;
  if (!holdings.length) return say(ctx, `${name} lists no holdings.`, true);
  const unread = holdings.filter(hd => hd.kind === 'option' && !hd.option);
  const summary = [
    `Read ${F.plural(holdings.length, 'holding')} from ${name}${asOf ? `, as of ${F.dateLong(asOf)}` : ''}.`,
    skipped.length
      ? `${F.plural(skipped.length, 'row')} left out: ${skipped.map(s => `${s.text} (${s.reason})`).join('; ')}`
      : '',
    unread.length
      ? `${F.plural(unread.length, 'option')} could not be recognised (${unread.map(hd => hd.raw).join(', ')}): press ✎ on its row to enter the strike and expiry.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const use = list => {
    ctx.setPortfolio({ holdings: list, asOf, importedAt: Date.now() });
    closeModal();
    say(ctx, summary, skipped.length + unread.length > 0);
  };
  const current = ctx.app.portfolio.holdings;
  if (!current.length) return use(holdings);
  openModal(
    'Import holdings',
    h(
      'div',
      null,
      note(summary),
      note(
        `You already have ${F.plural(current.length, 'holding')} here. Replace them with this file, or add the file's holdings to them?`,
      ),
      h(
        'div',
        { class: 'row' },
        btn('REPLACE THEM', () => use(holdings), 'primary', 'The holdings you have now are removed'),
        btn('ADD TO THEM', () => use([...current, ...holdings]), '', 'Keeps what you have and adds these'),
        btn('CANCEL', closeModal, 'ghost'),
      ),
    ),
  );
}

/** The dialog that adds a holding by hand, or corrects one. */
function editHolding(ctx, existing) {
  const o = existing?.option;
  const draft = {
    option: existing?.kind === 'option',
    symbol: existing ? (o ? o.underlying : existing.symbol || existing.raw) : '',
    qty: existing?.qty ?? '',
    cost: existing?.cost ?? '',
    account: existing?.account ?? '',
    expiry: o?.expiry ?? '',
    strike: o?.strike ?? '',
    put: o ? o.put : true,
  };
  const body = h('div', { class: 'form' });
  const problem = h('p', { class: 'note warn', role: 'alert' });
  const field = (label, key, attrs, hint) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h('input', { type: 'text', value: draft[key], oninput: e => (draft[key] = e.target.value), ...attrs }),
      hint ? h('small', null, hint) : null,
    );
  const draw = () =>
    mount(
      body,
      seg(
        [
          [false, 'Share, fund or coin'],
          [true, 'Option'],
        ],
        draft.option,
        v => {
          draft.option = v;
          draw();
        },
        'Kind',
      ),
      field(
        draft.option ? 'Underlying' : 'Ticker',
        'symbol',
        { placeholder: draft.option ? 'GEMI' : 'XEQT.TO', autocapitalize: 'characters', spellcheck: false },
        draft.option
          ? 'The US ticker the option is on.'
          : 'As Yahoo writes it: Toronto listings end in .TO, coins look like BTC-CAD.',
      ),
      draft.option ? field('Expiry', 'expiry', { type: 'date' }) : null,
      draft.option ? field('Strike', 'strike', { inputMode: 'decimal', placeholder: '2' }) : null,
      draft.option
        ? seg(
            [
              [true, 'Put'],
              [false, 'Call'],
            ],
            draft.put,
            v => {
              draft.put = v;
              draw();
            },
            'Type',
          )
        : null,
      field(
        draft.option ? 'Contracts' : 'Quantity',
        'qty',
        { inputMode: 'decimal', placeholder: draft.option ? '12' : '100' },
        'A negative number is a short position.',
      ),
      field(
        'Total paid',
        'cost',
        { inputMode: 'decimal', placeholder: 'optional' },
        draft.option
          ? 'For the whole position, in US dollars: 12 contracts at $0.40 is 480.'
          : 'For the whole position, in the currency it trades in. Leave empty to skip gains.',
      ),
      field('Account', 'account', { placeholder: 'optional', maxLength: 60 }),
      problem,
      h('div', { class: 'row' }, btn(existing ? 'SAVE' : 'ADD', save, 'primary'), btn('CANCEL', closeModal, 'ghost')),
    );
  const number = text => {
    const v = Number(String(text).replace(/[$,\s]/g, ''));
    return String(text).trim() && Number.isFinite(v) ? v : null;
  };
  async function save() {
    const symbol = String(draft.symbol).trim().toUpperCase();
    const qty = number(draft.qty),
      cost = number(draft.cost);
    const fail = text => (problem.textContent = text);
    if (!qty) return fail('Enter a quantity.');
    const option = draft.option ? P.makeOption(symbol, draft.expiry, number(draft.strike) ?? 0, draft.put) : null;
    if (draft.option && !option) return fail('Enter the underlying ticker, an expiry date and a strike.');
    let quote;
    try {
      fail('Checking the ticker…');
      quote = (await ctx.api('/api/quotes?symbols=' + encodeURIComponent(symbol))).quotes[0];
    } catch (e) {
      return fail(e.message);
    }
    if (quote?.price == null)
      return fail(
        `No price was found for ${symbol || 'that ticker'}. Check the spelling: Toronto listings end in .TO.`,
      );
    // An edit that keeps the same security keeps what the file knew about it.
    const same =
      !!existing && (option ? option.occ === existing.option?.occ : !existing.option && symbol === existing.symbol);
    const made = P.cleanHolding({
      id: existing?.id ?? 'new',
      symbol,
      raw: option ? option.occ : same ? existing.raw : symbol,
      name: option ? optionName(option) : same ? existing.name : symbol,
      kind: option ? 'option' : same ? existing.kind : 'stock', // what Yahoo says it is (a fund, a coin) decides how it is shown
      qty,
      currency: quote.currency,
      cost,
      costCAD: same && cost === existing.cost ? existing.costCAD : null,
      filePrice: same ? existing.filePrice : null,
      account: draft.account,
      option,
    });
    if (!made) return fail('That does not make a holding. Check the ticker and the numbers.');
    const list = ctx.app.portfolio.holdings;
    ctx.setPortfolio({
      ...ctx.app.portfolio,
      holdings: existing ? list.map(hd => (hd.id === existing.id ? made : hd)) : [...list, made],
    });
    closeModal();
    notice = null;
    ctx.rerenderView();
  }
  draw();
  openModal(existing ? 'Edit holding' : 'Add a holding', h('div', null, body));
  body.querySelector('input')?.focus();
}

function confirmClear(ctx) {
  const count = ctx.app.portfolio.holdings.length;
  openModal(
    'Remove all holdings',
    h(
      'div',
      null,
      note(
        `This removes all ${F.plural(count, 'holding')} from this browser. Nothing changes at your broker, and you can import the file again.`,
      ),
      h(
        'div',
        { class: 'row' },
        btn(
          'REMOVE THEM',
          () => {
            ctx.setPortfolio({ holdings: [], asOf: null, importedAt: null });
            closeModal();
            notice = null;
            ctx.rerenderView();
          },
          'primary',
        ),
        btn('CANCEL', closeModal, 'ghost'),
      ),
    ),
  );
}

/** The file chooser, as a button. The hidden input is emptied after each use so the same file can be chosen again. */
function fileButton(ctx, text, cls = '') {
  const input = h('input', {
    type: 'file',
    accept: '.csv,text/csv,text/plain',
    hidden: true,
    onchange: e => {
      readFile(ctx, e.target.files[0]);
      e.target.value = '';
    },
  });
  return [input, btn(text, () => input.click(), cls, 'Choose a holdings report (CSV) from your computer')];
}
/** Let a file be dropped anywhere on el. */
function acceptDrops(ctx, el) {
  el.addEventListener('dragover', e => {
    e.preventDefault();
    el.classList.add('dropping');
  });
  el.addEventListener('dragleave', () => el.classList.remove('dropping'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('dropping');
    readFile(ctx, e.dataTransfer.files[0]);
  });
  return el;
}

const banner = () =>
  notice
    ? h(
        'div',
        { class: 'banner' + (notice.warn ? '' : ' ok'), role: 'status' },
        notice.text,
        '  ',
        h(
          'button',
          {
            class: 'btn ghost',
            key: 'dismiss-notice',
            'aria-label': 'Dismiss this message',
            onclick: e => {
              notice = null;
              e.target.closest('.banner').remove();
            },
          },
          '✕',
        ),
      )
    : null;

// ---------------------------------------------------------------- the empty view

function welcome(ctx) {
  return acceptDrops(
    ctx,
    panel(
      'Portfolio',
      { cls: 'drop', code: 'PORT' },
      h(
        'div',
        { class: 'welcome' },
        h(
          'p',
          { class: 'lead' },
          'See all your holdings in one place: what they are worth, where the money really is, and how diversified it is.',
        ),
        h(
          'ol',
          { class: 'steps' },
          h(
            'li',
            null,
            h('b', null, 'Download your holdings from Wealthsimple. '),
            'On the web: Documents, then a custom download, then "Holdings report (CSV)". Choose the accounts and download.',
          ),
          h(
            'li',
            null,
            h('b', null, 'Drop the file anywhere on this panel, '),
            'or choose it: ',
            fileButton(ctx, 'CHOOSE THE FILE', 'primary'),
          ),
          h(
            'li',
            null,
            h('b', null, 'Or start another way: '),
            btn(
              'TRY A SAMPLE PORTFOLIO',
              () => importText(ctx, P.SAMPLE, 'the sample'),
              '',
              'A made-up portfolio, to see what this view does',
            ),
            ' ',
            btn('ADD A HOLDING BY HAND', () => editHolding(ctx), '', 'Type in a ticker and a quantity'),
          ),
        ),
        note(
          'The file is read here in your browser and is not uploaded anywhere. Only the ticker symbols go to the data server, to fetch prices. Account numbers in the file are not kept. Any CSV with a symbol column and a quantity column works, so a list from another broker can be used too.',
        ),
        h(
          'p',
          { class: 'note small' },
          'This view measures and describes. It does not recommend what to buy or sell, and it cannot place orders.',
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- the view

export function render(root, ctx) {
  const { app } = ctx,
    all = app.portfolio.holdings;
  if (!all.length) return append(root, banner(), welcome(ctx));

  const p = ctx.prefs('portfolio', { base: 'CAD', account: 'all' }, { base: P.BASES });
  const accounts = [...new Set(all.map(hd => hd.account).filter(Boolean))];
  if (p.account !== 'all' && !accounts.includes(p.account)) p.account = 'all';
  const holdings = p.account === 'all' ? all : all.filter(hd => hd.account === p.account);
  const set = (key, value) => {
    p[key] = value;
    ctx.savePrefs();
    ctx.rerenderView();
  };
  ensure(ctx, all);
  const m = market,
    priced = !!m.got.quotes;
  const rate = m.quotes[P.FX]?.price;
  const prices = { quotes: m.quotes, options: m.options, usdcad: rate, usdcadChangePct: m.quotes[P.FX]?.changePct };
  const valued = P.valuePortfolio(holdings, prices, p.base);
  const rows = [...valued.rows].sort((a, b) => (b.valueBase ?? -Infinity) - (a.valueBase ?? -Infinity));
  const nameOf = r => (r.holding.option ? contractText(r.holding.option) : m.profiles[r.symbol]?.name || r.name);

  // --- summary
  const stale = valued.rows.filter(r => r.valueBase != null && !r.live);
  const missing = valued.rows.filter(r => r.valueBase == null);
  const summary = h(
    'div',
    { class: 'stats big fit' },
    stat('Value', priced ? F.money(valued.total) : '…', { sub: p.base, tone: 'amber' }),
    stat("Today's change", priced ? F.pnl(valued.day) : '…', {
      tone: tone(valued.day),
      sub: priced && valued.dayPct != null ? F.signedPct(valued.dayPct) : null,
      tiptext:
        'What the holdings gained or lost since the last close, including the move of the exchange rate for holdings in the other currency.',
    }),
    stat('Total gain', priced ? F.pnl(valued.gain) : '…', {
      tone: tone(valued.gain),
      sub: priced && valued.gainPct != null ? F.signedPct(valued.gainPct) + ' on cost' : null,
      tip: 'bookvalue',
    }),
    stat('Holdings', F.int(holdings.length), {
      sub: accounts.length > 1 ? (p.account === 'all' ? `${accounts.length} accounts` : p.account) : null,
    }),
    stat('1 US dollar', rate ? `${F.num(rate, 4)} CAD` : '…', {
      tiptext: 'The exchange rate used to show US holdings in Canadian dollars, and the other way round.',
    }),
    stat('File as of', app.portfolio.asOf ? F.dateLong(app.portfolio.asOf) : '—', {
      sub: 'prices are live',
      tiptext:
        'Quantities and costs come from the file you imported. Prices are fetched now, about 15 minutes delayed. Import a newer file after you trade.',
    }),
  );
  const tools = [
    accounts.length > 1
      ? select([['all', 'All accounts'], ...accounts.map(a => [a, a])], p.account, v => set('account', v), 'Account')
      : null,
    seg(P.BASES, p.base, v => set('base', v), 'Show in'),
    fileButton(ctx, 'IMPORT'),
    btn('ADD', () => editHolding(ctx), '', 'Add a holding by hand'),
    btn('CLEAR', () => confirmClear(ctx), 'ghost', 'Remove all holdings from this browser'),
  ];
  const problems = Object.values(m.problems);
  append(
    root,
    banner(),
    problems.length
      ? h(
          'div',
          { class: 'banner err', role: 'alert' },
          `Some market data did not arrive: ${problems.join(' ')}  `,
          btn(
            'RETRY',
            () => {
              m.failed = {};
              ctx.rerenderView();
            },
            '',
            'Ask for it again',
          ),
        )
      : null,
    acceptDrops(
      ctx,
      panel(
        'Portfolio',
        { cls: 'flush drop', code: 'PORT', tools },
        summary,
        missing.length || stale.length
          ? note(
              missing.length
                ? `${F.plural(missing.length, 'holding')} could not be valued and ${missing.length === 1 ? 'is' : 'are'} left out of every figure: ${missing.map(r => `${r.holding.raw} (${r.why})`).join(' ')} `
                : '',
              stale.length && priced
                ? `${F.plural(stale.length, 'holding')} ${stale.length === 1 ? 'has' : 'have'} no live price and ${stale.length === 1 ? 'is' : 'are'} valued at the price in the file: ${stale.map(r => r.holding.raw).join(', ')}.`
                : '',
            )
          : null,
      ),
    ),
  );

  // --- holdings
  const open = r => {
    const o = r.holding.option;
    if (o) location.hash = `#/${encodeURIComponent(r.symbol)}/chain?c=${o.occ}`;
    else if (r.symbol) ctx.load(r.symbol, 'overview');
  };
  const remove = r => {
    ctx.setPortfolio({ ...app.portfolio, holdings: all.filter(hd => hd.id !== r.id) });
    ctx.status(`Removed ${r.holding.raw} from the portfolio`);
    ctx.rerenderView();
  };
  const act = (fn, r) => ev => {
    ev.stopPropagation();
    fn(r);
  };
  const columns = [
    {
      label: 'Holding',
      cls: 'l',
      cell: r => [
        h('b', null, r.holding.option ? r.holding.option.underlying : r.symbol || r.holding.raw),
        h('span', { class: 'nm' }, nameOf(r)),
        r.kind === 'option' ? tag('OPTION') : null,
        r.valueBase != null && !r.live && priced
          ? tag('FILE PRICE', 'No live price was found, so this is valued at the price in the file you imported.')
          : null,
        r.shares != null
          ? h(
              'small',
              { class: 'sub' },
              `Behaves like ${F.int(Math.abs(r.shares))} ${r.symbol} shares ${r.shares < 0 ? 'sold short' : 'held'}`,
              r.thetaBase != null
                ? ` · ${r.thetaBase <= 0 ? 'loses' : 'gains'} ${F.money(Math.abs(r.thetaBase))} a day to time`
                : '',
              r.iv != null ? ` · IV ${F.iv(r.iv)}` : '',
            )
          : null,
      ],
    },
    accounts.length > 1 && p.account === 'all'
      ? { label: 'Account', cls: 'l', cell: r => r.holding.account || '—' }
      : null,
    { label: 'Quantity', cell: r => amount(r.qty) },
    {
      label: 'Price',
      tiptext: 'The latest price, in the currency the holding trades in.',
      cell: r => [F.price(r.price), r.currency !== p.base ? h('span', { class: 'muted' }, ' ' + r.currency) : null],
    },
    {
      label: 'Value',
      tiptext: `What the holding is worth now, in ${p.base}.`,
      cell: r =>
        r.valueBase == null ? h('span', { class: 'muted', tiptext: r.why }, 'no value') : F.money(r.valueBase),
    },
    {
      label: 'Weight',
      tip: 'weight',
      cell: r =>
        r.weight == null
          ? '—'
          : [
              h('span', { class: 'wbar' }, h('i', { style: { width: Math.min(Math.abs(r.weight) * 100, 100) + '%' } })),
              F.pct(r.weight),
            ],
    },
    {
      label: 'Today',
      cell: r => h('span', { class: tone(r.dayBase) }, F.pnl(r.dayBase)),
    },
    {
      label: 'Gain',
      tip: 'bookvalue',
      cell: r => h('span', { class: tone(r.gainBase) }, F.pnl(r.gainBase)),
    },
    {
      label: 'Gain %',
      cell: r =>
        h(
          'span',
          { class: tone(r.gainBase) },
          r.gainBase != null && r.costBase > 0 ? F.signedPct(r.gainBase / r.costBase, 1) : '—',
        ),
    },
    {
      label: '',
      cell: r => [
        h(
          'button',
          {
            class: 'btn ghost',
            key: `edit:${r.id}`,
            'aria-label': `Edit ${r.holding.raw}`,
            tiptext: 'Edit',
            onclick: act(x => editHolding(ctx, x.holding), r),
          },
          '✎',
        ),
        h(
          'button',
          {
            class: 'btn ghost',
            key: `remove:${r.id}`,
            'aria-label': `Remove ${r.holding.raw}`,
            tiptext: 'Remove from the portfolio',
            onclick: act(remove, r),
          },
          '✕',
        ),
      ],
    },
  ].filter(Boolean);
  append(
    root,
    panel(
      'Holdings',
      { cls: 'flush', code: `${F.plural(rows.length, 'ROW').toUpperCase()}` },
      priced || m.problems.quotes
        ? table(columns, rows, { onRow: open, cls: 'holdings' })
        : skeletonLines(Math.min(rows.length + 1, 9)),
      note('Click a row to open that ticker. Options open on their contract in the chain.'),
    ),
  );
  if (!priced) return;

  // --- where the money really is
  const b = P.breakdown(valued.rows, m.profiles);
  const known = !!m.got.profiles;
  const split = (title, list, text, needsProfiles = true) =>
    panel(
      title,
      { cls: 's3 half' },
      needsProfiles && !known
        ? m.problems.profiles
          ? empty('Could not load what the holdings are.')
          : skeletonLines(6)
        : bars(list),
      text ? h('p', { class: 'note small' }, text) : null,
    );
  append(
    root,
    h('h3', { class: 'band', tip: 'lookthrough' }, 'Where the money really is'),
    split(
      'By sector',
      b.sector,
      'Each fund is spread over the sectors of what it holds, so a fund full of technology shares counts as technology.',
    ),
    split('By asset type', b.asset, 'Funds are split into the stocks, bonds and cash inside them.'),
    split(
      'By currency',
      b.currency,
      'The currency each holding trades in. A fund priced in Canadian dollars can still hold foreign shares.',
      false,
    ),
    split(
      'By country',
      b.country,
      'Where the companies you hold directly are based. Yahoo publishes no country split for funds, so they stay one line.',
    ),
  );
  const inside = P.lookThrough(valued.rows, m.profiles);
  if (known && inside.some(x => x.inFunds > 0))
    append(
      root,
      panel(
        'Largest single positions, counting what your funds hold',
        { cls: 'flush' },
        table(
          [
            {
              label: 'Company',
              cls: 'l',
              cell: x => [h('b', null, x.symbol), h('span', { class: 'muted' }, '  ' + x.name)],
            },
            { label: 'Held directly', cell: x => (x.direct ? F.money(x.direct) : '—') },
            { label: 'Inside funds', cell: x => (x.inFunds ? F.money(x.inFunds) : '—') },
            {
              label: 'Share of portfolio',
              tip: 'lookthrough',
              cell: x => [
                h('span', { class: 'wbar' }, h('i', { style: { width: Math.min(x.share * 100, 100) + '%' } })),
                F.pct(x.share),
              ],
            },
          ],
          inside,
        ),
        note(
          'Yahoo lists only the ten largest holdings of each fund, so the "inside funds" figures are a floor: the true amounts are a little higher. Funds that hold other funds are opened up too.',
        ),
      ),
    );

  // --- diversification
  append(root, h('h3', { class: 'band', tip: 'diversification' }, 'Diversification check'));
  const conc = P.concentration(valued.rows);
  const currencies = {
    ...Object.fromEntries(Object.values(m.quotes).map(q => [q.symbol, q.currency])),
    ...P.BENCHMARK_CURRENCY,
  };
  const risk = m.history
    ? P.riskModel(P.positions(valued.rows), m.history, { base: p.base, total: valued.total, currencies })
    : null;
  const waiting = !m.got.history && !m.problems.history;
  if (!conc) return append(root, empty('Nothing here has a value yet, so there is nothing to measure.'));

  const span = risk ? `${F.dateLong(risk.from)} to ${F.dateLong(risk.to)}` : '';
  const biggest = risk?.parts[0];
  const beta = label => risk?.betas[label]?.beta;
  const lines = [
    {
      k: 'Concentration',
      text: `${conc.largest.name} is your largest holding at ${F.pct(conc.largest.share, 0)} of the money${conc.count > 5 ? `, and the five largest make up ${F.pct(conc.top5, 0)}` : ''}. Counted by size, the ${F.plural(conc.count, 'holding')} act like ${F.num(conc.effective, 1)} equal ones.`,
    },
  ];
  if (risk) {
    const relief = risk.alone > 0 ? 1 - risk.vol / risk.alone : 0;
    const against = risk.parts.filter(x => x.weight < 0).map(x => x.symbol);
    lines.push({
      k: 'Swing',
      text: `From ${span}, this mix of holdings swung about ${F.pct(risk.vol, 0)} a year. The holdings' own swings, added up one by one, come to ${F.pct(risk.alone, 0)}. Their moves partly cancel, so holding them together took ${F.pct(relief, 0)} off.`,
    });
    if (risk.avgCorr != null)
      lines.push({
        k: 'Together',
        text:
          `On average the holdings you own outright moved together with a correlation of ${F.num(risk.avgCorr, 2)}. At 1 they would all rise and fall as one; at 0 they would be unrelated.` +
          (against.length
            ? ` ${against.join(', ')} ${against.length === 1 ? 'is' : 'are'} left out of this average: ${against.length === 1 ? 'it is' : 'they are'} held the other way round, gaining when the price falls.`
            : ''),
      });
    if (biggest?.share != null && risk.parts.length > 1)
      lines.push({
        k: 'Risk',
        text: `${biggest.symbol} is ${F.pct(biggest.weight, 0)} of the portfolio by size and ${F.pct(biggest.share, 0)} of its swing: it moved the portfolio more than anything else.`,
      });
    if (beta('S&P 500') != null)
      lines.push({
        k: 'Market',
        text: `For each 1% move in the S&P 500 the portfolio moved about ${F.num(beta('S&P 500'), 2)}%${beta('TSX') != null ? `, and about ${F.num(beta('TSX'), 2)}% for each 1% move in the TSX` : ''}. Both are measured in ${p.base}.`,
      });
    lines.push({
      k: 'Worst drop',
      text:
        risk.drawdown.depth < 0
          ? `The deepest fall in that stretch was ${F.pct(-risk.drawdown.depth)}, from ${F.dateLong(risk.drawdown.from)} to ${F.dateLong(risk.drawdown.to)}. The worst single day was ${F.signedPct(risk.worstDay.move, 1)}, on ${F.dateLong(risk.worstDay.date)}.`
          : 'This mix never closed below an earlier high in that stretch.',
    });
    if (risk.left.length)
      lines.push({
        k: 'Left out',
        tone: 'warn',
        text: `${risk.left.join(', ')} ${risk.left.length === 1 ? 'has' : 'have'} too little price history to measure, so these figures cover ${F.pct(risk.covered, 0)} of the portfolio.`,
      });
  }
  const pathChart = chart('short'),
    heat = chart('tall');
  append(
    root,
    panel(
      'What the numbers say',
      { cls: 's7' },
      h(
        'div',
        { class: 'stats fit' },
        stat('Largest holding', F.pct(conc.largest.share, 0), { sub: conc.largest.name, tip: 'weight' }),
        stat('Five largest', F.pct(conc.top5, 0), { tip: 'weight' }),
        stat('Acts like', F.num(conc.effective, 1), { sub: `equal holdings, of ${conc.count}`, tip: 'effholdings' }),
        stat('Yearly swing', risk ? F.pct(risk.vol, 0) : '…', { tip: 'portvol' }),
        stat('Own swings added', risk ? F.pct(risk.alone, 0) : '…', { sub: 'before they cancel', tip: 'portvol' }),
        stat('Avg correlation', risk?.avgCorr != null ? F.num(risk.avgCorr, 2) : risk ? '—' : '…', {
          tip: 'correlation',
        }),
        stat('Beta to S&P 500', beta('S&P 500') != null ? F.num(beta('S&P 500'), 2) : risk ? '—' : '…', {
          tip: 'beta',
        }),
        stat('Beta to TSX', beta('TSX') != null ? F.num(beta('TSX'), 2) : risk ? '—' : '…', { tip: 'beta' }),
        stat('Worst drop', risk ? F.pct(risk.drawdown.depth) : '…', {
          tone: risk?.drawdown.depth < 0 ? 'down' : '',
          tip: 'drawdown',
        }),
      ),
      story(lines),
      waiting ? skeletonLines(4) : null,
      !waiting && !risk
        ? empty(
            m.problems.history
              ? 'The price history did not arrive, so the swing could not be measured.'
              : 'None of the holdings has enough price history to measure how they move.',
          )
        : null,
      note(
        'These figures describe the past year with today’s holdings. They are not a forecast, and a calm year says little about a rough one. An option is counted as the shares it behaves like today, which changes as the price moves.',
      ),
    ),
    panel(
      'Size against share of risk',
      { cls: 's5 flush' },
      risk
        ? table(
            [
              {
                label: 'Holding',
                cls: 'l',
                cell: x => [
                  h('b', null, x.symbol),
                  x.option
                    ? tag('OPTION', 'This position includes an option, counted as the shares it behaves like.')
                    : null,
                ],
              },
              {
                label: 'Size',
                tiptext:
                  'Its share of the portfolio. An option counts as the shares it behaves like, which can be far more than it cost, and is negative when it gains from a fall.',
                cell: x => F.pct(x.weight, 0),
              },
              { label: 'Own swing', tip: 'portvol', cell: x => F.pct(x.vol, 0) },
              {
                label: 'Share of risk',
                tip: 'riskshare',
                cell: x => [
                  h(
                    'span',
                    { class: 'wbar' + (x.share < 0 ? ' neg' : '') },
                    h('i', { style: { width: Math.min(Math.abs(x.share) * 100, 100) + '%' } }),
                  ),
                  F.pct(x.share, 0),
                ],
              },
            ],
            risk.parts,
          )
        : waiting
          ? skeletonLines(6)
          : empty('Not available.'),
      note(
        'A holding that swings a lot, or moves with everything else, carries more of the risk than its share of the money. A negative share is a holding that steadied the rest.',
      ),
    ),
    panel(
      'Which holdings move together',
      { cls: 's6' },
      risk && risk.parts.length > 1
        ? heat
        : waiting
          ? skeletonLines(6)
          : empty('This needs at least two holdings with a year of prices.'),
      note(
        'Each square compares the prices of two tickers over the past year. Amber: they rose and fell together. Blue: one tended to rise when the other fell. Dark: little connection. An option appears as the ticker it is on.',
      ),
    ),
    panel(
      'This mix over the past year',
      { cls: 's6' },
      risk ? pathChart : waiting ? skeletonLines(6) : empty('Not available.'),
      note('How 100 held in today’s mix would have moved. The shaded stretch is the deepest fall from a high.'),
    ),
  );
  if (!risk) return;

  whenVisible(pathChart, () => {
    const level = risk.path.values.map(v => v * 100);
    const fall = risk.drawdown.depth < 0;
    plot(
      pathChart,
      [
        {
          type: 'scatter',
          mode: 'lines',
          x: risk.path.dates,
          y: level,
          line: { color: C.ink, width: 1.5 },
          hovertemplate: '%{x|%b %d, %Y}<br>%{y:.1f}<extra></extra>',
        },
      ],
      {
        margin: { l: 10, r: 44, t: 8, b: 26 },
        yaxis: { side: 'right' },
        hovermode: 'x',
        shapes: [
          {
            type: 'line',
            xref: 'paper',
            x0: 0,
            x1: 1,
            y0: 100,
            y1: 100,
            line: { color: C.axis, width: 1, dash: 'dot' },
          },
          ...(fall
            ? [
                {
                  type: 'rect',
                  yref: 'paper',
                  y0: 0,
                  y1: 1,
                  x0: risk.drawdown.from,
                  x1: risk.drawdown.to,
                  fillcolor: 'rgba(208,59,59,0.14)',
                  line: { width: 0 },
                },
              ]
            : []),
        ],
        annotations: fall
          ? [
              {
                x: risk.drawdown.to,
                yref: 'paper',
                y: 1,
                yanchor: 'top',
                xanchor: 'right',
                xshift: -4,
                text: `${F.pct(risk.drawdown.depth)} from the high`,
                showarrow: false,
                font: { size: 10.5, color: C.down },
              },
            ]
          : [],
      },
    );
  });

  if (risk.parts.length > 1)
    whenVisible(heat, () => {
      // The largest positions, in the order of the risk table, so the two panels read the same way.
      const order = risk.parts.slice(0, HEAT_MAX).map(x => risk.corr.symbols.indexOf(x.symbol));
      const labels = order.map(i => risk.corr.symbols[i].replace(/\.(TO|NE|V|CN)$/, ''));
      const z = order.map(i => order.map(j => risk.corr.matrix[i][j]));
      plot(
        heat,
        [
          {
            type: 'heatmap',
            x: labels,
            y: labels,
            z,
            zmin: -1,
            zmax: 1,
            colorscale: [
              [0, C.call],
              [0.5, '#151513'],
              [1, C.amber],
            ],
            xgap: 2,
            ygap: 2,
            showscale: false,
            hovertemplate: '%{y} and %{x}<br>correlation %{z:.2f}<extra></extra>',
          },
        ],
        {
          margin: { l: 64, r: 10, t: 8, b: 48 },
          xaxis: { type: 'category', tickangle: -45, showgrid: false },
          yaxis: { type: 'category', autorange: 'reversed', showgrid: false },
          annotations:
            labels.length <= 10
              ? z.flatMap((line, i) =>
                  line.map((v, j) => ({
                    x: labels[j],
                    y: labels[i],
                    text: i === j ? '' : F.num(v, 2),
                    showarrow: false,
                    font: { size: 10.5, color: Math.abs(v) > 0.55 ? '#000' : C.ink2 },
                  })),
                )
              : [],
        },
      );
    });
}

// Portfolio checks, run by tests.mjs. The holdings reader, the valuation, the breakdowns and the
// risk measures are checked offline on inputs whose right answers are known. When the local server
// is reachable, the sample portfolio is also priced and measured on live data.
import assert from 'node:assert/strict';
import * as P from './static/js/portfolio.js';

const BASE = process.env.TERMINAL_URL || 'http://127.0.0.1:8765';
const get = async path => {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(90000) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
};
const sum = list => list.reduce((a, b) => a + b, 0);

export async function run(test, close) {
  const HEAD = 'Account Name,Account Number,Symbol,Exchange,MIC,Name,Security Type,Quantity,Position Direction,';
  const HEADER = HEAD + 'Market Price,Market Price Currency,Book Value (CAD),Book Value (Market),Market Value';

  test('holdings file: the Wealthsimple layout is read and account numbers are not kept', () => {
    const { holdings, skipped, asOf } = P.readHoldings(P.SAMPLE);
    assert.equal(holdings.length, 9);
    assert.deepEqual(skipped, []);
    assert.equal(asOf, '2026-11-26');
    const by = raw => holdings.find(h => h.raw === raw);
    assert.deepEqual(
      { ...by('XEQT'), id: 0 },
      {
        id: 0,
        symbol: 'XEQT.TO',
        raw: 'XEQT',
        name: 'iShares Core Equity ETF Portfolio',
        kind: 'fund',
        qty: 420,
        currency: 'CAD',
        cost: 14700,
        costCAD: 14700,
        filePrice: 43.49,
        fileValue: 18265.8,
        account: 'TFSA',
        option: null,
      },
    );
    assert.deepEqual(
      [by('AAPL').symbol, by('AAPL').currency, by('AAPL').cost, by('AAPL').costCAD],
      ['AAPL', 'USD', 4000, 5600],
    );
    assert.deepEqual([by('BTC').symbol, by('BTC').kind, by('BTC').qty], ['BTC-CAD', 'crypto', 0.02]);
    const put = holdings.find(h => h.kind === 'option');
    assert.equal(put.symbol, 'SPY');
    assert.deepEqual(put.option, {
      underlying: 'SPY',
      expiry: '2027-12-17',
      strike: 600,
      put: true,
      occ: 'SPY271217P00600000',
    });
    assert.ok(!JSON.stringify(holdings).includes('SAMPLE000'), 'account numbers stay out of what is stored');
    assert.equal(new Set(holdings.map(h => h.id)).size, 9, 'every holding has its own id');
    for (const h of holdings) assert.deepEqual(P.cleanHolding(h), h, 'a holding survives being stored and read back');
  });

  test('holdings file: quotes, other separators, shorts and rows that cannot be used', () => {
    const file =
      '﻿' +
      [
        HEADER,
        '"TFSA","HQ1","BRK.B","NYSE","XNYS","Berkshire ""B"", Inc.","EQUITY","2.5","LONG","480.123456789","USD","1600.555555","1,200.50","$1,200.31"',
        '"TFSA","HQ1","TSLA","NASDAQ","XNAS","Tesla, Inc.","EQUITY","3","SHORT","400","USD","(1,650)","(1,200)","-1200"',
        '"TFSA","HQ1","","","","Cash","","","","","","","",""',
        '"TFSA","HQ1","GIC1","","","Some GIC","GUARANTEED_INVESTMENT","1","LONG","5000","CAD","5000","5000","5000"',
        '"TFSA","HQ1","NOQTY","TSX","XTSE","No quantity","EQUITY","0","LONG","1","CAD","0","0","0"',
        '',
        '"As of 2026-10-20 16:30 GMT-04:00"',
      ].join('\r\n');
    const { holdings, skipped, asOf } = P.readHoldings(file);
    assert.equal(asOf, '2026-10-20');
    assert.deepEqual(
      holdings.map(h => [h.symbol, h.kind, h.qty]),
      [
        ['BRK-B', 'stock', 2.5],
        ['TSLA', 'stock', -3],
        [null, 'other', 1],
      ],
    );
    assert.equal(holdings[0].name, 'Berkshire "B", Inc.');
    assert.deepEqual(
      [holdings[0].filePrice, holdings[0].cost, holdings[0].costCAD],
      [480.123456789, 1200.5, 1600.555555],
    );
    assert.deepEqual([holdings[1].cost, holdings[1].costCAD, holdings[1].fileValue], [-1200, -1650, -1200]);
    assert.deepEqual(
      skipped.map(s => s.reason),
      ['It has no symbol.', 'It has no quantity.'],
    );
    assert.deepEqual(
      skipped.map(s => s.text),
      ['Cash', 'NOQTY No quantity'],
      'a row left out is named without its account number',
    );

    // A list made by hand: tickers already written Yahoo's way, any reasonable column names, ; or tabs.
    for (const sep of [',', ';', '\t']) {
      const own = P.readHoldings(
        ['Ticker', 'Shares', 'Cost'].join(sep) +
          '\nSHOP.TO' +
          sep +
          '10' +
          sep +
          '900\nbrk-b' +
          sep +
          '2' +
          sep +
          '800\n',
      );
      assert.deepEqual(
        own.holdings.map(h => [h.symbol, h.qty, h.cost, h.kind]),
        [
          ['SHOP.TO', 10, 900, 'stock'],
          ['BRK-B', 2, 800, 'stock'],
        ],
      );
    }
    assert.equal(P.readHoldings('Symbol,Qty\nGEMI261204P00002000,12').holdings[0].kind, 'option');
    assert.throws(() => P.readHoldings('Date,Amount\n2026-01-01,5'), /does not look like a list of holdings/);
    assert.throws(() => P.readHoldings(''), /does not look like/);
    assert.deepEqual(P.readHoldings('Symbol,Quantity\n').holdings, []);
    assert.deepEqual(P.parseCsv('a,"b\nc",d\n\n'), [['a', 'b\nc', 'd']]);
  });

  test('tickers are rewritten the way Yahoo writes them', () => {
    const y = (raw, exchange, mic, more) => P.yahooSymbol(raw, { exchange, mic, ...more });
    assert.equal(y('SHOP', 'TSX', 'XTSE'), 'SHOP.TO');
    assert.equal(y('RCI.B', 'TSX', 'XTSE'), 'RCI-B.TO');
    assert.equal(y('CAR.UN', '', 'XTSE'), 'CAR-UN.TO');
    assert.equal(y('BCE.PR.A', 'TSX', ''), 'BCE-PA.TO');
    assert.equal(y('ABC', 'TSX-V', 'XTSX'), 'ABC.V');
    assert.equal(y('ABC', 'TSXV', ''), 'ABC.V');
    assert.equal(y('AAPL', 'NEO', 'NEOE'), 'AAPL.NE');
    assert.equal(y('XYZ', 'CSE', 'XCNQ'), 'XYZ.CN');
    assert.equal(y('BRK.B', 'NYSE', 'XNYS'), 'BRK-B');
    assert.equal(y('AAPL', 'NASDAQ', 'XNAS'), 'AAPL');
    assert.equal(y('BTC', '', '', { kind: 'crypto', currency: 'CAD' }), 'BTC-CAD');
    assert.equal(y('ETH', '', '', { kind: 'crypto', currency: 'USD' }), 'ETH-USD');
    assert.equal(y('BTC-USD', '', '', { kind: 'crypto', currency: 'CAD' }), 'BTC-USD');
    assert.equal(y('shop.to', '', ''), 'SHOP.TO', 'no exchange given: already Yahoo spelling');
    assert.equal(y('NOT A TICKER!', 'TSX', 'XTSE'), null);
    assert.equal(y('', 'TSX', 'XTSE'), null);

    const occ = { underlying: 'GEMI', expiry: '2026-12-04', strike: 2, put: true, occ: 'GEMI261204P00002000' };
    assert.deepEqual(P.parseOption('GEMI261204P00002000'), occ);
    assert.deepEqual(P.parseOption('gemi 261204p00002000'), occ);
    assert.deepEqual(P.parseOption('Put on GEMI 261204P00002000 (12 contracts)'), occ);
    assert.equal(P.parseOption('GEMI1261204C00001500').underlying, 'GEMI1');
    assert.equal(P.parseOption('SPXW261120C07335000').strike, 7335);
    assert.equal(P.parseOption('GEMI261304P00002000'), null, 'month 13 is not a date');
    assert.equal(P.parseOption('GEMI Dec 4 2026 $2 put'), null, 'a description is not guessed at');
    assert.equal(P.parseOption('XGEMI2612041P00002000'), null);
    assert.equal(P.makeOption('GEMI', '2026-02-30', 2, true), null);
    assert.equal(P.makeOption('GEMI', '2026-12-04', 0, true), null);
    assert.equal(P.cleanHolding({ id: 'x', raw: 'AAPL', symbol: 'AAPL', kind: 'stock', qty: 0 }), null);
    assert.equal(P.cleanHolding({ id: 'x', raw: 'AAPL', symbol: 'A B', kind: 'stock', qty: 1 }), null);
    assert.equal(P.cleanHolding({ id: 'x', raw: 'AAPL', symbol: 'AAPL', kind: 'house', qty: 1 }), null);
    assert.equal(P.cleanHolding({ id: 'x', raw: 'AAPL', kind: 'stock', qty: 1, name: 5, cost: 'a lot' }).cost, null);
  });

  const stock = (id, symbol, qty, more = {}) => ({
    id,
    symbol,
    raw: symbol,
    name: symbol,
    kind: 'stock',
    qty,
    ...more,
  });
  test('valuation: the same holdings in Canadian and in US dollars', () => {
    const holdings = [
      stock('a', 'AAPL', 10, { currency: 'USD', cost: 1000, costCAD: 1350 }),
      stock('x', 'XEQT.TO', 100, { kind: 'fund', currency: 'CAD', cost: 3000, costCAD: 3000 }),
    ];
    const quotes = {
      AAPL: { price: 200, changePct: 1, currency: 'USD' },
      'XEQT.TO': { price: 40, changePct: -2, currency: 'CAD' },
    };
    const cad = P.valuePortfolio(holdings, { quotes, usdcad: 1.4, usdcadChangePct: 0 }, 'CAD');
    close(cad.total, 2800 + 4000, 1e-9, 'total in CAD');
    close(cad.rows[0].weight, 2800 / 6800, 1e-12, 'weight');
    close(cad.rows[0].gainBase, 2800 - 1350, 1e-9, 'a US share held from Canada gains against its Canadian cost');
    close(cad.gain, 1450 + 1000, 1e-9, 'total gain');
    close(cad.gainPct, 2450 / 4350, 1e-12, 'gain as a share of cost');
    const up = (2000 - 2000 / 1.01) * 1.4,
      down = 4000 - 4000 / 0.98;
    close(cad.rows[0].dayBase, up, 1e-9, "one day's change of the US share, in CAD");
    close(cad.day, up + down, 1e-9, "the day's change");
    close(cad.dayPct, (up + down) / (6800 - up - down), 1e-12, "the day's change in percent");
    assert.ok(cad.rows.every(r => r.live));

    const usd = P.valuePortfolio(holdings, { quotes, usdcad: 1.4, usdcadChangePct: 0 }, 'USD');
    close(usd.total, 2000 + 4000 / 1.4, 1e-9, 'total in USD');
    close(usd.rows[0].gainBase, 1000, 1e-9, 'in US dollars the US cost is the one that counts');
    close(usd.rows[1].costBase, 3000 / 1.4, 1e-9, 'a Canadian cost converted at the current rate');
    close(usd.total * 1.4, cad.total, 1e-9, 'both totals are the same money');

    // The exchange rate moving is part of the day's change of a holding in the other currency.
    const flat = { AAPL: { price: 200, changePct: 0, currency: 'USD' } };
    const moved = P.valuePortfolio([holdings[0]], { quotes: flat, usdcad: 1.4, usdcadChangePct: 1 }, 'CAD');
    close(moved.day, 2800 - 2000 * (1.4 / 1.01), 1e-9, 'a flat US share still gains in CAD when the US dollar rises');
    close(
      P.valuePortfolio([holdings[0]], { quotes: flat, usdcad: 1.4, usdcadChangePct: 1 }, 'USD').day,
      0,
      1e-12,
      'flat',
    );

    // No live price: the file's price is used and the row says so. No exchange rate: no value at all.
    const stale = P.valuePortfolio([stock('s', 'OLD.TO', 5, { currency: 'CAD', filePrice: 12, cost: 50 })], {}, 'CAD');
    assert.deepEqual([stale.total, stale.rows[0].live, stale.day, stale.gain], [60, false, null, 10]);
    const fromValue = P.valuePortfolio([stock('s', 'OLD.TO', 5, { currency: 'CAD', fileValue: 55 })], {}, 'CAD');
    close(fromValue.total, 55, 1e-9, 'value from the file when it gives no price');
    const euro = P.valuePortfolio(
      [stock('e', 'SAP.DE', 1, { currency: 'EUR', filePrice: 100 })],
      { usdcad: 1.4 },
      'CAD',
    );
    assert.equal(euro.rows[0].valueBase, null);
    assert.match(euro.rows[0].why, /EUR/);
    assert.equal(euro.total, 0);
    const noRate = P.valuePortfolio([holdings[0]], { quotes }, 'CAD');
    assert.equal(noRate.rows[0].valueBase, null, 'a US holding cannot be shown in CAD without the rate');
    assert.deepEqual(P.valuePortfolio([], {}, 'CAD').rows, []);
  });

  test('valuation: an option is worth its price and behaves like shares', () => {
    const option = P.makeOption('ABC', '2030-06-21', 100, true);
    const holding = {
      id: 'o',
      symbol: 'ABC',
      raw: option.occ,
      name: 'ABC put',
      kind: 'option',
      qty: 2,
      currency: 'USD',
      cost: 600,
      option,
    };
    const chain = { [option.occ]: { mark: 2.5, chg: 0.1, delta: -0.4, theta: -0.01, spot: 100, iv: 0.3 } };
    const now = Date.UTC(2026, 10, 26, 18) / 1000;
    const v = P.valuePortfolio([holding], { options: chain, usdcad: 1.4, usdcadChangePct: 0 }, 'CAD', now);
    const row = v.rows[0];
    close(row.value, 2 * 2.5 * 100, 1e-9, 'two contracts of 100 shares');
    close(row.valueBase, 500 * 1.4, 1e-9, 'in CAD');
    close(row.shares, -80, 1e-9, 'two puts of -0.40 delta behave like 80 shares sold');
    close(row.exposureBase, -80 * 100 * 1.4, 1e-9, 'which is this much stock');
    close(row.thetaBase, -0.01 * 100 * 2 * 1.4, 1e-9, 'time decay per day');
    close(row.dayBase, 0.1 * 100 * 2 * 1.4, 1e-9, "the day's change");
    close(row.gainBase, 700 - 600 * 1.4, 1e-9, 'gain');
    assert.equal(row.iv, 0.3);

    // No chain: the file's price values it, and it is left out of the risk maths.
    const offline = P.valuePortfolio([{ ...holding, filePrice: 3 }], { usdcad: 1.4 }, 'CAD', now).rows[0];
    assert.deepEqual([offline.value, offline.live, offline.exposureBase, offline.shares], [600, false, null, null]);
    assert.deepEqual(P.positions([offline]), []);

    // The day after it expires it has no value, whatever the file said.
    const later = Date.UTC(2030, 5, 22, 18) / 1000;
    const gone = P.valuePortfolio([{ ...holding, filePrice: 3 }], { options: chain, usdcad: 1.4 }, 'CAD', later);
    assert.deepEqual([gone.rows[0].valueBase, gone.rows[0].why, gone.total], [null, 'It has expired.', 0]);
    const lastDay = Date.UTC(2030, 5, 21, 18) / 1000;
    assert.equal(P.valuePortfolio([holding], { options: chain, usdcad: 1.4 }, 'CAD', lastDay).rows[0].live, true);
  });

  const row = (symbol, kind, valueBase, more = {}) => ({
    id: symbol,
    symbol,
    name: symbol,
    kind,
    currency: 'CAD',
    valueBase,
    exposureBase: valueBase,
    ...more,
  });
  test('where the money is: funds are opened up and every split adds up', () => {
    const rows = [
      row('FUND.TO', 'fund', 1000),
      row('SHOP.TO', 'stock', 500),
      row('BTC-CAD', 'crypto', 300),
      row('SPY', 'option', 200, { currency: 'USD' }),
      row('MYSTERY', 'stock', 100, { currency: 'USD' }),
      row('GONE', 'stock', null),
    ];
    const profiles = {
      'FUND.TO': {
        type: 'ETF',
        assets: { Stocks: 0.6, Bonds: 0.4, Cash: 0, Other: 0 },
        sectors: { Technology: 0.25, Energy: 0.25 }, // Yahoo's sector shares need not add up to 1
        top: [
          ['SHOP.TO', 'Shopify', 0.1],
          ['RY.TO', 'Royal Bank', 0.05],
        ],
      },
      'SHOP.TO': { type: 'EQUITY', sector: 'Technology', country: 'Canada' },
      'BTC-CAD': { type: 'CRYPTOCURRENCY' },
      SPY: { type: 'ETF', assets: { Stocks: 1 }, sectors: { Technology: 1 } }, // the option's underlying
    };
    const b = P.breakdown(rows, profiles);
    const as = list => Object.fromEntries(list.map(x => [x.label, Math.round(x.value * 1e6) / 1e6]));
    assert.deepEqual(as(b.sector), {
      Technology: 800,
      Bonds: 400,
      Energy: 300,
      Crypto: 300,
      Options: 200,
      Unknown: 100,
    });
    assert.deepEqual(as(b.asset), { Stocks: 1200, Bonds: 400, Crypto: 300, Options: 200 });
    assert.deepEqual(as(b.country), { 'Inside funds': 1000, Canada: 500, Crypto: 300, Options: 200, Unknown: 100 });
    assert.deepEqual(as(b.currency), { CAD: 1800, USD: 300 });
    for (const list of Object.values(b)) {
      close(sum(list.map(x => x.value)), 2100, 1e-9, 'each split covers the whole portfolio');
      close(sum(list.map(x => x.share)), 1, 1e-12, 'and its shares add up to 1');
      assert.deepEqual(
        list.map(x => x.value),
        list.map(x => x.value).sort((p, q) => q - p),
        'largest first',
      );
    }
    // A fund Yahoo says nothing about stays one block rather than being guessed at.
    const blind = P.breakdown([row('ODD.TO', 'fund', 50)], {});
    assert.deepEqual(as(blind.sector), { 'Funds, contents unknown': 50 });
    assert.deepEqual(as(blind.asset), { 'Funds, contents unknown': 50 });
    // The file may call something a stock that Yahoo knows to be a fund: Yahoo's word wins.
    const renamed = P.breakdown([row('FUND.TO', 'stock', 100)], profiles);
    assert.deepEqual(as(renamed.asset), { Stocks: 60, Bonds: 40 });

    // The biggest single positions once funds are opened up. A fund's list may name a company by
    // its US or its Canadian ticker; the same ticker with another name is another company.
    const held = [
      row('BIG.TO', 'fund', 1000),
      row('SHOP.TO', 'stock', 500, { name: 'Shopify Inc.' }),
      row('AAPL.NE', 'stock', 50, { name: 'Apple CDR (CAD Hedged)' }),
      row('T.TO', 'stock', 80, { name: 'TELUS Corporation' }),
      row('TD.TO', 'stock', 40, { name: 'The Toronto-Dominion Bank' }),
      row('SPY', 'option', 200),
      row('GONE', 'stock', null),
    ];
    const top = [
      ['SHOP', 'Shopify Inc Registered Shs -A- Subord Vtg', 0.1],
      ['AAPL', 'Apple Inc', 0.2],
      ['T', 'AT&T Inc', 0.05],
      ['TD', 'Toronto-Dominion Bank', 0.03],
      ['RY', 'Royal Bank of Canada', 0.02],
      ['', 'No ticker', 0.5],
    ];
    const inside = P.lookThrough(held, { 'BIG.TO': { type: 'ETF', top }, SPY: { type: 'ETF', top } });
    assert.deepEqual(
      inside.map(x => [x.symbol, x.direct, x.inFunds]),
      [
        ['SHOP.TO', 500, 100],
        ['AAPL.NE', 50, 200],
        ['T.TO', 80, 0],
        ['TD.TO', 40, 30],
        ['T', 0, 50],
        ['RY', 0, 20],
      ],
    );
    close(inside[0].share, 600 / 1870, 1e-12, 'held directly plus through the fund, as a share of everything');
    assert.equal(P.lookThrough(held, {}, 2).length, 2, 'the list can be cut short');
  });

  test('concentration: a few big holdings count for more than many small ones', () => {
    const c = P.concentration([
      row('A', 'stock', 400),
      row('A', 'stock', 300, { id: 'second lot' }),
      row('B', 'stock', 100),
      row('C', 'fund', 100),
      row('D', 'stock', 100),
      row('E', 'stock', null),
      row('F', 'stock', -50),
    ]);
    assert.equal(c.count, 4, 'two lots of one ticker are one holding');
    close(c.largest.share, 0.7, 1e-12, 'largest');
    close(c.effective, 1 / (0.49 + 3 * 0.01), 1e-12, 'ten percent slices barely count');
    close(c.top5, 1, 1e-12, 'top five');
    const even = P.concentration(Array.from({ length: 8 }, (_, i) => row('S' + i, 'stock', 10)));
    close(even.effective, 8, 1e-9, 'equal holdings count in full');
    close(even.top5, 5 / 8, 1e-12, 'top five of eight');
    assert.equal(P.concentration([]), null);
  });

  test('risk: made-up price paths with known answers', () => {
    const n = 201;
    const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    const path = moves => moves.reduce((prices, r) => [...prices, prices.at(-1) * (1 + r)], [100]);
    const flip = Array.from({ length: n - 1 }, (_, t) => (t % 2 ? -0.01 : 0.01)); // up, down, up, down
    const pairs = Array.from({ length: n - 1 }, (_, t) => (t % 4 < 2 ? 0.01 : -0.01)); // up, up, down, down
    const closes = {
      A: path(flip),
      SAME: path(flip),
      AGAINST: path(flip.map(r => -r)),
      OTHER: path(pairs),
      DOUBLE: path(flip.map(r => 2 * r)),
      NEW: [...Array(n - 30).fill(null), ...path(flip).slice(0, 30)],
    };
    const history = { dates, closes };
    const pos = (symbol, exposure) => ({ symbol, name: symbol, exposure });
    const model = (positions, opts) =>
      P.riskModel(positions, history, { total: 100, benchmarks: { market: 'A' }, ...opts });
    const sd = 0.01 * Math.sqrt((n - 1) / (n - 2)) * Math.sqrt(252); // the yearly swing of a +/-1% a day path

    const one = model([pos('A', 100)]);
    close(one.vol, sd, 1e-12, 'one holding: its own volatility');
    assert.deepEqual([one.days, one.from, one.to], [200, dates[0], dates[200]]);
    close(one.parts[0].share, 1, 1e-12, 'and all of the risk');
    assert.equal(one.avgCorr, null);

    const same = model([pos('A', 50), pos('SAME', 50)]);
    close(same.corr.matrix[0][1], 1, 1e-12, 'two holdings that move in step');
    close(same.vol, sd, 1e-12, 'give no relief');
    close(same.alone, same.vol, 1e-12, 'so the portfolio swings as much as its parts');
    close(same.avgCorr, 1, 1e-12, 'average correlation');

    const hedged = model([pos('A', 50), pos('AGAINST', 50)]);
    close(hedged.corr.matrix[0][1], -1, 1e-12, 'two holdings that move opposite');
    close(hedged.vol, 0, 1e-7, 'cancel out'); // a square root of rounding noise, so not exactly zero
    close(hedged.alone, sd, 1e-12, 'though each still swings');

    const mixed = model([pos('A', 50), pos('OTHER', 50)]);
    close(mixed.corr.matrix[0][1], 0, 1e-12, 'two holdings that move independently');
    close(mixed.vol, sd / Math.sqrt(2), 1e-12, 'cut the swing by the square root of two');
    close(mixed.parts[0].share, 0.5, 1e-12, 'and share the risk equally');
    close(sum(mixed.parts.map(p => p.share)), 1, 1e-12, 'shares of risk add up to 1');

    const uneven = model([pos('A', 50), pos('DOUBLE', 50)]);
    assert.equal(uneven.parts[0].symbol, 'DOUBLE', 'the holding that swings more is listed first');
    close(uneven.parts[0].share, 2 / 3, 1e-12, 'half the money, two thirds of the risk');
    close(uneven.parts[0].vol, 2 * sd, 1e-12, 'its own volatility');
    close(uneven.parts[0].weight, 0.5, 1e-12, 'its weight');

    // Betas: twice the money on the market is beta 2, half of it is 0.5, the opposite path is -1.
    close(model([pos('A', 200)]).betas.market.beta, 2, 1e-12, 'beta of a doubled position');
    close(model([pos('A', 50)]).betas.market.beta, 0.5, 1e-12, 'beta with half in cash');
    close(model([pos('AGAINST', 100)]).betas.market.beta, -1, 1e-12, 'beta of the opposite path');
    close(model([pos('AGAINST', 100)]).betas.market.corr, -1, 1e-12, 'its correlation');
    assert.equal(model([pos('A', 100)], { benchmarks: { missing: 'NOPE', young: 'NEW' } }).betas.missing, null);
    assert.equal(model([pos('A', 100)], { benchmarks: { young: 'NEW' } }).betas.young, null);

    // A put on a share already held: positions() nets them, so the swing shrinks with the exposure.
    const net = P.positions([
      row('A', 'stock', 100),
      row('A', 'option', 5, { id: 'put', exposureBase: -40 }),
      row('NOCHAIN', 'option', 5, { exposureBase: null }),
      row(null, 'other', 20),
    ]);
    assert.deepEqual(net, [{ symbol: 'A', name: 'A', exposure: 60, option: true }]);
    assert.equal(P.positions([row('A', 'stock', 100)])[0].option, false);
    close(model(net).vol, 0.6 * sd, 1e-12, 'a hedge lowers the swing');

    // Too little history: left out, and said so.
    const young = model([pos('A', 75), pos('NEW', 25), pos('NOPE', 0)]);
    assert.deepEqual([young.left, young.parts.length], [['NEW', 'NOPE'], 1]);
    close(young.covered, 0.75, 1e-12, 'share of the exposure that is measured');
    assert.equal(model([pos('NEW', 100)]), null);
    assert.equal(model([]), null);
    assert.equal(P.riskModel([pos('A', 100)], history, { total: 0 }), null);
    assert.equal(P.riskModel([pos('A', 100)], null, { total: 100 }), null);

    // The deepest fall from a high, and the worst single day.
    const fall = { dates: dates.slice(0, 6), closes: { X: [100, 110, 99, 88, 92.4, 120] } };
    const dd = P.riskModel([pos('X', 100)], fall, { total: 100, minDays: 3, benchmarks: {} });
    close(dd.drawdown.depth, 88 / 110 - 1, 1e-12, 'peak to trough');
    assert.deepEqual([dd.drawdown.from, dd.drawdown.to], [dates[1], dates[3]]);
    assert.equal(dd.worstDay.date, dates[3]);
    close(dd.worstDay.move, 88 / 99 - 1, 1e-12, 'worst day');
    close(dd.path.values.at(-1), 1.2, 1e-12, 'growth of 1');
    assert.equal(dd.path.dates.length, dd.path.values.length);
    const rising = { dates: dates.slice(0, 5), closes: { X: [1, 2, 3, 4, 5] } };
    assert.equal(P.riskModel([pos('X', 100)], rising, { total: 100, minDays: 3, benchmarks: {} }).drawdown.depth, 0);

    // A US share that never moves in US dollars still moves for a Canadian holder with the exchange rate.
    const fx = { dates, closes: { USFLAT: Array(n).fill(50), [P.FX]: path(flip).map(p => p / 100 + 0.4) } };
    const opts = { total: 100, currencies: { USFLAT: 'USD' }, benchmarks: {} };
    close(P.riskModel([pos('USFLAT', 100)], fx, { ...opts, base: 'USD' }).vol, 0, 1e-7, 'flat in its own currency');
    assert.ok(P.riskModel([pos('USFLAT', 100)], fx, { ...opts, base: 'CAD' }).vol > 0.05, 'not flat from Canada');
    assert.equal(
      P.riskModel([pos('USFLAT', 100)], { dates, closes: { USFLAT: fx.closes.USFLAT } }, { ...opts, base: 'CAD' }),
      null,
    );
  });

  // ---- live: the sample portfolio priced and measured on real data
  let live = true;
  try {
    await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(20000) });
  } catch {
    live = false;
  }
  if (!live) {
    console.log('--  server not running: skipped live portfolio checks');
    return;
  }
  const { holdings } = P.readHoldings(P.SAMPLE);
  const symbols = [...new Set(holdings.map(h => h.symbol).filter(Boolean))];
  const list = symbols.map(encodeURIComponent).join(',');
  const { quotes } = await get(`/api/quotes?symbols=${list},${encodeURIComponent(P.FX)}`);
  const { profiles } = await get('/api/profiles?symbols=' + list);
  const marks = [P.FX, ...Object.values(P.BENCHMARKS)].map(encodeURIComponent).join(',');
  const history = await get(`/api/closes?symbols=${list},${marks}&range=1Y`);
  const bySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
  const known = Object.fromEntries(profiles.map(p => [p.symbol, p]));
  const market = { quotes: bySymbol, usdcad: bySymbol[P.FX].price, usdcadChangePct: bySymbol[P.FX].changePct };
  const valued = P.valuePortfolio(holdings, market, 'CAD');

  test(`live sample: every holding is priced (${symbols.length} tickers, total C$${Math.round(valued.total)})`, () => {
    assert.ok(market.usdcad > 1 && market.usdcad < 2, `a believable exchange rate, got ${market.usdcad}`);
    for (const r of valued.rows) {
      assert.ok(r.valueBase > 0, `${r.holding.raw} has a value`);
      if (r.kind !== 'option') assert.ok(r.live, `${r.symbol} has a live price`);
      if (r.kind !== 'option') assert.equal(r.currency, bySymbol[r.symbol].currency);
    }
    assert.deepEqual([bySymbol['XEQT.TO'].currency, bySymbol.AAPL.currency], ['CAD', 'USD']);
    close(sum(valued.rows.map(r => r.weight)), 1, 1e-9, 'weights add up to 1');
    assert.ok(Math.abs(valued.dayPct) < 0.2, 'a believable day');
  });

  test('live sample: funds are opened up, and the splits add up', () => {
    for (const s of symbols) assert.ok(known[s] && !known[s].error, `${s}: ${known[s]?.error}`);
    assert.equal(known.AAPL.sector, 'Technology');
    assert.equal(known['SHOP.TO'].country, 'Canada');
    const fund = known['XEQT.TO'];
    close(sum(Object.values(fund.sectors)), 1, 0.06, 'a stock fund is fully split by sector');
    close(sum(Object.values(fund.assets)), 1, 0.03, 'and by asset type');
    assert.ok(fund.top.length >= 3 && fund.top.every(([symbol, name, weight]) => symbol && name && weight > 0));
    assert.ok(known['ZAG.TO'].assets.Bonds > 0.9, 'a bond fund is bonds');
    const b = P.breakdown(valued.rows, known);
    for (const list of Object.values(b)) close(sum(list.map(x => x.share)), 1, 1e-9, 'shares add up to 1');
    const label = name => b.sector.find(x => x.label === name)?.share || 0;
    assert.ok(
      label('Technology') > 0.1 && label('Bonds') > 0.02 && label('Crypto') > 0.005,
      'the expected sectors appear',
    );
    assert.ok(!b.sector.some(x => /unknown/i.test(x.label)), `nothing unknown: ${b.sector.map(x => x.label)}`);
    assert.deepEqual(b.currency.map(x => x.label).sort(), ['CAD', 'USD']);
    const inside = P.lookThrough(valued.rows, known);
    console.log(
      '      sectors: ' +
        b.sector
          .slice(0, 5)
          .map(x => `${x.label} ${(x.share * 100).toFixed(0)}%`)
          .join(', ') +
        ' | largest inside: ' +
        inside
          .slice(0, 3)
          .map(x => `${x.symbol} ${(x.share * 100).toFixed(1)}%`)
          .join(', '),
    );
    const nvda = inside.find(x => x.symbol === 'NVDA');
    assert.ok(nvda.direct > 0 && nvda.inFunds > 0, 'NVDA is held directly and inside the S&P 500 fund');
  });

  test('live sample: a year of prices gives believable risk numbers', () => {
    assert.ok(history.dates.length > 200, `about a year of weekdays, got ${history.dates.length}`);
    for (const [symbol, series] of Object.entries(history.closes)) {
      assert.equal(series.length, history.dates.length, `${symbol} is on the shared calendar`);
      assert.ok(series.at(-1) > 0, `${symbol} has a last close`);
      assert.ok(!series.slice(series.findIndex(p => p != null)).includes(null), `${symbol} has no gaps`);
    }
    assert.ok(
      history.dates.every(d => ![0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())),
      'weekdays only',
    );
    const currencies = {
      ...Object.fromEntries(quotes.map(q => [q.symbol, q.currency])),
      '^GSPC': 'USD',
      '^GSPTSE': 'CAD',
    };
    const risk = P.riskModel(P.positions(valued.rows), history, { base: 'CAD', total: valued.total, currencies });
    console.log(
      `      swing ${(risk.vol * 100).toFixed(1)}% a year (${(risk.alone * 100).toFixed(1)}% if all moved in step), ` +
        `worst drop ${(risk.drawdown.depth * 100).toFixed(1)}% from ${risk.drawdown.from} to ${risk.drawdown.to}, ` +
        `beta S&P ${risk.betas['S&P 500'].beta.toFixed(2)} TSX ${risk.betas.TSX.beta.toFixed(2)}, ` +
        `most risk: ${risk.parts
          .slice(0, 3)
          .map(p => `${p.symbol} ${(p.share * 100).toFixed(0)}%`)
          .join(', ')}`,
    );
    assert.ok(risk.vol > 0.03 && risk.vol < 0.8, `yearly swing ${risk.vol}`);
    assert.ok(risk.vol <= risk.alone + 1e-12, 'the whole never swings more than its parts in step');
    close(sum(risk.parts.map(p => p.share)), 1, 1e-9, 'shares of risk add up to 1');
    assert.ok(risk.drawdown.depth <= 0 && risk.drawdown.depth > -0.9, `worst drop ${risk.drawdown.depth}`);
    assert.ok(risk.betas['S&P 500'].beta > 0.2 && risk.betas['S&P 500'].beta < 2.5, 'beta to the S&P 500');
    assert.ok(risk.days > 150 && risk.covered > 0.95, `measured over ${risk.days} days, covering ${risk.covered}`);
    for (const line of risk.corr.matrix)
      for (const c of line) assert.ok(c >= -1.0000001 && c <= 1.0000001, 'a correlation');
  });
}

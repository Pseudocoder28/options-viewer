// Plain-English readings of the data. Every function returns plain strings (never HTML).
//
// Two rules keep these sentences true for every contract, not only the everyday ones:
//   - Dollar effects are repriced with the model, never extended in a straight line from a Greek.
//     A straight line is fine for a small move a month out; near expiry it promises gains and
//     losses that cannot happen.
//   - Nothing is called "usual" or "unusual", "cheap" or "expensive": the app measures today's
//     numbers, not what is normal for this ticker.
import * as F from './fmt.js';
import * as M from './model.js';
import * as Q from './quant.js';

/** The typical (one standard deviation) price range by an expiry. */
const range = e => M.moveRange(e.F, e.atmIV, e.T);
/**
 * A round stock move near 2.5% of the price ($0.05 on a $1.40 stock, $10 on a $350 one),
 * used to turn Greeks into dollars.
 */
export function niceMove(S) {
  const target = Math.log(S * 0.025);
  return [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].reduce((a, b) =>
    Math.abs(Math.log(b) - target) < Math.abs(Math.log(a) - target) ? b : a,
  );
}
/** Expiry date for a sentence: the year is spelled out once it is far enough away to be ambiguous. */
const dated = e => (e.days > 300 ? F.dateLong(e.date) : F.date(e.date));
/** First expiry at least minDays away that has its own volatility reading. */
export const anchorExpiry = (chain, minDays = 5) =>
  chain.expiries.find(e => e.days >= minDays && e.atmIV != null && e.smileSrc === 'quotes') ||
  chain.expiries.find(e => e.atmIV != null) ||
  null;
/**
 * True when the options of this expiry follow a forward (futures) price well away from the quoted
 * price, as VIX options do. Comparisons with the quoted price need different words then.
 */
const offForward = e => Math.abs(e.basis - 1) > 0.02;
/** Why an expiry's volatility is not a measurement, as a clause for a sentence ('' when it is one). */
const roughVol = e =>
  e.smileSrc === 'borrowed'
    ? ' (borrowed from the nearest expiry, because no quote near the money in this one is good enough to measure it)'
    : e.smileSrc === 'wing'
      ? ' (a rough guess: the only usable quotes are far from the money)'
      : '';

/** The overview: what the whole chain says, as { k: label, text, tone } items. */
export function chainStory(chain, quote, hv) {
  const out = [],
    sym = quote.symbol.replace('^', '');
  const e = anchorExpiry(chain);
  if (!e)
    return [
      {
        k: 'No readings',
        text: 'None of the listed options has a usable quote right now, so volatility and expected moves cannot be measured.',
        tone: 'warn',
      },
    ];
  if (!chain.ivMeasured)
    out.push({
      k: 'Thin quotes',
      tone: 'warn',
      text:
        'No option near the money has a usable quote right now, so every volatility here is a rough guess read from far-away strikes. ' +
        'Treat the numbers built on it (expected move, Greeks, odds) as approximate.',
    });
  const [lo, hi] = range(e);
  out.push({
    k: 'Expected move',
    text:
      `Options are pricing a move of about ±${F.usd(e.em)} (${F.pct(e.em / e.F)}) by ${F.date(e.date)}, ${F.days(e.days)} away. ` +
      `That makes ${F.usd(lo)} to ${F.usd(hi)} the typical range` +
      (offForward(e)
        ? `, centred on the forward price of ${F.usd(e.F)} that these options trade off rather than on ${sym} itself`
        : '') +
      ': prices land inside a range like this about two times in three.',
  });

  if (chain.iv30 != null) {
    let text = `30-day implied volatility is ${F.iv(chain.iv30)} a year, which works out to typical daily moves of about ${F.pct(chain.iv30 / Math.sqrt(252))}. `;
    if (hv?.d20 != null) {
      const ratio = chain.iv30 / hv.d20;
      text +=
        `Over the last 20 trading days ${sym} actually moved at ${F.iv(hv.d20)}. ` +
        (offForward(e)
          ? `These options follow the future for each expiry rather than ${sym} itself, so the two figures are not directly comparable.`
          : ratio > 1.2
            ? 'Options are pricing in clearly more movement than the stock has recently delivered.'
            : ratio < 0.83
              ? 'Options are pricing in less movement than the stock has recently delivered.'
              : 'That is close to what options are pricing.');
    }
    out.push({ k: 'Volatility', text });
  }

  const skewExp = chain.expiries.find(x => x.days >= 7 && x.smile?.length >= 3) || null;
  const rr = skewExp && M.riskReversal(skewExp, chain.rate);
  if (rr) {
    const p = F.iv(rr.put.iv),
      c = F.iv(rr.call.iv);
    out.push({
      k: 'Skew',
      text:
        rr.rr < -0.02
          ? `Downside puts trade at higher volatility (${p}) than upside calls (${c}) for ${dated(skewExp)}. Traders are paying extra for protection against a drop.`
          : rr.rr > 0.02
            ? `Upside calls trade at higher volatility (${c}) than downside puts (${p}) for ${dated(skewExp)}. Traders are paying extra for a sharp rise.`
            : `Puts (${p}) and calls (${c}) an equal distance from the price carry about the same volatility for ${dated(skewExp)}: no strong lean either way.`,
    });
  }

  const ts = M.termStructure(chain);
  if (ts.length >= 2) {
    const near = ts.find(x => x.days >= 5) || ts[0],
      far = ts[ts.length - 1];
    if (far !== near)
      out.push({
        k: 'Term structure',
        text:
          near.atmIV > far.atmIV * 1.1
            ? `Near-dated options (${dated(near)}: ${F.iv(near.atmIV)}) carry higher volatility than long-dated ones (${dated(far)}: ${F.iv(far.atmIV)}): more movement is priced into the near term than further out.`
            : far.atmIV > near.atmIV * 1.1
              ? `Long-dated options (${dated(far)}: ${F.iv(far.atmIV)}) carry higher volatility than near-dated ones (${dated(near)}: ${F.iv(near.atmIV)}): nothing in the near term stands out.`
              : `Volatility is about the same for near (${F.iv(near.atmIV)}) and far (${F.iv(far.atmIV)}) expiries: no particular date stands out.`,
      });
  }

  const t = chain.totals;
  if (t.oi > 0) {
    const pcr = t.callOI ? t.putOI / t.callOI : null;
    out.push({
      k: 'Positioning',
      text:
        `${F.int(t.putOI)} puts and ${F.int(t.callOI)} calls are open` +
        (pcr != null ? ` (${F.num(pcr, 2)} puts per call). ` : '. ') +
        (pcr == null
          ? ''
          : pcr > 1.3
            ? 'Put-heavy: that often reflects hedging rather than outright bets on a fall. '
            : pcr < 0.7
              ? 'Call-heavy: positioning leans toward upside bets. '
              : 'Fairly balanced. ') +
        (t.vol > 0
          ? `Today ${F.int(t.putVol)} puts and ${F.int(t.callVol)} calls traded.`
          : 'No contracts have traded today.'),
    });
    const top = M.topContracts(chain, c => c.oi, 1)[0];
    if (top)
      out.push({
        k: 'Biggest position',
        text: `The largest open position is the ${F.contractName(top)}, with ${F.int(top.oi)} contracts (${F.int(top.oi * 100)} shares' worth). Large open interest marks prices that many traders care about.`,
      });
  }

  const quoted = chain.contracts.filter(c => c.two).length,
    share = quoted / chain.contracts.length;
  const med = e.stats.medSpread;
  if (chain.mode === 'last')
    out.push({
      k: 'Data',
      tone: 'warn',
      text: 'Live quotes are blank right now (this source clears index quotes outside market hours), so prices and volatility here come from the last trades of the session. Treat them as approximate.',
    });
  else if (med != null)
    out.push({
      k: 'Liquidity',
      tone: med > 0.15 ? 'warn' : null,
      text:
        (med > 0.15 ? 'Thin. ' : med < 0.05 ? 'Good. ' : 'Moderate. ') +
        `${F.pct(share, 0)} of contracts show both a bid and an ask, and the typical near-the-money spread for ${F.date(e.date)} is ${F.pct(med, 0)} of the option's price. ` +
        (med > 0.15
          ? 'Buying at the ask and selling at the bid gives up that much straight away, so limit orders matter here.'
          : 'Getting in and out near the mid price should be realistic.'),
    });

  if (quote.earnings) {
    const after = chain.expiries.find(x => x.close > quote.earnings);
    out.push({
      k: 'Earnings',
      text:
        `Next earnings are expected around ${F.date(quote.earnings)}. ` +
        (after
          ? `Expiries from ${F.date(after.date)} onward include that report, which props up their implied volatility until the numbers are out, after which it usually drops sharply.`
          : ''),
    });
  }
  if (chain.adjustedDropped)
    out.push({
      k: 'Note',
      text: `${F.plural(chain.adjustedDropped, 'adjusted contract')} (left over from a split or merger) are hidden because they do not deliver 100 plain shares.`,
    });
  return out;
}

/** One expiry in plain English, as { k, text, tone } items. */
export function expiryStory(exp, chain, quote) {
  const out = [],
    sym = quote.symbol.replace('^', '');
  const friday = new Date(exp.date + 'T12:00:00Z').getUTCDay() === 5;
  const kind = {
    weekly: 'a weekly expiry',
    monthly: `the standard monthly expiry${friday ? ' (third Friday)' : ''}`,
    quarterly: 'a quarter-end expiry',
    leap: 'a long-dated LEAPS expiry',
  }[exp.kind];
  out.push({
    k: 'When',
    text:
      `${F.weekday(exp.date)} ${F.dateLong(exp.date)}, ${F.days(exp.days)} from now. This is ${kind}` +
      (exp.am ? '. It settles at the market open, so its last trading day is the day before.' : '.'),
  });
  const atm = exp.rows.get(exp.atmStrike);
  let text = `The strike nearest the money is ${F.usd(exp.atmStrike)}`;
  if (Math.abs(exp.F / chain.spot - 1) > 0.02)
    text += ` (the money here is the forward price for this expiry, ${F.usd(exp.F)}, not today's ${F.usd(chain.spot)}: interest, dividends and, for some products, a futures price move it)`;
  text += '. ';
  if (atm.call?.mark != null)
    text += `That call costs about ${F.usd(atm.call.mark)} a share (${F.money(atm.call.mark * 100)} a contract). `;
  if (atm.put?.mark != null)
    text += `That put costs about ${F.usd(atm.put.mark)} (${F.money(atm.put.mark * 100)} a contract).`;
  out.push({ k: 'At the money', text });
  if (exp.em != null) {
    const [lo, hi] = range(exp);
    out.push({
      k: 'Expected move',
      tone: exp.smileSrc === 'quotes' ? null : 'warn',
      text:
        `Implied volatility here is ${F.iv(exp.atmIV)}${roughVol(exp)}` +
        `, which prices a move of about ±${F.usd(exp.em)} (${F.pct(exp.em / exp.F)}) by expiry: a typical range of ${F.usd(lo)} to ${F.usd(hi)}.`,
    });
  }
  const rr = M.riskReversal(exp, chain.rate);
  if (rr)
    out.push({
      k: 'Skew',
      text:
        `Puts about as far below the price as calls are above it trade at ${F.iv(rr.put.iv)} against ${F.iv(rr.call.iv)}. ` +
        (rr.rr < -0.02
          ? 'Downside protection costs more.'
          : rr.rr > 0.02
            ? 'Upside bets cost more.'
            : 'No strong lean.'),
    });
  const s = exp.stats;
  if (s.callOI + s.putOI > 0) {
    const big = list => list.reduce((a, b) => (b.oi > a.oi ? b : a), list[0]);
    const bc = exp.calls.length ? big(exp.calls) : null,
      bp = exp.puts.length ? big(exp.puts) : null;
    out.push({
      k: 'Open interest',
      text:
        `${F.int(s.callOI)} calls and ${F.int(s.putOI)} puts are open` +
        (s.callOI ? ` (${F.num(s.putOI / s.callOI, 2)} puts per call). ` : '. ') +
        (bc?.oi ? `Most calls sit at ${F.usd(bc.strike)} (${F.int(bc.oi)}). ` : '') +
        (bp?.oi ? `Most puts sit at ${F.usd(bp.strike)} (${F.int(bp.oi)}). ` : '') +
        `Max pain is ${F.usd(exp.maxPain)}.`,
    });
  } else out.push({ k: 'Open interest', text: 'No contracts are open in this expiry yet.' });
  out.push({
    k: 'Liquidity',
    tone: s.medSpread > 0.15 || s.quoted < s.total / 2 ? 'warn' : null,
    text:
      `${s.quoted} of ${s.total} contracts have both a bid and an ask. ` +
      (s.medSpread != null
        ? `Near the money the typical spread is ${F.pct(s.medSpread, 0)} of the price${s.medSpread > 0.15 ? ', which is wide: a limit order matters here' : ''}.`
        : 'There is no two-sided market near the money.') +
      (exp.mode === 'last' ? ' Quotes are blank right now, so the prices shown are last trades.' : ''),
  });
  out.push({
    k: 'Reading the table',
    text:
      `Calls are on the left, puts on the right, strikes down the middle. Shaded cells are in the money. ` +
      `The line across the table marks where ${sym} is trading. Click any call or put to have it explained.`,
  });
  return out;
}

/** One contract: { title, paragraphs, warnings, greeks: [{ key, value, text }] }. */
export function contractStory(c, chain, quote) {
  const sym = quote.symbol.replace('^', ''),
    e = c.exp,
    index = quote.type === 'INDEX',
    r = chain.rate;
  const kind = c.put ? 'put' : 'call',
    verb = c.put ? 'sell' : 'buy';
  const paragraphs = [],
    warnings = [];
  paragraphs.push(
    index
      ? `This ${kind} pays its owner in cash if ${sym} settles ${c.put ? 'below' : 'above'} ${F.strike(c.strike)} on ${F.dateLong(e.date)} (${F.days(e.days)} away). Index options are settled in cash and can only be exercised at expiry.`
      : `This ${kind} gives its owner the right to ${verb} 100 ${sym} shares at ${F.usd(c.strike)} each, any time until the close on ${F.weekday(e.date)} ${F.dateLong(e.date)} (${F.days(e.days)} away).`,
  );
  const buyAt = c.ask > 0 ? c.ask : c.mark;
  if (buyAt != null) {
    paragraphs.push(
      `Buying one contract at ${c.ask > 0 ? 'the ask' : 'the last price'} costs ${F.money(buyAt * 100)} (${F.price(buyAt)} × 100 shares). That is the most a buyer can lose. ` +
        (c.bid > 0
          ? `Selling one at the bid brings in ${F.money(c.bid * 100)}.`
          : 'There is no bid, so it could not be sold right now.'),
    );
    const be = c.put ? c.strike - buyAt : c.strike + buyAt,
      need = be / chain.spot - 1;
    const beyond =
      c.sigma != null ? (c.put ? Q.probBelow(be, e.F, c.sigma, e.T) : 1 - Q.probBelow(be, e.F, c.sigma, e.T)) : null;
    // Priced below intrinsic value by more than a rounding error (a cent, and 0.2% of the intrinsic value).
    const belowIntrinsic = c.itm && c.extrinsic != null && c.extrinsic < -Math.max(0.01, 0.002 * c.intrinsic);
    const moneyness = !c.itm
      ? `It is out of the money, so its whole price is time value. If ${sym} is still ${c.put ? 'above' : 'below'} ${F.usd(c.strike)} at expiry, it expires worthless. `
      : belowIntrinsic
        ? `It is in the money by ${F.usd(c.intrinsic)} but priced at ${F.usd(c.mark)}, which is ${F.usd(-c.extrinsic)} less. ` +
          (index
            ? 'That is normal for an option that can only be exercised at expiry: the wait costs more than the remaining chance is worth. '
            : 'A gap like that usually means a stale or wide quote, not a bargain. ')
        : `It is in the money: ${F.usd(c.intrinsic)} of its price is intrinsic value (${index ? "what it would pay if it settled at today's price" : 'what exercising now would capture'})` +
          (c.extrinsic != null
            ? ` and ${F.usd(Math.max(c.extrinsic, 0))} is time value that will be gone by expiry`
            : '') +
          '. ';
    paragraphs.push(
      moneyness +
        `A buyer breaks even at expiry with ${sym} at ${F.usd(be)}, which is ${F.signedPct(need, 1)} from here.` +
        (c.probITM != null
          ? ` Option prices imply about a ${F.pct(c.probITM, 0)} chance it finishes in the money` +
            (beyond != null ? ` and about ${F.pct(beyond, 0)} that it finishes past break-even.` : '.')
          : ''),
    );
  } else
    paragraphs.push('There is no quote and no recent trade for this contract, so it cannot be priced from the market.');

  if (c.bid <= 0 && c.ask > 0)
    warnings.push('No bid: nobody is offering to buy this contract right now. You could buy it but not sell it.');
  if (c.spreadPct != null && c.spreadPct > 0.15)
    warnings.push(
      `Wide spread: ${F.pct(c.spreadPct, 0)} of the price. Buying at the ask and selling at the bid loses ${F.money(c.spread * 100)} per contract before the stock moves.`,
    );
  if (c.oi < 10)
    warnings.push(`Very little open interest (${F.int(c.oi)}). Expect poor fills and trouble getting out.`);
  if (e.mode === 'last')
    warnings.push('Live quotes are blank (market closed). Figures use the last trade and are approximate.');
  if (Math.abs(e.basis - 1) > 0.005)
    warnings.push(
      index || offForward(e)
        ? `These options are priced off the forward (futures) price for this expiry, ${F.usd(e.F)}, not the quoted ${sym} at ${F.usd(chain.spot)}.`
        : `Option prices here imply ${sym} at ${F.usd(e.S)}, not the quoted ${F.usd(chain.spot)}. Dividends, the cost of borrowing the shares, early-exercise value in long-dated options and the delay on quotes can each open a gap like this.`,
    );
  // In-the-money contracts read the curve by design (see model.js), so that alone is no cause for a warning.
  if (c.sigmaSrc === 'smile' && (c.iv == null || c.ivQ === 'wide'))
    warnings.push(
      'Its own quote is missing or too wide to measure volatility, so the Greeks use the volatility of neighbouring strikes.',
    );
  if (e.smileSrc === 'wing')
    warnings.push(
      'No option near the money in this expiry has a usable quote, so the volatility level is a rough guess from far-away strikes.',
    );
  if (e.smileSrc === 'borrowed')
    warnings.push(
      'No quote near the money in this expiry is good enough to measure volatility, so the level is borrowed from a neighbouring expiry.',
    );

  const greeks = [];
  if (c.delta != null) {
    const move = niceMove(chain.spot);
    // The option repriced after a move in the price it follows (dS), a wait (days) or a change in volatility (dVol).
    const at = (dS, days = 0, dVol = 0) =>
      Q.bsm({
        S: e.S + dS,
        K: c.strike,
        T: Math.max(e.T - days / 365, 0),
        r,
        q: e.q,
        vol: Math.max(c.sigma + dVol, 0.01),
        put: c.put,
      });
    const perContract = g => (g.price - c.theo) * 100,
      gains = x => (x >= 0 ? 'gains' : 'loses');
    const up = at(move),
      ifUp = perContract(up),
      ifDown = perContract(at(-move));
    const follows = offForward(e) ? 'the forward price for this expiry' : sym,
      units = index || offForward(e) ? 'units of it' : 'shares';
    greeks.push({
      key: 'delta',
      value: F.greek(c.delta, 2),
      text:
        `If ${follows} rises ${F.usd(move)}, this ${kind} ${gains(ifUp)} about ${F.money(Math.abs(ifUp))} per contract; ` +
        `if it falls ${F.usd(move)}, it ${gains(ifDown)} about ${F.money(Math.abs(ifDown))}. Right now it behaves like ${c.delta >= 0 ? 'owning' : 'being short'} ${F.int(Math.abs(c.delta) * 100)} ${units}.`,
    });
    greeks.push({
      key: 'gamma',
      value: F.greek(c.gamma, c.gamma < 0.01 ? 4 : 3),
      text:
        `After that ${F.usd(move)} rise its delta would be about ${F.greek(up.delta, 2)}, against ${F.greek(c.delta, 2)} now. ` +
        "Gamma is why an option buyer's gains speed up and losses slow down.",
    });

    const daysLeft = e.T * 365,
      dayCost = -perContract(at(0, 1)),
      weekCost = -perContract(at(0, 7));
    const timeValue = Math.max(c.theo - Q.bsPrice(e.S, c.strike, 0, r, e.q, c.sigma, c.put), 0) * 100;
    const thetaText =
      daysLeft <= 1
        ? `It expires within a day. The ${F.money(timeValue)} of time value left in one contract is gone by then, wherever the price ends up.`
        : (dayCost >= 0
            ? `Holding it one more day costs about ${F.money(dayCost)} per contract if the price and volatility stay put.`
            : `Holding it one more day earns about ${F.money(-dayCost)} per contract if the price and volatility stay put, because it is priced below what it would settle at.`) +
          (daysLeft > 7 ? ` Over a week that is roughly ${F.money(Math.abs(weekCost))}.` : '');
    greeks.push({ key: 'theta', value: F.greek(c.theta, Math.abs(c.theta) < 0.01 ? 4 : 3), text: thetaText });
    const volPts = c.sigma * 100,
      tenDrop = -perContract(at(0, 0, -0.1));
    greeks.push({
      key: 'vega',
      value: F.greek(c.vega, Math.abs(c.vega) < 0.01 ? 4 : 3),
      text:
        `If implied volatility rises one point (${F.num(volPts, 1)}% to ${F.num(volPts + 1, 1)}%), it gains about ${F.money(c.vega * 100)} per contract. ` +
        `A ten-point drop would cost about ${F.money(Math.max(tenDrop, 0))}.`,
    });
    greeks.push({
      key: 'rho',
      value: F.greek(c.rho, Math.abs(c.rho) < 0.01 ? 4 : 3),
      text: `A one-point rise in interest rates changes it by about ${F.pnl(c.rho * 100)} per contract.${Math.abs(c.rho * 100) < 1 ? ' Too small to matter here.' : ''}`,
    });
  }
  return { title: `${sym} ${F.contractName(c)}`, paragraphs, warnings, greeks };
}

/** A position in plain English: array of sentences. */
export function strategyStory(a, legs, quote, r) {
  const sym = quote.symbol.replace('^', ''),
    out = [];
  if (!legs.length) return out;
  const byDate = F.date(a.horizon),
    index = quote.type === 'INDEX';
  const soldOptions = legs.some(l => l.side < 0 && l.kind !== 'S'),
    shortShares = legs.some(l => l.kind === 'S' && l.side < 0);
  out.push(
    a.cost > 0.005
      ? `You pay ${F.money(a.cost)} to open this position (a debit).`
      : a.cost < -0.005
        ? `You are paid ${F.money(-a.cost)} to open this position (a credit).` +
          (soldOptions
            ? ' You keep it if the options you sold expire worthless.'
            : shortShares
              ? ' That is the cash from selling shares you do not own, and you owe those shares back.'
              : '')
        : 'This position costs roughly nothing to open.',
  );
  out.push(
    `${a.maxLoss === -Infinity ? 'The possible loss is unlimited' : `The most you can lose is ${F.money(Math.abs(a.maxLoss))}`}, and ` +
      `${a.maxProfit === Infinity ? 'the possible profit is unlimited' : `the most you can make is ${F.money(a.maxProfit)}`} if held to ${byDate}.`,
  );
  const b = a.breakevens;
  if (b.length) {
    const edges = [0, ...b, Infinity],
      zones = [];
    for (let i = 1; i < edges.length; i++) {
      const lo = edges[i - 1],
        hi = edges[i],
        inside = hi === Infinity ? Math.max(lo * 1.5, a.grid[a.grid.length - 1] * 2) : (lo + hi) / 2;
      if (M.positionPnl(legs, Math.max(inside, 1e-9), a.horizon, r) > 1e-6)
        zones.push(
          lo === 0
            ? `below ${F.usd(hi)}`
            : hi === Infinity
              ? `above ${F.usd(lo)}`
              : `between ${F.usd(lo)} and ${F.usd(hi)}`,
        );
    }
    out.push(
      zones.length
        ? `It makes money at that expiry if ${sym} is ${zones.join(' or ')}. ${sym} is at ${F.usd(quote.price)} now.`
        : 'It does not make money at any price at that expiry.',
    );
  } else
    out.push(
      a.maxLoss >= 0
        ? 'It makes money at every price at that expiry.'
        : a.maxProfit <= 0
          ? 'It loses money at every price at that expiry.'
          : '',
    );
  out.push(
    `Option prices put the chance of any profit at about ${F.pct(a.pop, 0)}. The market's typical range by ${byDate} is ${F.usd(a.range[0])} to ${F.usd(a.range[1])}.`,
  );
  const g = a.greeks;
  out.push(
    `Right now it behaves like ${g.delta >= 0 ? 'owning' : 'being short'} ${F.int(Math.abs(g.delta))} shares (delta). ` +
      `Each day that passes ${g.theta >= 0 ? 'earns' : 'costs'} about ${F.money(Math.abs(g.theta))} (theta), and each one-point rise in implied volatility ${g.vega >= 0 ? 'adds' : 'costs'} about ${F.money(Math.abs(g.vega))} (vega).`,
  );
  if (a.maxLoss === -Infinity) {
    // Net calls sold, in shares.
    const soldCalls = Q.sum(legs.filter(l => l.kind === 'C').map(l => -l.side * l.qty * 100));
    const sharesHeld = Q.sum(legs.filter(l => l.kind === 'S').map(l => l.side * l.qty));
    out.push(
      soldCalls > 0
        ? `Warning: it includes calls sold without enough shares or bought calls to cover them (${F.int(Math.max(soldCalls - Math.max(sharesHeld, 0), 0))} shares uncovered). Losses grow without limit as the price rises, and brokers require margin approval for this.`
        : 'Warning: it includes shares sold short with nothing to cap the loss. Losses grow without limit as the price rises.',
    );
  } else if (soldOptions)
    out.push(
      `It includes options you sold. ${index ? 'Index options cannot be assigned before expiry, but' : 'You can be assigned early on those, and'} your broker will hold collateral or require a margin account.`,
    );
  return out.filter(Boolean);
}

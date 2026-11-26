// The LEARN view: a course on options and the Greeks. Lesson text lives here; the interactive
// pieces are in learn-widgets.js. Examples use the ticker that is loaded, so the numbers are real.
import * as Q from './quant.js';
import * as M from './model.js';
import * as F from './fmt.js';
import { h, append, btn, table } from './ui.js';
import * as W from './learn-widgets.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Trusted lesson markup to nodes. Anything that comes from market data goes through esc() first. */
const H = html => [...h('div', { html }).childNodes];

/**
 * Facts about the example option as ready-to-print text, for dropping into lesson text.
 * Throughout this file `ex` is the example in numbers (ex.S is 355.58) and `x` is the same example
 * in words (x.S is "$355.58"). x.c and x.p are the call's and the put's price and Greeks, as numbers.
 */
function facts(ex) {
  const T = ex.days / 365, o = { S: ex.S, K: ex.K, T, r: ex.r, q: ex.q, vol: ex.vol };
  const c = Q.bsm(o), p = Q.bsm({ ...o, put: true }), em = ex.S * ex.vol * Math.sqrt(T), move = W.smallMove(ex.S);
  // Premiums are quoted to the cent, and the "multiply by 100" examples have to multiply out exactly.
  const cents = v => Math.round(v * 100) / 100, call = cents(c.price), put = cents(p.price);
  const [lo, hi] = M.moveRange(ex.S, ex.vol, T), nextYear = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10);
  return {
    c, p, em, move, sym: esc(ex.sym), S: F.usd(ex.S), K: F.usd(ex.K), days: ex.days, iv: F.iv(ex.vol), when: ex.date ? esc(F.dateLong(ex.date)) : `${ex.days} days from now`,
    call: F.usd(call), put: F.usd(put), callC: F.money(call * 100), putC: F.money(put * 100), emUsd: F.usd(em), emPct: F.pct(em / ex.S),
    lo: F.usd(lo), hi: F.usd(hi), daily: F.pct(ex.vol / Math.sqrt(252)), moveUsd: F.usd(move),
    ivNow: F.num(ex.vol * 100, 1) + '%', ivUp: F.num(ex.vol * 100 + 1, 1) + '%',          // the same volatility one point higher, to the same precision
    occ: esc(ex.date ? M.occSymbol(ex.root || ex.sym, ex.date, ex.put, ex.K) : M.occSymbol('XYZ', nextYear, false, 100)),
    // What the options are priced off. For most stocks that is the quoted price; where the two differ (VIX options follow a future) both are named.
    basis: Math.abs(ex.S / ex.spot - 1) > 0.005 ? `options priced off ${F.usd(ex.S)} (the quoted price is ${F.usd(ex.spot)})` : `stock at ${F.usd(ex.S)}`,
  };
}
const strip = (ex, x) => H(`<div class="eg"><b>${ex.real ? 'Live example' : 'Example'}</b>The numbers in this lesson come from <b>${x.sym}</b>: ${x.basis}, the ${x.K} strike expiring ${x.when} (${x.days} days), implied volatility ${x.iv}.
  ${ex.real ? 'Load another ticker in the command line and every example changes with it. Click a contract in the CHAIN view first and the lessons use that one.' : 'Load a ticker with listed options to see real numbers here.'}</div>`);

const LESSONS = [
  // ------------------------------------------------------------------ foundations
  { id: 'basics', group: 'Foundations', title: 'Options in five minutes', body: (ex, x) => [
    ...H(`<h1>Options in five minutes</h1>
    <p class="lead">An option is a contract with a price tag, a deadline and one fixed number. Learn those three things and everything else is detail.</p>`),
    ...strip(ex, x),
    ...H(`<h3>Two kinds, one idea</h3>
    <p>A <b>call</b> gives you the right to <b>buy</b> 100 shares at a fixed price. A <b>put</b> gives you the right to <b>sell</b> 100 shares at a fixed price. A right, not a duty: if using it would lose money, you simply let it expire.</p>
    <p>Two everyday pictures help:</p>
    <ul>
      <li><b>A call is like a deposit that locks in a price.</b> You pay a little now for the right to buy later at a price fixed today. If the price runs up, the right is valuable. If it does not, you lose the deposit and nothing more. One difference from a normal deposit: the premium does not count toward the price. You pay the strike in full on top of it.</li>
      <li><b>A put is like an insurance policy.</b> You pay a premium. If the stock is below the insured level when you cash the policy in, it pays the difference. If the price stays up, the premium is gone, exactly like car insurance in a year with no crash.</li>
    </ul>
    <h3>The four facts on every option</h3>
    <table><tr><th>Fact</th><th>What it is</th><th>In the ${ex.real ? 'live ' : ''}example</th></tr>
      <tr><td><b>Underlying</b></td><td>The stock, fund or index the option is about.</td><td>${x.sym}, trading at ${x.S}</td></tr>
      <tr><td><b>Strike</b></td><td>The fixed price you may buy at (call) or sell at (put). It never changes.</td><td>${x.K}</td></tr>
      <tr><td><b>Expiry</b></td><td>The last day the right exists.</td><td>${x.when}</td></tr>
      <tr><td><b>Premium</b></td><td>What the option costs, quoted per share. One contract covers 100 shares, so multiply by 100.</td><td>Call about ${x.call} (${x.callC} a contract), put about ${x.put} (${x.putC} a contract)</td></tr></table>
    <div class="key"><b>Always multiply by 100.</b> A premium of ${x.call} is not ${x.call}. It is ${x.callC} for one contract. Every Greek in this course scales the same way.</div>
    <h3>Buyer and seller</h3>
    <p>Every option has two sides. The trade-off between them is the heart of the whole subject.</p>
    <table><tr><th></th><th>Buyer (long)</th><th>Seller (short)</th></tr>
      <tr><td>Money at the start</td><td>Pays the premium</td><td>Collects the premium</td></tr>
      <tr><td>Has</td><td>A right</td><td>An obligation</td></tr>
      <tr><td>Most they can lose</td><td>The premium, nothing more</td><td>Far more than the premium, sometimes without limit</td></tr>
      <tr><td>Wins when</td><td>The stock moves far enough, soon enough</td><td>Not much happens</td></tr>
      <tr><td>Time is</td><td>Their enemy</td><td>Their friend</td></tr></table>
    <h3>In the money, at the money, out of the money</h3>
    <p>An option is <b>in the money</b> if using it right now would be worth something: the stock is above the strike for a call, below it for a put. That worth is its <b>intrinsic value</b>. Anything you pay above intrinsic value is <b>time value</b>: the price of the chance that things get better before expiry.</p>`),
    W.splitWidget(ex),
    ...H(`<h3>What you make or lose at expiry</h3>
    <p>At expiry the time value is gone and only intrinsic value is left, so the result is easy to draw: the famous hockey stick. The buyer's loss is flat: the premium and no more. A call buyer's gain has no ceiling. A put buyer's gain stops at the strike minus the premium, because a stock cannot fall below zero. Flip to "Sell it" and the picture turns upside down.</p>
    <p><b>You do not have to wait for expiry.</b> Using the right is called <b>exercising</b> the option, and most buyers never do it. They sell the option back in the market, at any time, for whatever it is worth that day: its intrinsic value plus the time value still left. The next lessons are about that price.</p>`),
    W.payoffWidget(ex),
    ...H(`<div class="key"><b>Break-even is not the strike.</b> You first have to earn back what you paid. A call breaks even at strike <b>plus</b> premium, a put at strike <b>minus</b> premium.</div>
    <h3>Why not just buy the stock?</h3>
    <p>Options give you <b>leverage</b> (a small outlay controls 100 shares) and a <b>capped loss</b> (the premium). The price of those two gifts is that you must be right about three things at once: the <b>direction</b>, the <b>size</b> of the move, and the <b>timing</b>. A stockholder who is right but early just waits. An option buyer who is right but early watches the option expire worthless.</p>
    <div class="trap"><b>The most common beginner mistake:</b> buying a cheap, far out-of-the-money option because the price tag is small. It is cheap because the market thinks it will probably expire worthless, and most of them do.</div>
    <div class="key"><b>Before a first trade, read the last lesson (the risk checklist).</b> Three things from it matter on day one. A bought option can go to zero, so only money you can lose completely belongs in one. An option left in the money at the close on expiry day turns into shares, so most buyers sell before then. And a limit order protects you from a bad fill.</div>`),
  ], quiz: (ex, x) => [
    { q: `A put with a ${x.K} strike costs ${x.put}. How much does one contract cost?`, a: [x.put, x.putC, x.K], right: 1, why: 'Premiums are quoted per share and one contract covers 100 shares.' },
    { q: 'You buy a call. What is the most you can lose?', a: ['The premium you paid', 'The strike price times 100', 'There is no limit'], right: 0, why: 'A buyer can always walk away. Only sellers can lose more than the premium.' },
    { q: 'A stock is at $50. Which option is in the money?', a: ['The $55 call', 'The $45 put', 'The $55 put'], right: 2, why: 'The $55 put lets you sell at $55 something worth $50: $5 of intrinsic value.' },
  ] },

  { id: 'chain', group: 'Foundations', title: 'Reading an option chain', body: (ex, x, ctx) => [
    ...H(`<h1>Reading an option chain</h1>
    <p class="lead">A chain is a price list: every strike for one expiry date, calls on the left, puts on the right. Once you can read one row you can read all of them.</p>`),
    ...strip(ex, x),
    ...H('<h3>One slice of the real chain</h3>'),
    anatomy(ex, ctx),
    ...H(`<ol>
      <li><b>Strike</b> runs down the middle. Each row is one strike, with its call on the left and its put on the right.</li>
      <li><b>Bid</b> is the best price anyone will pay you right now. <b>Ask</b> is the best price anyone will sell to you. You buy at the ask and sell at the bid.</li>
      <li><b>The gap between them (the spread)</b> is a toll you pay every round trip. Buy at the ask, sell straight back at the bid, and you have lost the spread without the stock moving. On busy contracts it is a penny or two. On quiet ones it can be a fifth of the price.</li>
      <li><b>Volume</b> is how many contracts traded today. It resets every morning.</li>
      <li><b>Open interest</b> is how many contracts currently exist. Volume is the day's traffic; open interest is how many cars are parked. It only updates overnight.</li>
      <li><b>IV</b> (implied volatility) is how much movement the price is betting on. It is the fairest way to compare how expensive two options are, and it has its own lesson.</li>
      <li><b>Delta</b> is how much the option moves when the stock moves $1. It is the first of the Greeks.</li></ol>
    <div class="key"><b>Trust bid and ask, not "last".</b> The last price is just the most recent trade. In a quiet contract it can be days old and nowhere near where you could trade today.</div>
    <h3>How expiries are organised</h3>
    <table><tr><th>Kind</th><th>When</th><th>Good to know</th></tr>
      <tr><td><b>Weekly</b></td><td>Fridays (busy names also have Monday to Thursday expiries)</td><td>Cheap in dollars, but time decay is brutal.</td></tr>
      <tr><td><b>Monthly</b></td><td>The third Friday of the month</td><td>The original expiries. They usually hold the most open interest and trade best.</td></tr>
      <tr><td><b>Quarterly</b></td><td>The last trading day of a quarter</td><td>Common on index funds.</td></tr>
      <tr><td><b>LEAPS</b></td><td>More than a year away, usually January</td><td>Behave more like the stock. Slow decay, very sensitive to volatility.</td></tr></table>
    <h3>Decoding a contract symbol</h3>
    <p>Every contract has a code. ${ex.date ? 'This one is from the live example' : 'Here is a made-up one'}: <code>${x.occ}</code>. Read it in four pieces: the ticker (index options use a series name here, such as SPXW), the expiry as year-month-day, <b>C</b> for call or <b>P</b> for put, and the strike times 1,000 padded to eight digits.</p>
    <h3>Five checks before you trust a price</h3>
    <ol><li>Is there both a bid and an ask? A missing bid means you could buy it but not sell it.</li>
      <li>How wide is the spread compared with the price? Above about 10% is expensive to trade.</li>
      <li>Is there open interest? Under a few dozen contracts, expect poor fills.</li>
      <li>Has it traded today? Zero volume does not make the quote fake: the bid and ask are still prices you can trade at. But nobody has tested them today, so expect a wide spread and be patient.</li>
      <li>Use a <b>limit order</b>: you name the worst price you will accept. A market order takes whatever the other side is showing, which in a thin option can be far from a fair price.</li></ol>
    <h3>How this terminal marks the chain</h3>
    <p>Shaded cells are in the money. The amber line across the table is where the stock is. Small bars behind the Vol and OI numbers show where the activity sits. An IV shown in <em>italics</em> is not taken from that contract's own quote. In-the-money contracts always take the IV of the out-of-the-money option at the same strike, because the two must agree; contracts with a poor quote are filled in from neighbouring strikes. The panel beside the table explains whichever contract you click.</p>`),
    h('p', null, btn('OPEN THE CHAIN →', () => ctx.go('chain'), 'primary')),
  ], quiz: () => [
    { q: 'An option shows bid 1.00 and ask 1.20. You buy one contract and sell it straight back. What happens?', a: ['You break even', 'You lose $20', 'You make $20'], right: 1, why: 'You pay 1.20 and receive 1.00: 0.20 a share, $20 a contract, gone to the spread.' },
    { q: 'Volume is 5,000 and open interest is 300. What does that tell you?', a: ['Nothing unusual', 'Far more contracts traded today than existed this morning, so new positions are being opened', 'The option is about to expire'], right: 1, why: 'Volume above open interest means fresh positioning. It does not say whether buyers or sellers started it.' },
    { q: 'Which price should you trust least in a quiet contract?', a: ['Bid', 'Ask', 'Last'], right: 2, why: 'Last can be very old. Bid and ask are what you can trade at now.' },
  ] },

  { id: 'value', group: 'Foundations', title: 'What an option is worth', body: (ex, x) => [
    ...H(`<h1>What an option is worth</h1>
    <p class="lead">Six things set an option's price. Five you can look up. The sixth is a guess about the future, and it is the one everybody argues about.</p>`),
    ...strip(ex, x),
    ...H(`<h3>The inputs</h3>
    <table><tr><th>If this goes up…</th><th>Calls</th><th>Puts</th><th>Why</th></tr>
      <tr><td><b>Stock price</b></td><td>Up</td><td>Down</td><td>The right to buy gets more valuable, the right to sell less.</td></tr>
      <tr><td><b>Strike</b> (a higher one)</td><td>Cheaper</td><td>Dearer</td><td>Buying at a higher price is worth less; selling at a higher price is worth more.</td></tr>
      <tr><td><b>Time left</b></td><td>Up</td><td>Up</td><td>More time means more chances for a favourable move.</td></tr>
      <tr><td><b>Volatility</b></td><td>Up</td><td>Up</td><td>Bigger swings help the buyer, whose loss is capped but whose gain is not.</td></tr>
      <tr><td><b>Interest rates</b></td><td>Up a little</td><td>Down a little</td><td>A call lets you delay paying for the shares, which is worth more when cash earns more.</td></tr>
      <tr><td><b>Dividends</b></td><td>Down</td><td>Up</td><td>The stock drops by about the dividend on the ex-dividend date (the first day a buyer of the shares no longer gets it), and option holders do not receive it.</td></tr></table>
    <p>A pricing model (this terminal uses Black-Scholes, the standard one) takes those inputs and returns a fair price. You do not need the formula. You need to know what goes in and how the price reacts when each input moves. Try it:</p>`),
    W.valueLab(ex),
    ...H(`<h3>Meet the Greeks</h3>
    <p>Each Greek answers one question of the form: <b>if this one input changes a little, how much does the option's price change?</b> Think of an option as a car and the Greeks as the dashboard.</p>
    <table><tr><th>Greek</th><th>Input it tracks</th><th>Dashboard reading</th><th>Unit</th></tr>
      <tr><td><b>Delta</b></td><td>Stock price</td><td>Speed: how fast the option moves when the stock moves</td><td>$ per $1 of stock</td></tr>
      <tr><td><b>Gamma</b></td><td>Stock price, again</td><td>Acceleration: how quickly the speed itself changes</td><td>delta per $1 of stock</td></tr>
      <tr><td><b>Theta</b></td><td>Time</td><td>Fuel burn: what a day of waiting costs</td><td>$ per day</td></tr>
      <tr><td><b>Vega</b></td><td>Volatility</td><td>Sensitivity to the forecast changing</td><td>$ per 1 point of IV</td></tr>
      <tr><td><b>Rho</b></td><td>Interest rates</td><td>A light headwind or tailwind</td><td>$ per 1 point of rates</td></tr></table>
    <div class="key"><b>The Greeks are not extra things to memorise.</b> They are five ways of looking at the same price. Delta is the slope of the amber curve you were just dragging. Gamma is how fast that slope changes. Theta is how far the whole curve sinks when a day passes. Vega is how far it lifts when volatility rises one point. Rho does the same for interest rates.</div>
    <p>Before the Greeks, one input deserves a lesson of its own, because it is the only one you cannot look up: volatility.</p>`),
  ], quiz: () => [
    { q: 'All else equal, what happens to both calls and puts when volatility rises?', a: ['Both get cheaper', 'Both get more expensive', 'Calls rise, puts fall'], right: 1, why: 'A buyer\'s loss is capped and the gain is not, so bigger swings are worth paying for on either side.' },
    { q: 'Which Greek tells you what one more day of waiting costs?', a: ['Delta', 'Theta', 'Vega'], right: 1, why: 'Theta is time decay, in dollars per day.' },
    { q: 'An option has 60 days left. With everything else frozen, what happens to its time value as the days pass?', a: ['It shrinks to zero by expiry', 'It stays the same', 'It grows'], right: 0, why: 'At expiry only intrinsic value is left.' },
  ] },

  { id: 'iv', group: 'Foundations', title: 'Implied volatility', body: (ex, x, ctx) => [
    ...H(`<h1>Implied volatility</h1>
    <p class="lead">Volatility is the one input nobody can look up, so the market's guess gets baked into the price. Implied volatility is that guess, read back out.</p>`),
    ...strip(ex, x),
    ...H(`<h3>What the number means</h3>
    <p>Volatility measures how much a price jumps around, written as a yearly percentage. <b>Implied</b> volatility (IV) is the figure you must feed the pricing model to get today's market price. Nobody announces it. It is worked out backwards from what people are actually paying.</p>
    <p>Movement grows with the square root of time, not with time itself: four times the time gives twice the move. That is where the shortcuts below come from. 16 is about the square root of the 252 trading days in a year, and 7 is about the square root of 52 weeks.</p>
    <p>${x.sym} options are priced at an IV of <b>${x.iv}</b>. Three shortcuts turn that into something you can feel:</p>
    <table><tr><th>Horizon</th><th>Rule of thumb</th><th>For ${x.sym} now</th></tr>
      <tr><td>One day</td><td>Divide IV by 16</td><td>about ${x.daily} a day</td></tr>
      <tr><td>One week</td><td>Divide IV by 7</td><td>about ${F.pct(ex.vol / Math.sqrt(52))} a week</td></tr>
      <tr><td>Until any date</td><td>Price × IV × √(days ÷ 365)</td><td>about ±${x.emUsd} (${x.emPct}) over the next ${x.days} days</td></tr></table>
    <p>That last figure is the <b>expected move</b>. It is not a limit. It is one standard deviation: the stock should finish inside ${x.lo} to ${x.hi} about two times in three, and outside it one time in three. (The first shortcut counts trading days and the third counts calendar days, so for a day or two they differ a little. For very volatile stocks the true range reaches further up than down, because a price can more than double but cannot fall below zero.)</p>`),
    W.coneWidget(ex),
    ...H(`<div class="key"><b>IV is the real price tag.</b> A $2 option is not automatically cheaper than a $5 one. The $2 option might be on a sleepy stock at 80% IV (expensive) and the $5 one on a wild stock at 30% IV (cheap). Dollars tell you what you pay. IV tells you whether it is a lot.</div>
    <h3>Is the guess high or low?</h3>
    <p>Compare IV with <b>realized volatility</b>: how much the stock has actually been moving. If options price in 60% and the stock has been moving at 30%, buyers are paying for a storm that has not shown up yet. A small gap is normal: IV usually sits a little above realized volatility. The PRICE view plots both.</p>
    <h3>Why IV is not the same at every strike: skew</h3>
    <p>If the model were perfect, every strike would show the same IV. It does not. Puts well below the stock price usually carry higher IV than calls well above it, because people will pay extra for crash insurance. Plot IV against strike and you get a tilted smile. The tilt tells you which direction traders fear.</p>
    <h3>Why IV is not the same at every date: term structure</h3>
    <p>Calm markets show slightly higher IV for later expiries. When something is about to happen (earnings, a court ruling, an election) the expiries just after it carry extra IV. Once the news is out, that extra vanishes overnight. Traders call it the <b>volatility crush</b>.</p>`),
    h('p', null, btn('SEE SKEW AND TERM STRUCTURE →', () => ctx.go('vol'), 'primary')),
    ...H(`<div class="trap"><b>Three things IV does not tell you.</b> It says nothing about direction: 100% IV means big moves are expected, up or down. It is not a forecast you can bank on: it is a price, set by supply and demand. And a low premium is not a low IV.</div>`),
  ], quiz: (ex, x) => [
    { q: 'A stock has an IV of 32%. Roughly what daily move is that pricing in?', a: ['About 32%', 'About 2%', 'About 0.3%'], right: 1, why: 'Divide by 16: 32 ÷ 16 = 2% a day.' },
    { q: 'A company reports earnings tomorrow. What usually happens to the IV of its options the morning after?', a: ['It jumps', 'It falls sharply', 'Nothing'], right: 1, why: 'The uncertainty is resolved, so the extra volatility priced into those options disappears.' },
    { q: `The expected move for ${x.sym} over the next ${x.days} days is about ±${x.emUsd}. What does that mean?`, a: ['The stock cannot move more than that', 'The stock will rise by that much', 'It should finish within that distance about two times in three'], right: 2, why: 'It is one standard deviation, not a ceiling and not a direction.' },
  ] },

  // ------------------------------------------------------------------ the Greeks
  { id: 'delta', group: 'The Greeks', title: 'Delta: speed', body: (ex, x) => [
    ...H(`<h1>Delta</h1>
    <p class="lead">How much the option's price moves when the stock moves one dollar.</p>`),
    ...strip(ex, x),
    ...H(`<div class="key"><b>Delta in one line:</b> the ${x.sym} ${x.K} call has a delta of <b>${F.num(x.c.delta, 2)}</b>. If the stock rises ${x.moveUsd}, the call gains about ${F.money(x.c.delta * x.move * 100)} a contract. The put's delta is <b>${F.num(x.p.delta, 2)}</b>: it loses about ${F.money(Math.abs(x.p.delta) * x.move * 100)} on the same move.</div>
    <h3>Three ways to think about it</h3>
    <ul>
      <li><b>Speed.</b> Delta is how fast the option moves compared with the stock. 0.50 means half speed.</li>
      <li><b>Share-equivalent.</b> Multiply by 100. A 0.50-delta call behaves, right now, like owning 50 shares. A −0.30-delta put behaves like being short 30 shares. This is the most useful reading: it lets you add options and stock together.</li>
      <li><b>Rough odds.</b> Delta is a rough guide to the market's chance that the option finishes in the money. A 0.20-delta call has about a one-in-five chance. The guide runs high for calls and low for puts, and the gap grows with IV and with time left: an at-the-money call with 110% IV and 60 days left has a delta of 0.59 but only a 42% chance. The ITM % column in the CHAIN view (Columns: Everything) shows the real figure. Either way it is the chance of finishing in the money, not the chance of making a profit.</li>
    </ul>
    <h3>The range</h3>
    <table><tr><th></th><th>Far out of the money</th><th>At the money</th><th>Deep in the money</th></tr>
      <tr><td><b>Call delta</b></td><td>near 0</td><td>about 0.50</td><td>near 1.00</td></tr>
      <tr><td><b>Put delta</b></td><td>near 0</td><td>about −0.50</td><td>near −1.00</td></tr></table>
    <p>A deep in-the-money option moves almost dollar for dollar with the stock: it has become a stand-in for the shares. A far out-of-the-money one barely notices small moves.</p>`),
    W.deltaLab(ex),
    ...H(`<h3>Delta does not sit still</h3>
    <ul>
      <li><b>When the stock moves</b>, delta changes. That is gamma, the next lesson.</li>
      <li><b>As time passes</b>, deltas drift apart: in-the-money options creep toward 1, out-of-the-money options sink toward 0. By the last day almost every option is either "all in" or "all out".</li>
      <li><b>When volatility rises</b>, deltas are pulled toward the middle: calls toward 0.50, puts toward −0.50. If anything can happen, every strike is closer to a coin flip.</li>
    </ul>
    <h3>Adding it up</h3>
    <p>Position delta is delta × contracts × 100. Twelve puts with a delta of −0.70 behave like being short 12 × 70 = 840 shares. The STRATEGY view shows this as "Net delta".</p>
    <div class="trap"><b>The trap:</b> treating delta as fixed. "My option gains $50 for every $1" is only true for the first dollar. After a big move the delta is a different number. Delta is a snapshot, not a promise.</div>`),
  ], quiz: () => [
    { q: 'You own 3 calls with a delta of 0.40. About how many shares does that behave like?', a: ['40', '120', '300'], right: 1, why: '0.40 × 100 shares × 3 contracts = 120.' },
    { q: 'What is the delta of an at-the-money put, roughly?', a: ['+0.50', '−0.50', '−1.00'], right: 1, why: 'Puts have negative delta, and at the money it is about half.' },
    { q: 'A call has a delta of 0.15. What is a fair rough reading?', a: ['About a 15% chance of finishing in the money', 'A 15% chance of profit', 'It will rise 15%'], right: 0, why: 'Delta roughly matches the chance of finishing in the money when IV and time are modest. That is a lower bar than making a profit.' },
  ] },

  { id: 'gamma', group: 'The Greeks', title: 'Gamma: acceleration', body: (ex, x, ctx) => [
    ...H(`<h1>Gamma</h1>
    <p class="lead">How much delta changes when the stock moves one dollar. Delta is the speed. Gamma is how hard you are pressing the pedal.</p>`),
    ...strip(ex, x),
    ...H(`<div class="key"><b>Gamma in one line:</b> the ${x.sym} ${x.K} call has delta ${F.num(x.c.delta, 2)} and gamma <b>${F.greek(x.c.gamma, 3)}</b>. After a ${x.moveUsd} rise its delta becomes about ${F.num(Math.min(x.c.delta + x.c.gamma * x.move, 1), 2)}. After a ${x.moveUsd} fall, about ${F.num(Math.max(x.c.delta - x.c.gamma * x.move, 0), 2)}.</div>
    <h3>Why buyers love it</h3>
    <p>Own a call and the stock rises: your delta grows, so each further dollar earns more than the last. The stock falls: your delta shrinks, so each further dollar hurts less. <b>You automatically get longer on the way up and shorter on the way down.</b> That bend in the value curve is gamma, and it is why an option's payoff is lopsided in the buyer's favour.</p>
    <p>Bought options, calls and puts alike, always have positive gamma. Sold options always have negative gamma: the seller's losses speed up as the move grows.</p>
    <h3>Where gamma lives</h3>
    <ul>
      <li><b>At the money.</b> That is where the question "will it finish in or out?" is most undecided, so delta swings the most.</li>
      <li><b>Close to expiry.</b> With weeks left, delta slides gently between 0 and 1. On the last day it swings from one to the other across a move of a percent or two, and in the final minutes across almost nothing.</li>
    </ul>`),
    W.gammaLab(ex),
    ...H(`<h3>Nothing is free</h3>
    <p>Gamma is what you buy with theta. The options with the most gamma (at the money, about to expire) are also the ones losing value fastest each day. The buyer rents acceleration; the seller collects the rent and prays for a quiet road. The theta lesson shows the exact trade.</p>
    <h3>Gamma and the whole market</h3>
    <p>Dealers who sell options hedge by trading shares, and how much they must trade depends on gamma. Where a lot of gamma is concentrated at one strike, that hedging can pin the price near it or, on the other side, feed a move. The OPEN INTEREST view estimates this.</p>`),
    h('p', null, btn('SEE GAMMA BY STRIKE →', () => ctx.go('oi'), 'primary')),
    ...H(`<div class="trap"><b>The trap for sellers:</b> selling at-the-money options in the final days looks like easy money because they decay so fast. They also have the highest gamma there is. One sharp move and the loss is many times the premium collected.</div>`),
  ], quiz: () => [
    { q: 'A call has delta 0.40 and gamma 0.05. The stock rises $2. Roughly what is the new delta?', a: ['0.45', '0.50', '0.30'], right: 1, why: '0.40 + 0.05 × 2 = 0.50.' },
    { q: 'Which option has the most gamma?', a: ['Deep in the money, a year out', 'At the money, expiring tomorrow', 'Far out of the money, a year out'], right: 1, why: 'Gamma peaks near the strike. At the strike it grows as expiry approaches; away from the strike it fades.' },
    { q: 'You sold an option. What sign is your gamma?', a: ['Positive', 'Negative', 'Zero'], right: 1, why: 'Sellers are short gamma: their position moves against them faster and faster.' },
  ] },

  { id: 'theta', group: 'The Greeks', title: 'Theta: time decay', body: (ex, x) => {
    // Three numbers for "theta is the price of gamma": the daily move that pays the rent when direction is hedged away,
    // the (much smaller) favourable move that pays it for someone who simply owns the call, and what a move of the
    // first size costs that owner when it goes the wrong way.
    const hedged = x.c.gamma > 0 ? Math.sqrt(2 * Math.abs(x.c.theta) / x.c.gamma) : 0;
    const owned = x.c.delta > 0 ? Math.abs(x.c.theta) / x.c.delta : 0;
    const against = (x.c.price - Q.bsPrice(ex.S - hedged, ex.K, ex.days / 365, ex.r, ex.q, ex.vol, false)) * 100;
    return [
    ...H(`<h1>Theta</h1>
    <p class="lead">How much value the option loses each day if nothing else changes. The rent you pay for holding it.</p>`),
    ...strip(ex, x),
    ...H(`<div class="key"><b>Theta in one line:</b> the ${x.sym} ${x.K} call has a theta of <b>${F.greek(x.c.theta, 3)}</b>. Hold it one more day with the stock and volatility unchanged, and it is worth about ${F.money(Math.abs(x.c.theta) * 100)} less per contract.</div>
    <h3>What actually decays</h3>
    <p>Only <b>time value</b> decays. Intrinsic value does not: a call that is $3 in the money is worth at least $3 until the stock moves. So theta bites hardest where time value is biggest, which is at the money.</p>
    <p>Think of an ice cube. It is all there in the morning, it melts slowly at first, and at the end it goes in a rush.</p>
    <h3>Decay is not a straight line</h3>
    <p>An at-the-money option's time value shrinks with the square root of the time left. Cut the time in half and about 71% of the value remains, not 50%. Put the other way: roughly 30% of the time value is lost in the first half of an option's life and 70% in the second half, most of it in the final weeks.</p>
    <p>That is the at-the-money picture. An option far from the strike is different: its small time value drains away earlier, and by the final days there is little left to lose. The lab below tells you which case you are looking at.</p>`),
    W.thetaLab(ex),
    ...H(`<h3>Theta is the price of gamma</h3>
    <p>Here is the trade at the centre of options. Gamma pays you when the stock moves. Theta charges you every day whether it moves or not. The two are tied together.</p>
    <p>Professional traders often cancel their delta with shares, so that only the <b>size</b> of a move matters and not its direction. For that hedged position, the move needed each day to cover the rent is</p>
    <p><code>daily break-even move = √(2 × theta ÷ gamma)</code></p>
    <p>For the example that is about <b>${F.usd(hedged)}</b> a day (${F.pct(hedged / ex.S)}), up or down. It is a little below the typical daily move from the volatility lesson (${x.daily}), because theta is charged on all 365 days and the stock trades on about 252. That is the link between IV and theta: an option is fairly priced when the stock really moves as much as its IV says. If it moves more, owning options pays. If it moves less, selling them pays.</p>
    <p>If you simply own a call or a put, direction comes first. Here a move of about ${F.usd(owned)} your way covers one day of decay, while a ${F.usd(hedged)} move against you loses about ${F.money(against)} a contract.</p>
    <h3>Who is on which side</h3>
    <table><tr><th></th><th>Bought options</th><th>Sold options</th></tr>
      <tr><td>Theta</td><td>Negative: you pay each day</td><td>Positive: you collect each day</td></tr>
      <tr><td>Gamma</td><td>Positive: movement helps</td><td>Negative: movement hurts</td></tr>
      <tr><td>Wants</td><td>A big move, soon</td><td>A quiet stretch</td></tr></table>
    <h3>Practical notes</h3>
    <ul>
      <li>Theta is quoted per calendar day, weekends included. Markets tend to price the weekend in before Friday's close, so you rarely "steal" two free days.</li>
      <li>Higher IV means more time value, so more theta. Expensive options decay faster in dollars.</li>
      <li>Far out-of-the-money options have small theta in dollars, but they lose a large share of their tiny value every day.</li>
    </ul>
    <div class="trap"><b>The trap:</b> "I am right about direction, so I will just wait." Waiting is not free for an option buyer. If the move takes twice as long as you expected, theta may have eaten the profit before it arrives. That is why many buyers choose more time than they think they need.</div>`)];
  }, quiz: () => [
    { q: 'An option has a theta of −0.05. With nothing else changing, how much does one contract lose over a 7-day week?', a: ['About $5', 'About $35', 'About $0.35'], right: 1, why: '0.05 × 100 shares × 7 days = $35 (a little more for an at-the-money option, since its decay speeds up).' },
    { q: 'When is time decay fastest for an at-the-money option?', a: ['When it has a year left', 'In the middle of its life', 'In the last days before expiry'], right: 2, why: 'At the strike, time value melts slowly at first and fastest at the end.' },
    { q: 'Who earns theta?', a: ['Option buyers', 'Option sellers', 'Nobody'], right: 1, why: 'Sellers collect time decay. In return they carry the gamma risk.' },
  ] },

  { id: 'vega', group: 'The Greeks', title: 'Vega: volatility', body: (ex, x) => [
    ...H(`<h1>Vega</h1>
    <p class="lead">How much the option's price changes when implied volatility moves one percentage point.</p>`),
    ...strip(ex, x),
    ...H(`<div class="key"><b>Vega in one line:</b> the ${x.sym} ${x.K} call has a vega of <b>${F.greek(x.c.vega, 3)}</b>. If IV goes from ${x.ivNow} to ${x.ivUp} with the stock not moving at all, the call gains about ${F.money(x.c.vega * 100)} a contract. A ten-point fall costs about ${F.money(x.c.vega * 1000)}.</div>
    <h3>The idea</h3>
    <p>An option is a bet on movement. If the market suddenly expects more movement, every option becomes more valuable, calls and puts alike. If it expects less, they all deflate. Vega measures how much.</p>
    <p>Anyone who has bought an option is <b>long vega</b>: they gain when IV rises. Anyone who has sold one is <b>short vega</b>.</p>
    <h3>Where vega is biggest</h3>
    <ul>
      <li><b>Long-dated options.</b> A change in the yearly forecast matters much more over 300 days than over 3. LEAPS carry several times the vega of a one-month option, so a change in IV matters far more to them.</li>
      <li><b>At the money.</b> Like gamma and theta, vega peaks at the strike.</li>
    </ul>
    <p>That gives a useful split. <b>Short-dated options are about gamma and theta</b>: what the stock does this week. <b>Long-dated options are about vega</b>: what the market thinks the future holds.</p>`),
    W.vegaLab(ex),
    ...H(`<h3>The volatility crush</h3>
    <p>Before a known event (earnings above all) IV climbs, because everyone knows a jump is coming. The moment the news is out, the uncertainty is gone and IV drops, often by a third or more overnight. Anyone holding options through the event pays for that drop through vega.</p>
    <p>This is how people lose money on a correct call. The stock rises as they predicted, but the fall in IV takes away more than the rise gives.</p>`),
    W.crushWidget(ex),
    ...H(`<h3>Using vega</h3>
    <ul>
      <li>Check IV before you buy. Buying when IV is unusually high means paying a high price for insurance just after everyone else rushed to buy it.</li>
      <li>If you want direction without the vega bet, a <b>spread</b> (buy one option, sell another) cancels most of the vega. The strategies lesson shows how.</li>
      <li>Vega is quoted per one point of IV, and IV can move 10 or 20 points in a day around news.</li>
    </ul>
    <div class="trap"><b>The trap:</b> buying options the day before earnings because "it is going to move". The market already knows. The move is in the price. You only win if the stock moves <b>more</b> than the options already assumed.</div>`),
  ], quiz: () => [
    { q: 'You own a call with a vega of 0.08. IV falls 10 points and the stock does not move. What happens to one contract?', a: ['It loses about $80', 'It gains about $80', 'Nothing'], right: 0, why: '0.08 × 10 points × 100 shares = $80, lost.' },
    { q: 'Which option has more vega?', a: ['At the money, 1 week out', 'At the money, 1 year out', 'They are equal'], right: 1, why: 'Vega grows with time to expiry.' },
    { q: 'A stock jumps 4% on earnings, yet its calls fall. The most likely reason?', a: ['A data error', 'Implied volatility collapsed after the news', 'Interest rates changed'], right: 1, why: 'The volatility crush: the options had priced in a bigger move than 4%.' },
  ] },

  { id: 'rho', group: 'The Greeks', title: 'Rho and dividends', body: (ex, x) => [
    ...H(`<h1>Rho and dividends</h1>
    <p class="lead">How much the option's price changes when interest rates move one percentage point. The quiet Greek, until you hold something long-dated.</p>`),
    ...strip(ex, x),
    ...H(`<div class="key"><b>Rho in one line:</b> for the ${x.sym} ${x.K} call, a one-point rise in rates changes the price by about <b>${F.pnl(x.c.rho * 100)} a contract</b>. For the put it is about ${F.pnl(x.p.rho * 100)}.</div>
    <h3>Why rates matter at all</h3>
    <p>A call lets you control shares now and pay for them later. Meanwhile the cash you did not spend earns interest. The higher the rate, the more that delay is worth, so calls gain. A put is the mirror image: it lets you sell later what you could have sold today, so higher rates make it worth a little less.</p>
    <p>For an option with a few weeks left the effect is pennies. For LEAPS it is real money, because the delay lasts for years.</p>`),
    W.rhoLab(ex),
    ...H(`<h3>Dividends work the other way</h3>
    <p>When a stock pays a dividend its price drops by that amount on the ex-dividend date, and option holders do not receive the dividend. So expected dividends make <b>calls cheaper</b> and <b>puts dearer</b>.</p>
    <p>This is the usual reason a call is exercised early: someone holding a deep in-the-money call may exercise it the day before the ex-dividend date to collect the dividend. If you have sold such a call, expect to be assigned. (Deep in-the-money puts are also exercised early, when the interest on the strike is worth more than the time value left.)</p>
    <h3>How this terminal handles both</h3>
    <p>Rather than guessing dividends and borrowing costs, the terminal reads the <b>forward price</b> straight out of the market, using the fact that a call and a put at the same strike must agree with each other. That one number carries dividends, rates and the cost of borrowing the stock all at once. You can see it in the VOLATILITY view's table.</p>`),
  ], quiz: () => [
    { q: 'Interest rates rise. Other things equal, what happens to call prices?', a: ['They rise slightly', 'They fall slightly', 'Nothing'], right: 0, why: 'Delaying payment for the shares is worth more when cash earns more.' },
    { q: 'Which option is most sensitive to interest rates?', a: ['One expiring this Friday', 'One expiring in two years', 'Both the same'], right: 1, why: 'Rho grows with time to expiry.' },
  ] },

  { id: 'together', group: 'The Greeks', title: 'The Greeks working together', body: (ex, x, ctx) => [
    ...H(`<h1>The Greeks working together</h1>
    <p class="lead">Real days change everything at once: the stock moves, a day passes, volatility shifts. The Greeks let you split one profit-and-loss number into its causes.</p>`),
    ...strip(ex, x),
    ...H(`<h3>The whole thing in one sentence</h3>
    <div class="key"><b>Change in option price ≈</b> delta × stock move <b>+</b> ½ × gamma × move² <b>+</b> theta × days <b>+</b> vega × change in IV</div>
    <p>Four terms, four questions. Did the stock go my way (delta)? Did it go far (gamma)? How long did it take (theta)? Did the market's fear rise or fall (vega)? Play with all three sliders and watch which bar does the damage:</p>`),
    W.attributionWidget(ex),
    ...H(`<h3>The four basic positions</h3>
    <table><tr><th>Position</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>Wins when</th></tr>
      <tr><td><b>Long call</b></td><td>+</td><td>+</td><td>−</td><td>+</td><td>Stock rises fast, IV rises</td></tr>
      <tr><td><b>Long put</b></td><td>−</td><td>+</td><td>−</td><td>+</td><td>Stock falls fast, IV rises</td></tr>
      <tr><td><b>Short call</b></td><td>−</td><td>−</td><td>+</td><td>−</td><td>Stock stays below the strike, IV falls</td></tr>
      <tr><td><b>Short put</b></td><td>+</td><td>−</td><td>+</td><td>−</td><td>Stock stays above the strike, IV falls</td></tr></table>
    <p>Look down the columns. <b>Every buyer owns gamma and vega and pays theta. Every seller collects theta and owes gamma and vega.</b> Buying or selling decides those three signs. Call or put only decides the sign of delta.</p>
    <h3>Right about direction, still lost money</h3>
    <p>It happens all the time, and there are exactly three ways:</p>
    <ol>
      <li><b>Too slow.</b> The move came, but theta had already eaten the premium.</li>
      <li><b>Not far enough.</b> The stock went your way but stopped short of break-even.</li>
      <li><b>Volatility fell.</b> The stock moved, but IV dropped and vega took more than delta gave.</li>
    </ol>
    <p>Before any trade, ask all four questions: which way, how far, how soon, and what happens to volatility. If you only have an opinion on the first, an option may be the wrong tool, or a spread may suit you better.</p>
    <h3>Reading a position's Greeks</h3>
    <p>For several legs, add the Greeks up. The STRATEGY view does it for you and prints the totals in dollars: net delta as a number of shares, theta as dollars per day, vega as dollars per point of IV.</p>`),
    h('p', null, btn('OPEN THE STRATEGY BUILDER →', () => ctx.go('strategy'), 'primary')),
  ], quiz: () => [
    { q: 'You bought a put. Which describes your Greeks?', a: ['Negative delta, positive gamma, negative theta, positive vega', 'Positive delta, negative gamma, positive theta, negative vega', 'Negative everything'], right: 0, why: 'Buying gives positive gamma and vega and negative theta. A put makes delta negative.' },
    { q: 'A call has delta 0.50, theta −0.10, vega 0.20. The stock rises $1, two days pass, IV falls 3 points. Roughly what is the change per share?', a: ['+0.50', '−0.30', '+0.90'], right: 1, why: '0.50 − (0.10 × 2) − (0.20 × 3) = 0.50 − 0.20 − 0.60 = −0.30. Right on direction, still down.' },
  ] },

  { id: 'advanced', group: 'The Greeks', title: 'Second-order Greeks', body: (ex, x) => [
    ...H(`<h1>Second-order Greeks</h1>
    <p class="lead">The Greeks have Greeks. You can trade for years without them, but they explain a few things that otherwise look like magic.</p>
    <p>The five main Greeks each change when conditions change. The second-order Greeks measure how.</p>
    <table><tr><th>Name</th><th>Measures</th><th>What you notice in practice</th></tr>
      <tr><td><b>Gamma</b></td><td>Delta as the stock moves</td><td>You met it already: it is the best-known second-order Greek.</td></tr>
      <tr><td><b>Charm</b></td><td>Delta as a day passes</td><td>Out-of-the-money options lose delta just from time passing. A hedge that was balanced on Friday is off by Monday.</td></tr>
      <tr><td><b>Vanna</b></td><td>Delta as IV changes</td><td>When IV falls, out-of-the-money calls and puts both drift toward zero delta: a call from 0.25 to 0.20, a put from −0.25 to −0.20. Hedges against them shrink, which is part of why markets can drift up as fear fades.</td></tr>
      <tr><td><b>Vomma</b></td><td>Vega as IV changes</td><td>Far out-of-the-money options get more vega as IV rises. Their value can explode in a panic.</td></tr>
      <tr><td><b>Speed</b></td><td>Gamma as the stock moves</td><td>How quickly the gamma hill rises and falls around the strike.</td></tr>
      <tr><td><b>Colour</b></td><td>Gamma as a day passes</td><td>The gamma spike building in the last days.</td></tr></table>
    <p>For the live example (${x.sym} ${x.K} call): charm is ${F.greek(x.c.charm, 4)} delta per day, vanna is ${F.greek(x.c.vanna, 4)} delta per point of IV, and vomma is ${F.greek(x.c.vomma, 4)} vega per point of IV. The CALCULATOR shows these three for any option you enter.</p>
    <div class="key"><b>What to take away:</b> none of the Greeks is a constant. They are all snapshots of one curved surface. When a position starts behaving differently from what its Greeks said yesterday, a second-order Greek is the reason.</div>`),
  ], quiz: () => [
    { q: 'Nothing happens for three days. An out-of-the-money call\'s delta has dropped from 0.25 to 0.21. Which Greek describes that?', a: ['Vanna', 'Charm', 'Vomma'], right: 1, why: 'Charm is the change in delta from time passing.' },
  ] },

  // ------------------------------------------------------------------ putting it to work
  { id: 'strategies', group: 'Putting it to work', title: 'From one option to strategies', body: (ex, x, ctx) => [
    ...H(`<h1>From one option to strategies</h1>
    <p class="lead">A single option is a blunt tool: it bets on direction, speed and volatility all at once. Combine two or more and you can keep the part of the bet you want and sell off the rest.</p>
    <h3>Why combine</h3>
    <ul>
      <li><b>To cut the cost.</b> Selling a second option pays for part of the first.</li>
      <li><b>To cap the risk.</b> Buying a second option puts a floor under one you sold.</li>
      <li><b>To change the bet.</b> Some combinations do not care which way the stock goes, only whether it moves a lot or a little.</li>
    </ul>
    <h3>The building blocks</h3>
    <p>Press TRY on any row to load it into the builder with real contracts for ${x.sym}.</p>`),
    strategyTable(ctx),
    ...H(`<h3>Debit and credit</h3>
    <p>A <b>debit</b> trade costs money to open: you are a net buyer, your loss is capped at what you paid (as long as every option you sold is covered by one you bought), and you need something to happen. A <b>credit</b> trade pays you to open: you are a net seller, you keep the money if nothing happens, and you need a second leg to cap what you could lose.</p>
    <h3>Defined and undefined risk</h3>
    <p>If every option you sold is covered by shares you own or by another option you bought, the worst case is a known number. That is <b>defined risk</b>. Selling a call with nothing behind it has no limit at all: the stock can keep rising. Brokers require a margin account and special approval for that, with good reason.</p>
    <h3>What the builder tells you</h3>
    <ul>
      <li><b>Max profit, max loss and break-evens</b> if you hold to the first expiry.</li>
      <li><b>Chance of profit</b>: the market-implied odds of finishing above zero. It is honest about the odds, but silent on size: a 90% chance of making $10 against a 10% chance of losing $400 is not a good bet.</li>
      <li><b>Net Greeks</b>, so you can see whether you are betting on direction (delta), movement (gamma), time (theta) or volatility (vega).</li>
    </ul>
    <div class="trap"><b>The trap:</b> strategies that win small most of the time and lose big occasionally feel wonderful for months. Judge them by the size of the bad day, not by how often they win.</div>`),
  ], quiz: () => [
    { q: 'You buy a $50 call for $3 and sell a $55 call for $1. What is the most you can lose per share?', a: ['$2', '$3', '$5'], right: 0, why: 'You paid $3 and received $1: a net debit of $2, which is your maximum loss.' },
    { q: 'For that same spread, what is the most you can make per share?', a: ['Unlimited', '$3', '$5'], right: 1, why: 'The strikes are $5 apart and you paid $2, so the most is $5 − $2 = $3.' },
    { q: 'Which position has unlimited possible loss?', a: ['A bought put', 'A call sold with no shares and no other option behind it', 'A bull call spread'], right: 1, why: 'A stock can rise without limit, and the seller of an uncovered call owes the difference.' },
  ] },

  { id: 'risk', group: 'Putting it to work', title: 'Risk checklist and common traps', body: (ex, x) => [
    ...H(`<h1>Risk checklist and common traps</h1>
    <p class="lead">Most option losses are not bad luck. They come from a short list of avoidable mistakes. Run through this before any trade.</p>
    <h3>Before you trade</h3>
    <ol>
      <li><b>Can I afford to lose all of it?</b> A bought option can go to zero, and many do. Size the position as if it will. Many traders cap each option trade at a small, fixed share of their account, because several total losses in a row are normal.</li>
      <li><b>Where is my break-even?</b> Not the strike: the strike plus or minus the premium. How far is that from here, in percent?</li>
      <li><b>Have I bought enough time?</b> If my idea needs a month, an option with two weeks left is a bet on timing, not on the idea.</li>
      <li><b>How expensive is volatility right now?</b> Compare IV with realized volatility on the PRICE view. Buying just after IV has spiked means paying a high price for movement: IV may rise further, but it often falls back, and that fall comes out of your option.</li>
      <li><b>Is there an event before expiry?</b> Earnings and other known dates mean a volatility crush afterwards.</li>
      <li><b>Can I get out?</b> Check the spread and the open interest. A 20% spread means starting 20% behind.</li>
      <li><b>What is my exit?</b> Decide in advance at what profit you sell and at what loss you give up. Options move too fast to decide in the moment.</li>
    </ol>
    <h3>If you sell options</h3>
    <ul>
      <li><b>Early assignment.</b> Options on stocks and funds are American-style: the buyer may exercise on any day, not only at expiry. (Index options are European-style: expiry only.) So an option you sold can be assigned on any day. It is most likely when the option is deep in the money, and for calls on the day before the stock's ex-dividend date.</li>
      <li><b>Collateral.</b> Your broker will hold cash or shares against the obligation, and can raise the requirement when the market moves against you.</li>
      <li><b>Negative gamma.</b> Losses accelerate. The premium collected is fixed; the possible loss is not.</li>
    </ul>
    <h3>On expiry day</h3>
    <ul>
      <li>An option that finishes even one cent in the money is normally <b>exercised automatically</b>. A bought call becomes 100 shares that you must pay for at the strike: a $50 call means a $5,000 bill. A bought put becomes a sale of 100 shares at the strike, and if you do not own those shares you end up short 100 shares. Either way you now hold a stock position over the weekend, and its loss is not limited to the premium.</li>
      <li>To avoid that, the option has to be <b>sold before the close</b>. If you lack the cash or the shares, your broker may sell it for you earlier that afternoon, at whatever the bid happens to be. The cut-off differs by broker, so look yours up.</li>
      <li>Most stock options stop trading at 4:00 pm New York time (a few funds, such as SPY and QQQ, at 4:15). The stock keeps trading after hours and exercise decisions can be made later still, so an option that looked safe at the close can still be exercised or assigned.</li>
      <li>Index options (SPX, NDX, VIX) are settled in cash and can only be exercised at expiry. Some settle on the opening prices of expiry morning, so their last trading day is the day before.</li>
    </ul>
    <h3>The classic traps</h3>
    <table><tr><th>Trap</th><th>What really happens</th></tr>
      <tr><td>"It is only $20, what can go wrong?"</td><td>Cheap far out-of-the-money options are cheap because they nearly always expire worthless.</td></tr>
      <tr><td>"The stock went up and my call went down."</td><td>Volatility fell or time ran out. Delta is one of four forces.</td></tr>
      <tr><td>"I will just hold until it comes back."</td><td>Unlike a stock, an option has a deadline. Waiting costs theta every day.</td></tr>
      <tr><td>"Selling options is free money."</td><td>It is steady income with an occasional very large loss. That is insurance underwriting, and insurers hold reserves.</td></tr>
      <tr><td>"I used a market order."</td><td>In a thin contract a market order fills at whatever the other side is showing, however far that is from a fair price.</td></tr></table>
    <h3>The limits of this terminal</h3>
    <ul>
      <li>Prices are delayed about 15 minutes. Never time an order from them: check your broker's live quote.</li>
      <li>Volatility and the Greeks are computed here from bid and ask prices with a standard model. On thin chains the inputs are rough and so are the outputs; the terminal marks estimates in italics or grey. When the market is closed they are worked out as of the last close.</li>
      <li>The model treats every option as if it could only be exercised at expiry. Stock options can be exercised early, so deep in-the-money puts, and calls just before a dividend, are worth a little more than shown. The CALCULATOR's Binomial model shows the difference.</li>
      <li>Chances of profit are what option prices imply, not predictions. They assume one bell-shaped spread of prices at the at-the-money volatility and ignore skew.</li>
      <li>It is a tool for learning and analysis. It cannot place trades and nothing in it is investment advice.</li>
    </ul>
    <div class="key"><b>You have reached the end.</b> The fastest way to make all of this stick is to pick one contract in the CHAIN view, read its explanation, then drag the what-if sliders until nothing it does surprises you.</div>`),
  ], quiz: () => [
    { q: 'You hold a call that is $0.40 in the money at the close on expiry day and do nothing. What normally happens?', a: ['It expires worthless', 'It is exercised automatically and you buy 100 shares', 'The broker refunds the premium'], right: 1, why: 'Options in the money by a cent or more are exercised automatically unless you sell them first.' },
    { q: 'An option shows bid 0.50, ask 0.70. What is the cost of the spread as a share of the mid price?', a: ['About 10%', 'About 33%', 'About 3%'], right: 1, why: 'The spread is 0.20 and the mid is 0.60: a third of the price.' },
  ] },
];

// ---------------------------------------------------------------- pieces built from live data

function anatomy(ex, ctx) {
  const chain = ctx.app.chain, e = chain?.expiries.find(v => v.label === ex.label);
  if (!e) return h('p', { class: 'note' }, 'Load a ticker with listed options to see a slice of its real chain here.');
  const at = e.strikes.indexOf(e.atmStrike), rows = e.strikes.slice(Math.max(at - 2, 0), at + 3).map(k => e.rows.get(k));
  const px = v => (v > 0 ? F.price(v) : '—'), side = (c, cls) => [
    { label: '② Bid', cls, cell: r => px(r[c]?.bid) }, { label: '② Ask', cls, cell: r => px(r[c]?.ask) }, { label: '④ Vol', cls, cell: r => F.int(r[c]?.vol) },
    { label: '⑤ OI', cls, cell: r => F.int(r[c]?.oi) }, { label: '⑥ IV', cls, cell: r => F.iv(r[c]?.sigma) }, { label: '⑦ Delta', cls, cell: r => F.greek(r[c]?.delta, 2) }];
  return h('div', { class: 'wide' }, table([...side('call', 'callc'), { label: '① Strike', cls: 'c amber', cell: r => F.strike(r.strike) }, ...side('put', 'putc')], rows),
    h('p', { class: 'note small' }, `${ex.sym} ${F.dateLong(e.date)}: calls in blue on the left, puts in orange on the right. ③ is the gap between each bid and ask. Stock at ${F.usd(chain.spot)}.`));
}

// The strategy table. name must match a key of TEMPLATES in model.js, which builds the legs for TRY.
// greeks: the signs of delta, gamma, theta and vega; a dot means small because the legs mostly cancel.
const PROFILES = [
  { name: 'Long call', how: 'Buy a call', expect: 'Up, soon', lose: 'Premium', gain: 'Unlimited', greeks: '+ + − +' },
  { name: 'Long put', how: 'Buy a put', expect: 'Down, soon', lose: 'Premium', gain: 'Strike − premium', greeks: '− + − +' },
  { name: 'Bull call spread', how: 'Buy a call, sell a call at a higher strike', expect: 'Up, modestly', lose: 'Debit paid', gain: 'Width − debit', greeks: '+ · · ·' },
  { name: 'Bear put spread', how: 'Buy a put, sell a put at a lower strike', expect: 'Down, modestly', lose: 'Debit paid', gain: 'Width − debit', greeks: '− · · ·' },
  { name: 'Bull put spread (credit)', how: 'Sell a put, buy a put at a lower strike', expect: 'Not down much', lose: 'Width − credit', gain: 'Credit received', greeks: '+ − + −' },
  { name: 'Bear call spread (credit)', how: 'Sell a call, buy a call at a higher strike', expect: 'Not up much', lose: 'Width − credit', gain: 'Credit received', greeks: '− − + −' },
  { name: 'Long straddle', how: 'Buy a call and a put at the same strike', expect: 'A big move, either way', lose: 'Both premiums', gain: 'Unlimited', greeks: '0 + − +' },
  { name: 'Long strangle', how: 'Buy a call above the price and a put below it', expect: 'A very big move, either way', lose: 'Both premiums', gain: 'Unlimited', greeks: '0 + − +' },
  { name: 'Iron condor', how: 'Sell a put spread below the price and a call spread above it', expect: 'Stays in a range', lose: 'Width − credit', gain: 'Credit received', greeks: '0 − + −' },
  { name: 'Call butterfly', how: 'Buy one lower call, sell two middle calls, buy one higher call', expect: 'Lands near one price', lose: 'Debit paid', gain: 'Width − debit', greeks: '0 − + −' },
  { name: 'Covered call', how: 'Own 100 shares, sell a call', expect: 'Flat to slightly up', lose: 'Stock falls (less the premium)', gain: 'Strike − share cost + premium', greeks: '+ − + −' },
  { name: 'Protective put', how: 'Own 100 shares, buy a put', expect: 'Up, with insurance', lose: 'Down to the strike, plus premium', gain: 'Unlimited', greeks: '+ + − +' },
  { name: 'Collar', how: 'Own 100 shares, buy a put, sell a call', expect: 'Up a little, protected', lose: 'Down to the put strike', gain: 'Up to the call strike', greeks: '+ · · ·' },
  { name: 'Cash-secured put', how: 'Sell a put and keep the cash to buy the shares', expect: 'Happy to buy lower', lose: 'Strike − premium', gain: 'Premium received', greeks: '+ − + −' },
];
function strategyTable(ctx) {
  const chain = ctx.app.chain, e = chain && (ctx.expiry() || chain.expiries[0]);
  const load = name => {
    const legs = M.buildTemplate(name, e, chain.spot), held = ctx.legs().length;
    if (!legs.length) return ctx.status(`${F.expiryName(e)} does not list the strikes a ${name.toLowerCase()} needs. Pick another expiry in the CHAIN view.`, true);
    // The builder holds one position per ticker: ask before replacing one that may carry typed-in entry prices.
    if (held && !confirm(`Replace the ${F.plural(held, 'leg')} now in the strategy builder with a ${name.toLowerCase()}?`)) return;
    ctx.setLegs(legs); ctx.go('strategy');
  };
  return h('div', { class: 'wide' }, table([
    { label: 'Strategy', cls: 'l', cell: r => h('b', null, r.name) }, { label: 'What you do', cls: 'l wrap', cell: r => r.how }, { label: 'You expect', cls: 'l', cell: r => r.expect },
    { label: 'Most you lose', cls: 'l', cell: r => r.lose }, { label: 'Most you make', cls: 'l', cell: r => r.gain },
    { label: 'Δ Γ Θ V', cls: 'c', tiptext: 'Signs of delta, gamma, theta and vega. A dot means small: the two legs mostly cancel.', cell: r => r.greeks },
    { label: '', cell: r => (e && M.TEMPLATES[r.name] ? btn('TRY', () => load(r.name), '', `Load a ${r.name.toLowerCase()} into the strategy builder`, 'try:' + r.name) : '') },
  ], PROFILES));
}

// ---------------------------------------------------------------- view

export function render(root, ctx) {
  const { app } = ctx, ex = W.exampleFrom(ctx), x = facts(ex);
  const index = Math.max(LESSONS.findIndex(l => l.id === app.lesson), 0), lesson = LESSONS[index];
  const marks = {};
  const toc = h('nav', { class: 'toc', 'aria-label': 'Lessons' });
  let group = null;
  LESSONS.forEach((l, i) => {
    if (l.group !== group) { group = l.group; toc.append(h('h3', null, group)); }
    marks[l.id] = h('span', { class: 'done' }, app.done[l.id] ? '✓' : '');
    toc.append(h('button', { class: l === lesson ? 'on' : '', onclick: () => ctx.setLesson(l.id) }, h('span', { class: 'n' }, i + 1), l.title, marks[l.id]));
  });
  const finish = () => { ctx.markDone(lesson.id); marks[lesson.id].textContent = '✓'; };
  const prev = LESSONS[index - 1], next = LESSONS[index + 1];
  const body = h('article', { class: 'lesson' });
  append(body, lesson.body(ex, x, ctx),
    H('<h3>Check yourself</h3>'), W.quiz(lesson.quiz(ex, x), finish),
    h('div', { class: 'lesson-nav' },
      prev ? btn(`← ${prev.title}`, () => ctx.setLesson(prev.id)) : h('span'),
      next ? btn(`${next.title} →`, () => { finish(); ctx.setLesson(next.id); }, 'primary') : btn('✓ FINISH THE COURSE', () => { finish(); ctx.status('Course complete'); }, 'primary')));
  append(root, h('div', { class: 'learn' }, toc, body));
}

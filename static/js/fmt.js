// Number, date and label formatting. Everything returns a string; missing values become a dash.
const DASH = '—';
const ok = x => x != null && Number.isFinite(x);
const NY = 'America/New_York';

export const num = (x, d = 2) => (ok(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : DASH);

/** Prices: two decimals, or three when a small price needs them (1.705). */
export function price(x) {
  if (!ok(x)) return DASH;
  const d = Math.abs(x) < 10 && Math.round(Math.abs(x) * 1000) % 10 !== 0 ? 3 : 2;
  return num(x, d);
}
export const usd = x => (ok(x) ? (x < 0 ? '-$' : '$') + price(Math.abs(x)) : DASH);

/** Whole-dollar amounts with a sign, for profit and loss: +$120, -$480. */
export function pnl(x) {
  if (x === Infinity) return 'Unlimited';
  if (x === -Infinity) return 'Unlimited loss';
  if (!ok(x)) return DASH;
  const a = Math.abs(x), body = a >= 100 ? num(a, 0) : num(a, 2);
  return (x > 0 ? '+$' : x < 0 ? '-$' : '$') + body;
}
export const money = x => (ok(x) ? (x < 0 ? '-$' : '$') + (Math.abs(x) >= 100 ? num(Math.abs(x), 0) : num(Math.abs(x), 2)) : DASH);

export function strike(x) {
  if (!ok(x)) return DASH;
  return x.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 3 });
}
/** x is a fraction: 0.124 -> "12.4%". */
export const pct = (x, d = 1) => (ok(x) ? num(x * 100, d) + '%' : DASH);
export const signedPct = (x, d = 2) => (ok(x) ? (x > 0 ? '+' : '') + num(x * 100, d) + '%' : DASH);
export const signed = (x, d = 2) => (ok(x) ? (x > 0 ? '+' : '') + num(x, d) : DASH);
export const int = x => (ok(x) ? Math.round(x).toLocaleString('en-US') : DASH);
/** Implied volatility: whole percent above 20%, one decimal below. */
export const iv = x => (ok(x) ? num(x * 100, x < 0.2 ? 1 : 0) + '%' : DASH);
/** Greeks: d decimals, more for very small values so they never print as 0.000. */
export const greek = (x, d = 3) => (ok(x) ? num(x, x !== 0 && Math.abs(x) < 0.5 * 10 ** -d ? Math.min(d + 3, 7) : d) : DASH);

export function compact(x) {
  if (!ok(x)) return DASH;
  const a = Math.abs(x);
  if (a >= 1e12) return num(x / 1e12, 2) + 'T';
  if (a >= 1e9) return num(x / 1e9, 2) + 'B';
  if (a >= 1e6) return num(x / 1e6, 2) + 'M';
  if (a >= 1e4) return num(x / 1e3, 1) + 'K';
  return int(x);
}

export function days(d) {
  if (!ok(d)) return DASH;
  if (d < 1) return Math.max(Math.round(d * 24), 1) + 'h';
  return Math.round(d) + 'd';
}

const dateOf = v => (typeof v === 'string' ? new Date(v + 'T12:00:00Z') : new Date(v * 1000));
const part = (v, opts, tz) => dateOf(v).toLocaleString('en-US', { timeZone: typeof v === 'string' ? 'UTC' : tz || NY, ...opts });
/** "Dec 4" from an ISO date or epoch seconds. */
export const date = v => (v == null ? DASH : part(v, { month: 'short', day: 'numeric' }));
/** "Dec 4, 2026". */
export const dateLong = v => (v == null ? DASH : part(v, { month: 'short', day: 'numeric', year: 'numeric' }));
export const weekday = v => (v == null ? DASH : part(v, { weekday: 'short' }));
/** Time of day in New York, e.g. "4:00 PM". */
export const time = v => (v == null ? DASH : part(v, { hour: 'numeric', minute: '2-digit' }));
export const dateTime = v => (v == null ? DASH : `${date(v)} ${time(v)}`);

/** Wall-clock timestamp in New York as "YYYY-MM-DD HH:MM" (what the price chart plots, so that
 *  session gaps can be cut out by hour). */
export function nyStamp(epoch) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(epoch * 1000)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export const contractName = c => `${date(c.exp.date)} ${strike(c.strike)} ${c.put ? 'put' : 'call'}`;
export const legName = l => (l.kind === 'S' ? 'shares' : `${date(l.date)} ${strike(l.strike)} ${l.kind === 'P' ? 'put' : 'call'}`);
export const plural = (n, word) => `${int(n)} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

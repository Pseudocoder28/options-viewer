// Expiry picker: a chain's expiry dates as buttons grouped by month.
// A long list (an index can list fifty or more dates) shows one month at a time under a row of months.
import * as F from './fmt.js';
import { h } from './ui.js';

const KIND = { monthly: 'M', quarterly: 'Q', leap: 'LEAP' };      // weeklies carry no mark
const monthOf = e => e.date.slice(0, 7);

/**
 * opts: { on: expiry => is it chosen, onPick: expiry => void, label: text shown in front,
 *         compact: one month at a time (default: when there are more than 16 dates) }
 */
export function expiryPicker(expiries, { on, onPick, label, compact = expiries.length > 16 }) {
  const months = new Map();
  for (const e of expiries) months.set(monthOf(e), [...(months.get(monthOf(e)) || []), e]);
  const firstYear = expiries[0]?.date.slice(0, 4);
  const short = ym => new Date(ym + '-15T12:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
  const monthName = ym => short(ym) + (ym.slice(0, 4) !== firstYear ? ` '${ym.slice(2, 4)}` : '');

  const day = e => h('button', {
    class: on(e) ? 'on' : '', key: 'exp:' + e.label, 'aria-pressed': String(!!on(e)), onclick: () => onPick(e),
    'aria-label': `${F.dateLong(e.date)}${e.label !== e.date ? ' ' + e.root : ''}, ${F.days(e.days)} to expiry`,
    tiptext: `${F.weekday(e.date)} ${F.dateLong(e.date)} · ${F.days(e.days)} to expiry · ${e.strikes.length} strikes${e.atmIV != null ? ' · at-the-money IV ' + F.iv(e.atmIV) : ''}`,
  }, h('span', null, +e.date.slice(8), e.label !== e.date ? ` ${e.root}` : '', KIND[e.kind] ? h('i', null, KIND[e.kind]) : null),
     h('small', null, F.days(e.days), e.atmIV != null ? ' ' + F.iv(e.atmIV) : ''));
  const lead = label ? h('span', { class: 'lab' }, label) : null;
  const attrs = { role: 'group', 'aria-label': label || 'Expiry dates' };

  if (!compact) return h('div', { class: 'expiries', ...attrs }, lead,
    [...months].map(([ym, list]) => h('div', { class: 'mon' }, h('span', { class: 'm' }, monthName(ym)), list.map(day))));

  const open = monthOf(expiries.find(on) || expiries[0]);
  let year = null;
  return h('div', { class: 'expiries compact', ...attrs },
    h('div', { class: 'months' }, lead, [...months].map(([ym, list]) => {
      const y = ym.slice(0, 4), yearLabel = y !== year ? h('span', { class: 'm' }, y) : null;       // each year is named once, before its first month
      year = y;
      return [yearLabel, h('button', {
        class: ym === open ? 'on' : '', key: 'mon:' + ym, 'aria-pressed': String(ym === open), onclick: () => onPick(list[0]),
        'aria-label': `${short(ym)} ${y}, ${F.plural(list.length, 'expiry date')}`,
        tiptext: `${F.plural(list.length, 'expiry date')} in ${short(ym)} ${y}: ${F.date(list[0].date)}${list.length > 1 ? ' to ' + F.date(list[list.length - 1].date) : ''}. Opens the first.`,
      }, short(ym), list.length > 1 ? h('small', null, `(${list.length})`) : null)];
    })),
    h('div', { class: 'days' }, h('span', { class: 'm' }, monthName(open)), months.get(open).map(day)));
}

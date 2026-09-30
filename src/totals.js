// Sums ledger entries into today's and this month's spend, in integer paise,
// and formats paise as a ₹ string. Pure: no DOM, no storage, no network, so
// the Today screen can call it on every render.
//
// Day and month boundaries are the device's local calendar: an entry at
// 23:59 on the last day of a month belongs to that month, wherever UTC is.

/**
 * An entry's amount in integer paise. Accepts the `amountPaise` the Today
 * screen and quick-entry parser use, or a rupee `amount` such as 45.5.
 * @param {{ amountPaise?: number, amount?: number }} entry
 * @returns {number | null}  `null` when the entry has no usable amount.
 */
export function toPaise(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (Number.isSafeInteger(entry.amountPaise)) return entry.amountPaise;

  if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) return null;

  const paise = Math.round(entry.amount * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

/* A Date for epoch milliseconds, a Date or an ISO string; null if invalid. */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {Array<{ amount?: number, amountPaise?: number,
 *                 timestamp?: number | string | Date, ts?: number | string | Date }>} entries
 * @param {number | string | Date} [now]  The reference moment; defaults to now.
 * @returns {{ today: number, month: number }}  Integer paise. Entries without
 *   a usable amount or timestamp are skipped.
 */
export function totals(entries, now = new Date()) {
  const result = { today: 0, month: 0 };
  const reference = toDate(now);
  if (!Array.isArray(entries) || !reference) return result;

  const year = reference.getFullYear();
  const month = reference.getMonth();
  const day = reference.getDate();

  for (const entry of entries) {
    const paise = toPaise(entry);
    const at = toDate(entry?.timestamp ?? entry?.ts);
    if (paise === null || !at) continue;
    if (at.getFullYear() !== year || at.getMonth() !== month) continue;

    result.month += paise;
    if (at.getDate() === day) result.today += paise;
  }
  return result;
}

/* Indian digit grouping (₹1,23,450), with paise only when there are any. */
export function formatRupees(amountPaise) {
  const paise = Math.max(0, Math.round(Number(amountPaise) || 0));
  const rupees = String(Math.floor(paise / 100));
  const fraction = paise % 100;
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const whole = rest ? rest + ',' + lastThree : lastThree;
  return '₹' + whole + (fraction ? '.' + String(fraction).padStart(2, '0') : '');
}

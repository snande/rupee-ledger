// Turns this month's spends into CSV text, one row per spend, oldest first:
// Date,Amount (₹),Category,Note. Pure: no DOM, no storage, no network. The
// Export CSV button (src/backup-download.js) decides where the text goes.
//
// A spend counts by the same rule as the This month card in src/totals.js
// (datedPaise + inMonth on the device's local calendar), and also only when
// it is not later than `now`. So the CSV's amounts sum to
// `totals(entries, now).month` unless a spend is dated later this month than
// `now`; such a spend counts toward the card but is not exported yet.

import { datedPaise, inMonth, toDate } from './totals.js';

/** Row 1 of every month CSV. */
export const CSV_HEADER = 'Date,Amount (₹),Category,Note';

/** The record separator, CRLF as RFC 4180 specifies. */
export const CSV_EOL = '\r\n';

const pad2 = (n) => String(n).padStart(2, '0');

/** `at` as its local calendar date, `YYYY-MM-DD`. */
function localDate(at) {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/**
 * One CSV field per RFC 4180: wrapped in double quotes, with inner quotes
 * doubled, when it holds a comma, a quote or a line break. Missing is empty.
 * @param {unknown} value
 */
export function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The spends of `now`'s local calendar month, up to and including `now`, as
 * CSV text. Records are separated by CRLF; the header is always present.
 * @param {Array<{ amountPaise?: number, amount?: number, note?: string,
 *                 category?: string, createdAt?: number | string | Date,
 *                 timestamp?: number | string | Date,
 *                 ts?: number | string | Date }>} entries  Not modified.
 * @param {number | string | Date} [now]  The reference moment; defaults to now.
 * @returns {string}
 */
export function monthCsv(entries, now = new Date()) {
  const reference = toDate(now);
  if (!Array.isArray(entries) || !reference) return CSV_HEADER;

  const year = reference.getFullYear();
  const month = reference.getMonth();
  const limit = reference.getTime();

  const kept = [];
  for (const entry of entries) {
    const dated = datedPaise(entry);
    if (!dated || !inMonth(dated.at, year, month) || dated.at.getTime() > limit) continue;
    kept.push({ entry, ...dated });
  }
  kept.sort((a, b) => a.at.getTime() - b.at.getTime());

  const rows = kept.map(({ entry, paise, at }) =>
    [localDate(at), String(paise / 100), csvField(entry.category), csvField(entry.note)].join(','),
  );
  return [CSV_HEADER, ...rows].join(CSV_EOL);
}

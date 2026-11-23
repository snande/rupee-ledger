// Turns this month's spends into CSV text: Date, Amount (₹), Category, Note.
// Uses the same rule as the This month card in src/totals.js (datedPaise and
// inMonth), so the Amount cells sum to that total. Pure: no DOM, no storage,
// no network; it never modifies the entries it is given.

import { datedPaise, inMonth } from './totals.js';

export const MONTH_CSV_HEADER = 'Date,Amount (₹),Category,Note';

/* A Date for epoch milliseconds, a Date or an ISO string; null if invalid. */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* The local calendar date of `at` as YYYY-MM-DD. */
function localDate(at) {
  const year = String(at.getFullYear()).padStart(4, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* One CSV field, quoted per RFC 4180 when it holds a comma, quote or newline. */
function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * This month's spends as CSV text, oldest first, one row per spend.
 * @param {Array<{ id?: unknown, amountPaise?: number, amount?: number,
 *                 note?: string, category?: string,
 *                 timestamp?: number | string | Date, ts?: number | string | Date }>} entries
 * @param {number | string | Date} [now]  The reference moment; defaults to now.
 *   Only spends in its local calendar month and no later than it are kept.
 * @returns {string}  The header row, then one row per spend, joined by CRLF.
 */
export function monthCsv(entries, now = new Date()) {
  const reference = toDate(now);
  if (!Array.isArray(entries) || !reference) return MONTH_CSV_HEADER;

  const year = reference.getFullYear();
  const month = reference.getMonth();
  const limit = reference.getTime();

  const kept = [];
  entries.forEach((entry, index) => {
    const dated = datedPaise(entry);
    if (!dated || !inMonth(dated.at, year, month) || dated.at.getTime() > limit) return;
    kept.push({ entry, index, paise: dated.paise, at: dated.at });
  });
  kept.sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);

  const rows = kept.map(({ entry, paise, at }) =>
    [
      localDate(at),
      String(paise / 100),
      csvField(entry.category),
      csvField(entry.note),
    ].join(','),
  );
  return [MONTH_CSV_HEADER, ...rows].join('\r\n');
}

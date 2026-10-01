// Compares two months of spend, overall and by category, in integer paise
// like src/totals.js; src/format-amount.js shows them as ₹. Each month's
// categories add up exactly (===) to its total. Pure: no DOM, no storage,
// no network.

import { categoryTotalsForMonth, UNCATEGORISED } from './category-totals.js';

export { UNCATEGORISED };

/**
 * A month identifier as `{ year, month }`, month 1 for January.
 * @param {string | { year: number, month: number }} id  `'2026-09'` or
 *   `{ year: 2026, month: 9 }`.
 * @returns {{ year: number, month: number }}
 * @throws {TypeError} when `id` is not a valid month.
 */
function parseMonth(id) {
  let year;
  let month;
  if (typeof id === 'string') {
    const match = /^(\d{4})-(\d{2})$/.exec(id.trim());
    if (match) [year, month] = [Number(match[1]), Number(match[2])];
  } else if (id && typeof id === 'object') {
    ({ year, month } = id);
  }
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError(`Not a month: ${JSON.stringify(id)}; expected 'YYYY-MM' or { year, month }`);
  }
  return { year, month };
}

/* One month's total and per-category map, in paise. */
function monthSummary(entries, { year, month }) {
  const rows = categoryTotalsForMonth(entries, year, month);
  return {
    month: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
    total: rows.reduce((total, row) => total + row.amount, 0),
    byCategory: Object.fromEntries(rows.map((row) => [row.category, row.amount])),
  };
}

/* A category's paise in a month summary; 0 when absent, own keys only. */
function amountIn(summary, category) {
  return Object.hasOwn(summary.byCategory, category) ? summary.byCategory[category] : 0;
}

/**
 * @param {Array<{ amount?: number, amountPaise?: number, category?: string | null,
 *                 timestamp?: number | string | Date, ts?: number | string | Date }>} entries
 * @param {string | { year: number, month: number }} firstMonth  e.g. `'2026-08'`.
 * @param {string | { year: number, month: number }} secondMonth  e.g. `'2026-09'`.
 * @returns {{
 *   first: { month: string, total: number, byCategory: Record<string, number> },
 *   second: { month: string, total: number, byCategory: Record<string, number> },
 *   difference: { total: number, byCategory: Record<string, number> },
 * }}  Integer paise. Differences are second minus first; a category missing
 *   from one month counts as 0 there. Entries are counted exactly when
 *   `totals()` would count them for that month; blank or missing categories
 *   are grouped as `Uncategorised`.
 * @throws {TypeError} when a month identifier is malformed.
 */
export function compareMonths(entries, firstMonth, secondMonth) {
  const first = monthSummary(entries, parseMonth(firstMonth));
  const second = monthSummary(entries, parseMonth(secondMonth));

  const categories = new Set([...Object.keys(first.byCategory), ...Object.keys(second.byCategory)]);
  const byCategory = Object.fromEntries(
    [...categories].map((category) => [
      category,
      amountIn(second, category) - amountIn(first, category),
    ]),
  );

  return { first, second, difference: { total: second.total - first.total, byCategory } };
}

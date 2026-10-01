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

/* The summary with every one of `categories` listed, at 0 where the month has none. */
function withCategories(summary, categories) {
  return {
    ...summary,
    byCategory: Object.fromEntries(categories.map((category) => [category, amountIn(summary, category)])),
  };
}

/**
 * @param {Array<{ amount?: number, amountPaise?: number, category?: string | null,
 *                 timestamp?: number | string | Date, ts?: number | string | Date }>} entries
 * @param {string | { year: number, month: number }} monthA  A `YYYY-MM` month such
 *   as `'2026-08'`, or `{ year, month }`.
 * @param {string | { year: number, month: number }} monthB  A `YYYY-MM` month such
 *   as `'2026-09'`, or `{ year, month }`.
 * @returns {{
 *   a: { month: string, total: number, byCategory: Record<string, number> },
 *   b: { month: string, total: number, byCategory: Record<string, number> },
 *   diff: { total: number, byCategory: Record<string, number> },
 * }}  Integer paise. `a.byCategory`, `b.byCategory` and `diff.byCategory`
 *   share the same keys: every category in either month, at 0 in a month
 *   without it, so `diff.byCategory[c] === b.byCategory[c] - a.byCategory[c]`.
 *   When neither month has entries the maps are empty. Entries are counted
 *   exactly when `totals()` would count them for that month; blank or
 *   missing categories are grouped as `Uncategorised`.
 * @throws {TypeError} when a month identifier is malformed.
 */
export function compareMonths(entries, monthA, monthB) {
  const summaryA = monthSummary(entries, parseMonth(monthA));
  const summaryB = monthSummary(entries, parseMonth(monthB));

  const categories = [...new Set([...Object.keys(summaryA.byCategory), ...Object.keys(summaryB.byCategory)])];
  const a = withCategories(summaryA, categories);
  const b = withCategories(summaryB, categories);
  const byCategory = Object.fromEntries(
    categories.map((category) => [category, b.byCategory[category] - a.byCategory[category]]),
  );

  return { a, b, diff: { total: b.total - a.total, byCategory } };
}

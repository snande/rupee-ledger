// Splits one month's spend by category, in integer paise like src/totals.js,
// so the category amounts add up exactly (===) to the month total shown; no
// figure is rounded independently. Pure: no DOM, no storage, no network.

import { datedPaise, inMonth } from './totals.js';

export const UNCATEGORISED = 'Uncategorised';

/* The category label; blank, missing or non-string categories are grouped. */
function categoryOf(entry) {
  const category = typeof entry.category === 'string' ? entry.category.trim() : '';
  return category || UNCATEGORISED;
}

/**
 * @param {Array<{ amount?: number, amountPaise?: number, category?: string | null,
 *                 timestamp?: number | string | Date, ts?: number | string | Date }>} entries
 * @param {number} year  e.g. 2026.
 * @param {number} month  Calendar month, 1 for January to 12 for December.
 * @returns {Array<{ category: string, amount: number }>}  `amount` in integer
 *   rupee paise, the unit `totals().month` uses, largest first. Entries are
 *   counted exactly when `totals()` would count them for that month.
 */
export function categoryTotalsForMonth(entries, year, month) {
  if (!Array.isArray(entries)) return [];

  const byCategory = new Map();
  for (const entry of entries) {
    const dated = datedPaise(entry);
    if (!dated || !inMonth(dated.at, year, month - 1)) continue;

    const category = categoryOf(entry);
    byCategory.set(category, (byCategory.get(category) ?? 0) + dated.paise);
  }

  return [...byCategory]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

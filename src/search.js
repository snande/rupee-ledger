// Finds every ledger entry whose note contains a query, across all months,
// and totals them in integer paise. Pure: no DOM, no storage, no network, so
// search runs on the device over entries the screen has already loaded.
//
// Field names follow the records the app actually holds: `note`, `createdAt`
// in epoch milliseconds, and the amount in integer paise as either
// `amountPaise` (src/parse-entry.js, src/quick-entry.js, src/ledger.js) or
// `amount` (src/ledger/store.js). `toPaise` in src/totals.js is not reused:
// it reads `amount` as rupees and would count a stored record 100 times over.

/* An entry's amount in integer paise, or 0 when it has no usable amount. */
function paiseOf(entry) {
  if (Number.isSafeInteger(entry.amountPaise)) return entry.amountPaise;
  if (Number.isSafeInteger(entry.amount)) return entry.amount;
  return 0;
}

/* An entry's moment in epoch milliseconds, or NaN when it has none. */
function timeOf(entry) {
  const value = entry.createdAt ?? entry.timestamp ?? entry.ts;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  return new Date(value).getTime();
}

/**
 * @param {Array<{ note?: string, amount?: number, amountPaise?: number,
 *                 createdAt?: number | string | Date }>} entries
 * @param {string} query  Matched as a case-insensitive substring of `note`.
 * @returns {{ matches: Array<object>, total: number }}  `matches` newest first
 *   (entries without a usable date last); `total` their sum in integer paise.
 *   A blank query matches nothing.
 */
export function searchEntries(entries, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle || !Array.isArray(entries)) return { matches: [], total: 0 };

  const matches = entries
    .filter((entry) => entry && typeof entry === 'object' &&
      String(entry.note ?? '').toLowerCase().includes(needle))
    .map((entry) => ({ entry, time: timeOf(entry) }))
    .sort((a, b) => {
      if (Number.isNaN(a.time)) return Number.isNaN(b.time) ? 0 : 1;
      if (Number.isNaN(b.time)) return -1;
      return b.time - a.time;
    })
    .map(({ entry }) => entry);

  const total = matches.reduce((sum, entry) => sum + paiseOf(entry), 0);
  return { matches, total };
}

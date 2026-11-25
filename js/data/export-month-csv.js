/*
 * Export CSV, wired: this month's spends as spreadsheet rows, downloaded on
 * the phone as rupee-ledger-YYYY-MM.csv.
 *
 * The rows are monthCsv() from src/csv-export.js; the download is
 * exportCsv() from src/backup-download.js. The entries come from
 * loadEntries() in js/data/ledger.js, the same read the Today screen's This
 * month card sums with totals(), so the file's Amount column adds up to that
 * card. Nothing goes over the network, so it works in airplane mode.
 *
 * The saved file starts with the UTF-8 byte order mark (CSV_BOM), so Excel
 * decodes it as UTF-8 and the header's ₹ reads correctly; a month with no
 * spends saves the BOM and the header alone.
 *
 * The export only reads. It never calls add(), updateCategory() or
 * addMissingEntries(), and monthCsv() is handed a frozen copy of the loaded
 * spends (the list and each spend), so building the file cannot change what
 * was read or reach back into the stored records.
 */

import { exportCsv } from '../../src/backup-download.js';
import { CSV_BOM, monthCsv } from '../../src/csv-export.js';
import { loadEntries } from './ledger.js';

/**
 * A frozen copy of a list of loaded spends: a new array of shallow copies,
 * each frozen, and the array frozen too. Anything that is not an array is
 * returned as it is, so exportCsv() still rejects it.
 * @param {unknown} entries
 * @returns {unknown}
 */
export function frozenSnapshot(entries) {
  if (!Array.isArray(entries)) return entries;
  return Object.freeze(entries.map((entry) =>
    entry !== null && typeof entry === 'object' ? Object.freeze({ ...entry }) : entry));
}

/**
 * Downloads this month's spends as a CSV file whose text starts with the
 * UTF-8 BOM, then monthCsv()'s header and rows.
 * @param {{ load?: (options: { now: Date }) => Promise<Array<object>>,
 *   doc?: Document, url?: { createObjectURL: Function, revokeObjectURL: Function },
 *   now?: Date, csv?: (entries: ReadonlyArray<object>, now: Date) => string
 *   }} [options]  `load` defaults to loadEntries(); `csv`, which turns the
 *   frozen spends into the file's rows, to monthCsv(); `doc`, `url` and
 *   `now` are passed to exportCsv() and default as it does.
 * @returns {Promise<{ filename: string, count: number }>}  the file's name
 *   and how many spend rows it holds. Rejects, having downloaded nothing,
 *   when the read fails.
 */
export async function exportMonthCsv({
  load = loadEntries,
  doc = globalThis.document,
  url = globalThis.URL,
  now = new Date(),
  csv = monthCsv,
} = {}) {
  let count = 0;
  const { filename } = await exportCsv({
    list: async () => frozenSnapshot(await load({ now })),
    doc,
    url,
    now,
    toCsv: (entries, at) => {
      const text = csv(entries, at);
      count = text.split('\r\n').length - 1;
      return CSV_BOM + text;
    },
  });
  return { filename, count };
}

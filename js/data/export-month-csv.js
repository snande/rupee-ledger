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
 */

import { exportCsv } from '../../src/backup-download.js';
import { CSV_BOM, monthCsv } from '../../src/csv-export.js';
import { loadEntries } from './ledger.js';

/**
 * Downloads this month's spends as a CSV file whose text starts with the
 * UTF-8 BOM, then monthCsv()'s header and rows.
 * @param {{ load?: (options: { now: Date }) => Promise<Array<object>>,
 *   doc?: Document, url?: { createObjectURL: Function, revokeObjectURL: Function },
 *   now?: Date }} [options]  `load` defaults to loadEntries(); `doc`, `url`
 *   and `now` are passed to exportCsv() and default as it does.
 * @returns {Promise<{ filename: string, count: number }>}  the file's name
 *   and how many spend rows it holds. Rejects, having downloaded nothing,
 *   when the read fails.
 */
export async function exportMonthCsv({
  load = loadEntries,
  doc = globalThis.document,
  url = globalThis.URL,
  now = new Date(),
} = {}) {
  let count = 0;
  const { filename } = await exportCsv({
    list: () => load({ now }),
    doc,
    url,
    now,
    toCsv: (entries, at) => {
      const text = monthCsv(entries, at);
      count = text.split('\r\n').length - 1;
      return CSV_BOM + text;
    },
  });
  return { filename, count };
}

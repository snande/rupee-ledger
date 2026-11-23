// Turns this month's spends into CSV text: Date, Amount (₹), Category, Note.
// Uses the same rule as the This month card in src/totals.js (datedPaise and
// inMonth), so the Amount cells sum to that total. Pure: no DOM, no storage,
// no network; it never modifies the entries it is given.
//
// CSV_HEADER, csvFilename(now) and serializeCsv(rows) define the file itself:
// its header row, its rupee-ledger-YYYY-MM.csv name for the local month, and
// its text (a UTF-8 BOM, the header and a CRLF, then one CRLF-ended line per
// row), so a month with no spends still yields a header-only file. Wiring the
// month's spends in and the Export CSV download live elsewhere.

import { datedPaise, inMonth } from './totals.js';

/** The header row of the CSV file. */
export const CSV_HEADER = 'Date,Amount (₹),Category,Note';

/** The UTF-8 byte order mark, so spreadsheet apps read ₹ correctly. */
export const CSV_BOM = '﻿';

export const MONTH_CSV_HEADER = CSV_HEADER;

/**
 * The CSV file's name for the month of `now` on the device's local
 * calendar (not UTC): `rupee-ledger-YYYY-MM.csv`, the month zero-padded,
 * e.g. `rupee-ledger-2025-03.csv`.
 * @param {Date} now
 * @returns {string}
 */
export function csvFilename(now) {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `rupee-ledger-${year}-${month}.csv`;
}

/**
 * The CSV file's text: the BOM, the header line and a CRLF, then each row's
 * cells (quoted per RFC 4180 when needed) joined by commas and ended by a
 * CRLF. With no rows it is the BOM, the header and one CRLF alone.
 * @param {Array<Array<unknown>>} rows  Each row is an array of cells in
 *   header order (Date, Amount, Category, Note); `null`/`undefined` cells
 *   are written empty.
 * @returns {string}
 * @throws {TypeError} when `rows` is not an array or any row is not an
 *   array of cells, rather than silently writing a header-only file.
 */
export function serializeCsv(rows) {
  if (!Array.isArray(rows)) throw new TypeError('serializeCsv expects an array of rows.');
  let text = `${CSV_BOM}${CSV_HEADER}\r\n`;
  rows.forEach((row, index) => {
    if (!Array.isArray(row)) {
      throw new TypeError(`serializeCsv row ${index} is not an array of cells.`);
    }
    text += `${row.map(csvField).join(',')}\r\n`;
  });
  return text;
}

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

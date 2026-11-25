// CI check: the CSV that monthCsv builds matches the ledger records exactly.
//
// Seeds known month-to-date spends (one with paise, one at 00:00 on the 1st,
// one at `now`, and the typed lines `45.05 chai, samosa`, `120 "special"
// thali` and `123450 rent` run through parseEntry) plus spends that must stay
// out of the file (23:59 on the last day of the previous month, later on the
// same day as `now`), builds the CSV with monthCsv, and checks that every row
// has exactly four cells and that its Date, Amount and Note match its record.
// Prints `CSV_EXACT mismatches=<n> missing=<n> extra=<n>` and exits non-zero
// unless all three are 0. `npm test` runs it after `node --test`.
//
// The expected Date and Amount are worked out here, independently of
// src/csv-export.js: the Date is the record's local calendar day as
// YYYY-MM-DD, and the Amount cell must read back as exactly the record's
// integer paise (string arithmetic, no floating point).

import { pathToFileURL } from 'node:url';

import { CSV_HEADER, monthCsv } from '../src/csv-export.js';
import { parseEntry } from '../src/parse-entry.js';

/** The reference moment the seed is built around: 23 Nov 2026, 15:00 local. */
export const NOW = new Date(2026, 10, 23, 15, 0);

/**
 * The amount and note of a quick-entry line typed into the app, exactly as
 * parseEntry reads it.
 * @param {string} line
 * @returns {{ amountPaise: number, note: string }}
 */
function typed(line) {
  const parsed = parseEntry(line);
  if (!parsed) throw new Error(`parseEntry rejected the seed line ${JSON.stringify(line)}`);
  return { amountPaise: parsed.amountPaise, note: parsed.note };
}

/**
 * The seeded ledger records for the month of `now`. Each carries `expected`:
 * whether its row belongs in the CSV. Three of them are typed spends that go
 * through parseEntry, as the quick-entry box does. Notes are unique, and so
 * is each record's Date and Amount, so a row is matched to its record by its
 * Note cell, or failing that by its Date and Amount.
 * @param {Date} now
 * @returns {Array<{ id: string, amountPaise: number, note: string,
 *                   category: string, timestamp: number, expected: boolean }>}
 */
export function seedSpends(now = NOW) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const at = (...parts) => new Date(...parts).getTime();
  return [
    { id: 'first', amountPaise: 12000, note: 'auto at midnight on the 1st', category: 'Transport',
      timestamp: at(year, month, 1, 0, 0), expected: true },
    { id: 'typed-chai', ...typed('45.05 chai, samosa'), category: 'Food',
      timestamp: at(year, month, 5, 8, 15), expected: true },
    { id: 'typed-thali', ...typed('120 "special" thali'), category: 'Food',
      timestamp: at(year, month, 9, 13, 0), expected: true },
    { id: 'paise', amountPaise: 4550, note: 'tea, biscuits', category: 'Food',
      timestamp: at(year, month, 12, 9, 30), expected: true },
    { id: 'typed-rent', ...typed('123450 rent'), category: 'Home',
      timestamp: at(year, month, 15, 10, 0), expected: true },
    { id: 'big', amountPaise: 12345007, note: 'rent "Nov", deposit', category: 'Home',
      timestamp: at(year, month, 20, 18, 45), expected: true },
    { id: 'one-paisa', amountPaise: 1, note: 'one paisa', category: 'Misc',
      timestamp: at(year, month, 22, 12, 0), expected: true },
    { id: 'now', amountPaise: 99999, note: 'bought just now', category: 'Shopping',
      timestamp: now.getTime(), expected: true },
    { id: 'prior-month', amountPaise: 99900, note: 'last day of last month', category: 'Shopping',
      timestamp: at(year, month, 0, 23, 59), expected: false },
    { id: 'after-now', amountPaise: 5000, note: 'later today', category: 'Food',
      timestamp: now.getTime() + 60_000, expected: false },
  ];
}

/* The local calendar date of epoch milliseconds `ms` as YYYY-MM-DD. */
function localDate(ms) {
  const at = new Date(ms);
  const year = String(at.getFullYear()).padStart(4, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * A rupee Amount cell such as `45.5` or `120` as integer paise, without
 * floating point; `null` for anything that is not a plain rupee amount with
 * at most two decimal places.
 * @param {string} cell
 * @returns {number | null}
 */
export function cellToPaise(cell) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cell);
  if (!match) return null;
  const [, sign, rupees, fraction = ''] = match;
  const paise = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return null;
  return sign ? -paise : paise;
}

/**
 * CSV text parsed per RFC 4180 into rows of cells; a leading BOM and the
 * trailing empty line after a final CRLF are dropped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && source[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Compares the CSV's rows with the seeded records. A row is matched to its
 * record by its Note cell; a row whose Note matches no record (a changed note,
 * or a note that spilled into extra columns) is matched instead to the
 * not-yet-matched record with the same Date and Amount.
 * - mismatches: rows whose record is expected but which do not have exactly
 *   four cells, or whose Date, Amount or Note differs from the record.
 * - missing: expected records with no row.
 * - extra: rows with no record, rows for a record that must stay out (such
 *   as a prior-month spend), and repeat rows for the same record.
 * @param {string} csvText
 * @param {ReturnType<typeof seedSpends>} records
 * @returns {{ mismatches: number, missing: number, extra: number, details: string[] }}
 */
export function compareCsv(csvText, records) {
  const rows = parseCsv(csvText);
  const header = rows[0]?.join(',');
  const dataRows = header === CSV_HEADER ? rows.slice(1) : rows;

  const byNote = new Map(records.map((record) => [record.note, record]));
  const seen = new Set();
  const details = [];
  let mismatches = 0;
  let extra = 0;

  const addExtra = (cells, index) => {
    extra += 1;
    details.push(`extra row ${index + 1}: ${JSON.stringify(cells)}`);
  };

  const check = (cells, record) => {
    seen.add(record.id);
    const [date, amount, , note] = cells;
    const wantDate = localDate(record.timestamp);
    const gotPaise = cellToPaise(amount ?? '');
    if (cells.length !== 4 || date !== wantDate || gotPaise !== record.amountPaise || note !== record.note) {
      mismatches += 1;
      details.push(
        `mismatch for ${record.id}: got ${cells.length} cells ${JSON.stringify(cells)}, ` +
          `want 4 cells with Date "${wantDate}" Amount of ${record.amountPaise} paise ` +
          `Note ${JSON.stringify(record.note)}`,
      );
    }
  };

  // First pass: rows whose Note cell names a record.
  const unmatched = [];
  dataRows.forEach((cells, index) => {
    const record = byNote.get(cells[3]);
    if (!record) {
      unmatched.push([cells, index]);
    } else if (!record.expected || seen.has(record.id)) {
      addExtra(cells, index);
    } else {
      check(cells, record);
    }
  });

  // Second pass: rows whose Note names no record, matched by Date and Amount.
  unmatched.forEach(([cells, index]) => {
    const [date, amount] = cells;
    const gotPaise = cellToPaise(amount ?? '');
    const record = records.find((candidate) => !seen.has(candidate.id)
      && localDate(candidate.timestamp) === date && candidate.amountPaise === gotPaise);
    if (!record || !record.expected) {
      addExtra(cells, index);
    } else {
      check(cells, record);
    }
  });

  let missing = 0;
  records.forEach((record) => {
    if (record.expected && !seen.has(record.id)) {
      missing += 1;
      details.push(`missing row for ${record.id}`);
    }
  });

  return { mismatches, missing, extra, details };
}

/**
 * Builds the CSV for the seeded spends with `build`, prints the CSV_EXACT
 * line (and a line per problem on stderr) and returns the exit code.
 * @param {{ build?: (entries: object[], now: Date) => string,
 *           now?: Date, log?: (line: string) => void,
 *           warn?: (line: string) => void }} [options]
 * @returns {number}  0 when every count is 0, otherwise 1.
 */
export function runCheck({ build = monthCsv, now = NOW, log = console.log, warn = console.error } = {}) {
  const records = seedSpends(now);
  const entries = records.map(({ expected, ...entry }) => entry);
  const result = compareCsv(build(entries, now), records);
  result.details.forEach((line) => warn(line));
  log(`CSV_EXACT mismatches=${result.mismatches} missing=${result.missing} extra=${result.extra}`);
  return result.mismatches === 0 && result.missing === 0 && result.extra === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCheck();
}

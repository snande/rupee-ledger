import { test } from 'node:test';
import assert from 'node:assert/strict';

import { monthCsv, MONTH_CSV_HEADER } from './csv-export.js';
import { totals } from './totals.js';

const NOW = new Date(2026, 10, 23, 15, 0); // 23 Nov 2026, 15:00 local.

/* A minimal RFC 4180 parser so the tests read the CSV the way a spreadsheet would. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
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
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function seed() {
  return [
    { id: 'a', amountPaise: 4550, note: 'chai, samosa', category: 'Food',
      timestamp: new Date(2026, 10, 12, 9, 30).getTime() },
    { id: 'b', amountPaise: 12000, note: 'auto', category: 'Transport',
      timestamp: new Date(2026, 10, 1, 0, 0).getTime() },
    { id: 'c', amountPaise: 12345000, note: 'rent "Nov"', category: 'Home',
      timestamp: new Date(2026, 10, 23, 14, 59).getTime() },
    { id: 'd', amountPaise: 99900, note: 'last month', category: 'Shopping',
      timestamp: new Date(2026, 9, 31, 23, 59).getTime() },
    { id: 'e', amountPaise: 2000, note: 'line\nbreak', category: 'Misc',
      timestamp: new Date(2026, 10, 23, 0, 0).getTime() },
  ];
}

const EXPECTED_DATES = { a: '2026-11-12', b: '2026-11-01', c: '2026-11-23', e: '2026-11-23' };

test('row 1 is the header and there is one row per spend this month up to now, oldest first', () => {
  const rows = parseCsv(monthCsv(seed(), NOW));
  assert.equal(monthCsv(seed(), NOW).split('\r\n')[0], 'Date,Amount (₹),Category,Note');
  assert.deepEqual(rows[0], ['Date', 'Amount (₹)', 'Category', 'Note']);
  assert.deepEqual(rows.slice(1), [
    ['2026-11-01', '120', 'Transport', 'auto'],
    ['2026-11-12', '45.5', 'Food', 'chai, samosa'],
    ['2026-11-23', '20', 'Misc', 'line\nbreak'],
    ['2026-11-23', '123450', 'Home', 'rent "Nov"'],
  ]);
});

test('amounts are plain rupees: no ₹ sign, no grouping commas', () => {
  const at = new Date(2026, 10, 5, 12).getTime();
  const csv = monthCsv([
    { amountPaise: 12000, note: '', category: '', timestamp: at },
    { amountPaise: 4550, note: '', category: '', timestamp: at + 1 },
    { amountPaise: 12345000, note: '', category: '', timestamp: at + 2 },
  ], NOW);
  const amounts = parseCsv(csv).slice(1).map((row) => row[1]);
  assert.deepEqual(amounts, ['120', '45.5', '123450']);
});

test('each Date cell is the local calendar date, with no missing or extra rows', () => {
  const entries = seed();
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  const expected = entries
    .filter((entry) => entry.id in EXPECTED_DATES)
    .map((entry) => EXPECTED_DATES[entry.id])
    .sort();
  assert.deepEqual(rows.map((row) => row[0]).sort(), expected);
});

test('the Amount cells sum, in paise, to the This month total', () => {
  const entries = seed();
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  const sum = rows.reduce((total, row) => total + Math.round(Number(row[1]) * 100), 0);
  assert.equal(sum, totals(entries, NOW).month);
});

test('spends after now, earlier months and unusable entries are left out', () => {
  const csv = monthCsv([
    { amountPaise: 500, note: 'later today', category: 'Food',
      timestamp: new Date(2026, 10, 23, 15, 1).getTime() },
    { amountPaise: 500, note: 'last year', category: 'Food',
      timestamp: new Date(2025, 10, 10).getTime() },
    { note: 'no amount', category: 'Food', timestamp: NOW.getTime() - 1 },
    { amountPaise: 500, note: 'no time', category: 'Food' },
    null,
  ], NOW);
  assert.equal(csv, MONTH_CSV_HEADER);
});

test('Category and Note round-trip, quoted per RFC 4180 only when needed', () => {
  const csv = monthCsv(seed(), NOW);
  assert.ok(csv.includes('"chai, samosa"'));
  assert.ok(csv.includes('"rent ""Nov"""'));
  assert.ok(csv.includes(',Transport,auto'));
  const byNote = new Map(parseCsv(csv).slice(1).map((row) => [row[3], row[2]]));
  for (const entry of seed().filter((e) => e.id in EXPECTED_DATES)) {
    assert.equal(byNote.get(entry.note), entry.category);
  }
});

test('monthCsv leaves its entries argument unmodified', () => {
  const entries = seed();
  const before = structuredClone(entries);
  monthCsv(entries, NOW);
  assert.deepEqual(entries, before);
});

test('bad input gives just the header', () => {
  assert.equal(monthCsv(undefined, NOW), MONTH_CSV_HEADER);
  assert.equal(monthCsv(seed(), 'not a date'), MONTH_CSV_HEADER);
});

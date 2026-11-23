import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CSV_EOL, CSV_HEADER, csvField, monthCsv } from './csv-export.js';
import { totals } from './totals.js';

// All fixtures are local-time Dates, so the tests hold in any time zone.
const NOW = new Date(2026, 10, 23, 15, 0); // 23 Nov 2026, 15:00 local

const at = (...parts) => new Date(...parts).getTime();

function seeded() {
  return [
    { id: 'a', amountPaise: 12000, note: 'lunch', category: 'Food', timestamp: at(2026, 10, 1, 0, 0) },
    { id: 'b', amountPaise: 4550, note: 'chai, samosa', category: 'Food', timestamp: at(2026, 10, 23, 14, 59) },
    { id: 'c', amountPaise: 12345000, note: 'rent "Nov"', category: 'Home', timestamp: at(2026, 10, 10, 9, 30) },
    { id: 'd', amountPaise: 999, note: 'line one\nline two', category: 'Misc, other', timestamp: at(2026, 10, 15, 20, 0) },
    { id: 'old', amountPaise: 777, note: 'last month', category: 'Food', timestamp: at(2026, 9, 31, 23, 59) },
    { id: 'bad', amountPaise: 100, note: 'no time', category: 'Food' },
  ];
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/* Minimal RFC 4180 parser (CRLF records): an array of records of fields. */
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') {
      record.push(field); records.push(record); record = []; field = ''; i += 1;
    } else field += ch;
  }
  record.push(field);
  records.push(record);
  return records;
}

test('row 1 is exactly the header, and records end in CRLF', () => {
  const text = monthCsv(seeded(), NOW);
  assert.equal(CSV_EOL, '\r\n');
  assert.equal(text.split(CSV_EOL)[0], 'Date,Amount (₹),Category,Note');
  assert.equal(CSV_HEADER, 'Date,Amount (₹),Category,Note');
});

test('one row per spend this month up to now, oldest first, none from last month or the future', () => {
  const entries = [
    ...seeded(),
    { id: 'later-today', amountPaise: 500, note: 'later', category: 'Food', timestamp: at(2026, 10, 23, 15, 1) },
    { id: 'next-month', amountPaise: 500, note: 'dec', category: 'Food', timestamp: at(2026, 11, 1, 0, 0) },
  ];
  const [header, ...rows] = parseCsv(monthCsv(entries, NOW));
  assert.deepEqual(header, ['Date', 'Amount (₹)', 'Category', 'Note']);
  assert.deepEqual(rows.map((r) => r[3]), ['lunch', 'rent "Nov"', 'line one\nline two', 'chai, samosa']);
});

test('records stored with createdAt, as the ledger keeps them, get their rows', () => {
  // The shape src/ledger.js add() and listForMonth() return.
  const stored = [
    { id: 2, schemaVersion: 1, amountPaise: 4550, note: 'auto', category: 'Transport', createdAt: at(2026, 10, 20, 8, 15) },
    { id: 1, schemaVersion: 1, amountPaise: 12000, note: 'groceries', category: 'Food', createdAt: at(2026, 10, 1, 0, 0) },
    { id: 3, schemaVersion: 1, amountPaise: 300, note: 'october', category: 'Food', createdAt: at(2026, 9, 31, 23, 59) },
  ];
  const rows = parseCsv(monthCsv(stored, NOW)).slice(1);
  assert.deepEqual(rows, [
    ['2026-11-01', '120', 'Food', 'groceries'],
    ['2026-11-20', '45.5', 'Transport', 'auto'],
  ]);
  const sum = rows.reduce((acc, r) => acc + Math.round(Number(r[1]) * 100), 0);
  assert.equal(sum, totals(stored, NOW).month);
});

test('a missing or invalid list gives only the header', () => {
  assert.equal(monthCsv(undefined, NOW), CSV_HEADER);
  assert.equal(monthCsv([], NOW), CSV_HEADER);
  assert.equal(monthCsv(seeded(), 'not a date'), CSV_HEADER);
});

test('Amount cells are plain rupees: no ₹ sign, no grouping commas', () => {
  const entries = [
    { amountPaise: 12000, category: 'A', note: '', timestamp: at(2026, 10, 2, 10) },
    { amountPaise: 4550, category: 'A', note: '', timestamp: at(2026, 10, 3, 10) },
    { amountPaise: 12345000, category: 'A', note: '', timestamp: at(2026, 10, 4, 10) },
  ];
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  assert.deepEqual(rows.map((r) => r[1]), ['120', '45.5', '123450']);
});

test('each Date cell is the spend\'s local calendar date, row for row', () => {
  const entries = seeded();
  const expected = entries
    .filter((e) => e.timestamp !== undefined)
    .filter((e) => {
      const d = new Date(e.timestamp);
      return d.getFullYear() === NOW.getFullYear() && d.getMonth() === NOW.getMonth()
        && e.timestamp <= NOW.getTime();
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  assert.equal(rows.length, expected.length);
  rows.forEach((row, i) => {
    assert.equal(row[0], localDate(expected[i].timestamp));
    assert.equal(row[1], String(expected[i].amountPaise / 100));
    assert.equal(row[2], expected[i].category);
    assert.equal(row[3], expected[i].note);
  });
  assert.deepEqual(rows.map((r) => r[0]), ['2026-11-01', '2026-11-10', '2026-11-15', '2026-11-23']);
});

test('Amount cells summed in paise equal the This month total', () => {
  const entries = seeded();
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  const sum = rows.reduce((acc, r) => acc + Math.round(Number(r[1]) * 100), 0);
  assert.equal(sum, totals(entries, NOW).month);
});

test('a spend dated later this month than now counts toward totals but is not exported yet', () => {
  const later = { id: 'later', amountPaise: 2500, note: 'booked', category: 'Travel', timestamp: at(2026, 10, 28, 9, 0) };
  const entries = [...seeded(), later];
  const rows = parseCsv(monthCsv(entries, NOW)).slice(1);
  const sum = rows.reduce((acc, r) => acc + Math.round(Number(r[1]) * 100), 0);
  assert.ok(!rows.some((r) => r[3] === 'booked'));
  assert.equal(sum, totals(entries, NOW).month - later.amountPaise);
  // Once `now` reaches it, the sums agree again.
  const end = new Date(2026, 10, 30, 23, 59);
  const allRows = parseCsv(monthCsv(entries, end)).slice(1);
  assert.equal(
    allRows.reduce((acc, r) => acc + Math.round(Number(r[1]) * 100), 0),
    totals(entries, end).month,
  );
});

test('Category and Note round-trip, including commas, quotes and newlines', () => {
  const text = monthCsv(seeded(), NOW);
  assert.ok(text.includes('"chai, samosa"'));
  assert.ok(text.includes('"rent ""Nov"""'));
  assert.ok(text.includes('"Misc, other"'));
  const rows = parseCsv(text).slice(1);
  assert.deepEqual(rows.map((r) => [r[2], r[3]]), [
    ['Food', 'lunch'],
    ['Home', 'rent "Nov"'],
    ['Misc, other', 'line one\nline two'],
    ['Food', 'chai, samosa'],
  ]);
});

test('csvField quotes only when needed and treats missing values as empty', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('x\r\ny'), '"x\r\ny"');
});

test('monthCsv leaves its entries argument unmodified', () => {
  const entries = seeded().reverse();
  const before = structuredClone(entries);
  const refs = [...entries];
  monthCsv(entries, NOW);
  assert.deepEqual(entries, before);
  entries.forEach((e, i) => assert.equal(e, refs[i]));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { searchEntries } from './search.js';

// Local-time epoch milliseconds, as src/ledger/store.js stores `createdAt`.
const at = (year, month, day, hours = 12) => new Date(year, month - 1, day, hours).getTime();

// Oldest first, the order `listEntries` returns, spanning three months.
const ENTRIES = [
  { id: 1, amount: 2000, note: 'chai', category: 'Food', createdAt: at(2026, 7, 3) },
  { id: 2, amount: 15000, note: 'auto', category: 'Transport', createdAt: at(2026, 7, 9) },
  { id: 3, amount: 4550, note: 'Masala CHAI and samosa', category: 'Food', createdAt: at(2026, 8, 14) },
  { id: 4, amount: 120000, note: 'groceries', category: 'Groceries', createdAt: at(2026, 9, 1) },
  { id: 5, amount: 1500, note: 'cutting chai', category: 'Food', createdAt: at(2026, 9, 28) },
];

test('matches every entry whose note contains the query, across months, newest first', () => {
  const { matches, total } = searchEntries(ENTRIES, 'chai');
  assert.deepEqual(matches.map((entry) => entry.id), [5, 3, 1]);
  assert.equal(total, 1500 + 4550 + 2000);
});

test('matching ignores case in both the query and the note, and trims the query', () => {
  assert.deepEqual(searchEntries(ENTRIES, '  ChAi ').matches.map((entry) => entry.id), [5, 3, 1]);
  assert.deepEqual(searchEntries(ENTRIES, 'SAMOSA').matches.map((entry) => entry.id), [3]);
});

test('totals quick-entry records by amountPaise in integer paise', () => {
  const entries = [
    { amountPaise: 12000, note: 'chai', createdAt: at(2026, 9, 30, 9) },
    { amountPaise: 4550, note: 'chai', createdAt: at(2026, 6, 30, 9) },
    { amountPaise: 8000, note: 'auto', createdAt: at(2026, 9, 30, 10) },
  ];
  assert.deepEqual(searchEntries(entries, 'chai'), { matches: [entries[0], entries[1]], total: 16550 });
});

test('a blank or whitespace-only query returns no matches and a zero total', () => {
  assert.deepEqual(searchEntries(ENTRIES, ''), { matches: [], total: 0 });
  assert.deepEqual(searchEntries(ENTRIES, '   '), { matches: [], total: 0 });
  assert.deepEqual(searchEntries(ENTRIES, undefined), { matches: [], total: 0 });
});

test('no match, missing notes and a non-array list give no matches', () => {
  assert.deepEqual(searchEntries(ENTRIES, 'petrol'), { matches: [], total: 0 });
  assert.deepEqual(searchEntries([{ amount: 100, createdAt: at(2026, 9, 1) }], 'chai'), { matches: [], total: 0 });
  assert.deepEqual(searchEntries(null, 'chai'), { matches: [], total: 0 });
});

test('entries without a usable date are kept, after the dated ones', () => {
  const undated = { amount: 300, note: 'chai' };
  const dated = { amount: 200, note: 'chai', createdAt: at(2026, 1, 1) };
  assert.deepEqual(searchEntries([undated, dated], 'chai'), { matches: [dated, undated], total: 500 });
});

test('does not reorder or change the list it is given', () => {
  const entries = ENTRIES.map((entry) => ({ ...entry }));
  searchEntries(entries, 'chai');
  assert.deepEqual(entries, ENTRIES);
});

test('the module is pure: no imports, network, storage or DOM', async () => {
  const source = await readFile(new URL('./search.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(source, /\b(?:indexedDB|localStorage|sessionStorage|document|window|navigator)\b/);
});

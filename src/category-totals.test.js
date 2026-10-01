import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { categoryTotalsForMonth } from './category-totals.js';
import { totals } from './totals.js';

// Built with the local-time Date constructor, so every fixture means the
// same wall-clock moment whatever time zone the tests run in.
const at = (year, month, day, hours = 12, minutes = 0) =>
  new Date(year, month - 1, day, hours, minutes);

const sum = (rows) => rows.reduce((total, row) => total + row.amount, 0);

test('groups the month by category in paise, largest first', () => {
  const entries = [
    { amount: 120, category: 'Food', timestamp: at(2026, 9, 3) },
    { amount: 80, category: 'Travel', timestamp: at(2026, 9, 10) },
    { amount: 45.5, category: 'Food', timestamp: at(2026, 9, 30) },
    { amount: 300, category: 'Rent', timestamp: at(2026, 9, 1) },
  ];
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 9), [
    { category: 'Rent', amount: 30000 },
    { category: 'Food', amount: 16550 },
    { category: 'Travel', amount: 8000 },
  ]);
});

test('equal amounts are ordered by category name', () => {
  const entries = ['b', 'a', 'c'].map((category) => ({ amount: 10, category, timestamp: at(2026, 9, 5) }));
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 9).map((row) => row.category), ['a', 'b', 'c']);
});

test('only entries in that local calendar month count, as in totals()', () => {
  const entries = [
    { amount: 99, category: 'Food', timestamp: at(2026, 1, 31, 23, 59) },
    { amount: 50, category: 'Food', timestamp: at(2026, 2, 1, 0, 0) },
    { amount: 70, category: 'Food', timestamp: at(2025, 12, 31, 23, 59) },
    { amount: 20, category: 'Food', ts: at(2026, 1, 1, 0, 0).getTime() },
  ];
  const january = categoryTotalsForMonth(entries, 2026, 1);
  assert.deepEqual(january, [{ category: 'Food', amount: 11900 }]);
  assert.equal(sum(january), totals(entries, at(2026, 1, 15)).month);
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 2), [{ category: 'Food', amount: 5000 }]);
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 3), []);
});

test('missing, null and empty categories are grouped as Uncategorised', () => {
  const day = at(2026, 9, 12);
  const entries = [
    { amount: 1, timestamp: day },
    { amount: 2, category: null, timestamp: day },
    { amount: 3, category: '', timestamp: day },
    { amount: 4, category: '   ', timestamp: day },
    { amount: 5, category: 'Food', timestamp: day },
  ];
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 9), [
    { category: 'Uncategorised', amount: 1000 },
    { category: 'Food', amount: 500 },
  ]);
});

test('category amounts add up exactly to the totals() month total, fractional rupees included', () => {
  const categories = ['Food', 'Travel', 'Rent', '', null, undefined, 'Bills'];
  const amounts = [0.1, 0.2, 0.7, 19.99, 45.55, 0.01, 1.005, 333.33, 12.345];
  let seed = 47;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  for (let round = 0; round < 200; round += 1) {
    const entries = Array.from({ length: 1 + next(40) }, () => ({
      amount: next(3) === 0 ? next(100000) / 100 : amounts[next(amounts.length)],
      category: categories[next(categories.length)],
      timestamp: at(2026, 8 + next(3), 1 + next(28), next(24), next(60)),
    }));
    const rows = categoryTotalsForMonth(entries, 2026, 9);
    assert.equal(sum(rows), totals(entries, at(2026, 9, 15)).month);
    for (const row of rows) assert.ok(Number.isInteger(row.amount));
  }
});

test('entries without a usable amount or timestamp are skipped, as in totals()', () => {
  const day = at(2026, 9, 30);
  const entries = [
    { amount: 120, category: 'Food', timestamp: day },
    { amount: Number.NaN, category: 'Food', timestamp: day },
    { amount: '80', category: 'Food', timestamp: day },
    { category: 'Food', timestamp: day },
    { amount: 50, category: 'Food' },
    { amount: 50, category: 'Food', timestamp: 'not a date' },
    null,
  ];
  assert.deepEqual(categoryTotalsForMonth(entries, 2026, 9), [{ category: 'Food', amount: 12000 }]);
  assert.equal(totals(entries, day).month, 12000);
  assert.deepEqual(categoryTotalsForMonth([], 2026, 9), []);
  assert.deepEqual(categoryTotalsForMonth(undefined, 2026, 9), []);
});

test('the module is pure: no DOM, network or IndexedDB access', async () => {
  const source = await readFile(new URL('./category-totals.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  for (const api of ['document', 'window', 'fetch', 'XMLHttpRequest', 'indexedDB', 'localStorage', 'navigator']) {
    assert.ok(!new RegExp(`\\b${api}\\b`).test(code), `uses ${api}`);
  }
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./totals.js']);
});

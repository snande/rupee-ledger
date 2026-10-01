import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { compareMonths, UNCATEGORISED } from './compare-months.js';
import { totals } from './totals.js';

// Built with the local-time Date constructor, so every fixture means the
// same wall-clock moment whatever time zone the tests run in.
const at = (year, month, day, hours = 12, minutes = 0) =>
  new Date(year, month - 1, day, hours, minutes);

const entries = [
  { amount: 120, category: 'Food', timestamp: at(2026, 8, 3) },
  { amount: 300, category: 'Rent', timestamp: at(2026, 8, 1) },
  { amount: 40, category: 'Travel', timestamp: at(2026, 8, 20) },
  { amount: 200, category: 'Food', timestamp: at(2026, 9, 4) },
  { amount: 45.5, category: 'Food', timestamp: at(2026, 9, 30, 23, 59) },
  { amount: 300, category: 'Rent', timestamp: at(2026, 9, 1) },
  { amount: 99, category: 'Books', timestamp: at(2026, 9, 12) },
];

test('totals each month overall and by category, in paise', () => {
  const result = compareMonths(entries, '2026-08', '2026-09');
  assert.deepEqual(result.a, {
    month: '2026-08',
    total: 46000,
    byCategory: { Rent: 30000, Food: 12000, Travel: 4000, Books: 0 },
  });
  assert.deepEqual(result.b, {
    month: '2026-09',
    total: 64450,
    byCategory: { Rent: 30000, Food: 24550, Books: 9900, Travel: 0 },
  });
});

test('diff is month b minus month a, a missing category counting as 0', () => {
  const { diff } = compareMonths(entries, '2026-08', '2026-09');
  assert.equal(diff.total, 64450 - 46000);
  assert.deepEqual(diff.byCategory, { Rent: 0, Food: 12550, Travel: -4000, Books: 9900 });
});

test('returns { a, b, diff }, every category on every side, diff = b - a', () => {
  const result = compareMonths(entries, '2026-08', '2026-09');
  assert.deepEqual(Object.keys(result), ['a', 'b', 'diff']);
  assert.deepEqual(Object.keys(result.a), ['month', 'total', 'byCategory']);
  assert.deepEqual(Object.keys(result.b), ['month', 'total', 'byCategory']);
  assert.deepEqual(Object.keys(result.diff), ['total', 'byCategory']);

  assert.equal(result.diff.total, result.b.total - result.a.total);
  const categories = ['Rent', 'Food', 'Travel', 'Books'];
  for (const side of [result.a.byCategory, result.b.byCategory, result.diff.byCategory]) {
    assert.deepEqual(Object.keys(side).sort(), [...categories].sort());
  }
  for (const category of categories) {
    assert.equal(result.diff.byCategory[category], result.b.byCategory[category] - result.a.byCategory[category]);
  }
  assert.equal(result.a.byCategory.Books, 0);
  assert.equal(result.b.byCategory.Travel, 0);
});

test('swapping the months negates every difference', () => {
  const { diff } = compareMonths(entries, '2026-09', '2026-08');
  assert.equal(diff.total, -18450);
  assert.deepEqual(diff.byCategory, { Rent: 0, Food: -12550, Books: -9900, Travel: 4000 });
});

test('missing, empty, blank and null categories are grouped as Uncategorised', () => {
  const loose = [
    { amount: 10, timestamp: at(2026, 9, 2) },
    { amount: 20, category: '', timestamp: at(2026, 9, 3) },
    { amount: 30, category: '   ', timestamp: at(2026, 9, 4) },
    { amount: 40, category: null, timestamp: at(2026, 9, 5) },
    { amount: 5, category: 'Food', timestamp: at(2026, 9, 6) },
  ];
  const result = compareMonths(loose, '2026-08', '2026-09');
  assert.equal(UNCATEGORISED, 'Uncategorised');
  assert.deepEqual(result.b.byCategory, { Uncategorised: 10000, Food: 500 });
  assert.deepEqual(result.diff.byCategory, { Uncategorised: 10000, Food: 500 });
});

test('entries outside the two months change nothing', () => {
  const outside = [
    ...entries,
    { amount: 1000, category: 'Food', timestamp: at(2026, 7, 31, 23, 59) },
    { amount: 1000, category: 'Gifts', timestamp: at(2026, 10, 1, 0, 0) },
    { amount: 1000, category: 'Rent', timestamp: at(2025, 9, 15) },
    { amount: 1000, category: 'Food' },
    { category: 'Food', timestamp: at(2026, 9, 15) },
  ];
  assert.deepEqual(compareMonths(outside, '2026-08', '2026-09'), compareMonths(entries, '2026-08', '2026-09'));
});

test('agrees with totals() for each month', () => {
  const result = compareMonths(entries, '2026-08', '2026-09');
  assert.equal(result.a.total, totals(entries, at(2026, 8, 15)).month);
  assert.equal(result.b.total, totals(entries, at(2026, 9, 15)).month);
});

test('an empty month totals 0 with an empty category map, without throwing', () => {
  const result = compareMonths(entries, '2026-01', '2026-09');
  assert.deepEqual(result.a, { month: '2026-01', total: 0, byCategory: {} });
  assert.equal(result.diff.total, result.b.total);
  assert.deepEqual(result.diff.byCategory, result.b.byCategory);
});

test('no entries, or not an array, gives zeros', () => {
  for (const none of [[], undefined, null, 'nope']) {
    assert.deepEqual(compareMonths(none, '2026-08', '2026-09'), {
      a: { month: '2026-08', total: 0, byCategory: {} },
      b: { month: '2026-09', total: 0, byCategory: {} },
      diff: { total: 0, byCategory: {} },
    });
  }
});

test('accepts { year, month } identifiers as well as YYYY-MM strings', () => {
  assert.deepEqual(
    compareMonths(entries, { year: 2026, month: 8 }, { year: 2026, month: 9 }),
    compareMonths(entries, '2026-08', '2026-09'),
  );
});

test('a category named like an Object property is still counted from 0', () => {
  const odd = [{ amount: 7, category: 'constructor', timestamp: at(2026, 9, 1) }];
  assert.deepEqual(compareMonths(odd, '2026-08', '2026-09').diff.byCategory, { constructor: 700 });
});

test('a malformed month identifier throws a TypeError', () => {
  for (const bad of ['2026-13', '2026-00', '2026-9', 'September', '', null, undefined, 202609, { year: 2026 }]) {
    assert.throws(() => compareMonths(entries, bad, '2026-09'), TypeError);
    assert.throws(() => compareMonths(entries, '2026-09', bad), TypeError);
  }
});

test('is pure: no DOM, storage or network', async () => {
  const source = await readFile(new URL('./compare-months.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const api of ['document', 'window', 'fetch', 'XMLHttpRequest', 'indexedDB', 'localStorage', 'navigator']) {
    assert.ok(!new RegExp(`\\b${api}\\b`).test(code), `uses ${api}`);
  }
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./category-totals.js']);
});

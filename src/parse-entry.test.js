import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseEntry } from './parse-entry.js';

test('parses an amount followed by a note', () => {
  assert.deepEqual(parseEntry('120 chai'), { amountPaise: 12000, note: 'chai' });
  assert.deepEqual(parseEntry('35 bus ticket'), { amountPaise: 3500, note: 'bus ticket' });
});

test('accepts a ₹ or Rs prefix and up to two decimal places', () => {
  assert.deepEqual(parseEntry('₹45.50 auto'), { amountPaise: 4550, note: 'auto' });
  assert.deepEqual(parseEntry('₹ 45.5 auto'), { amountPaise: 4550, note: 'auto' });
  assert.deepEqual(parseEntry('Rs 60 lunch'), { amountPaise: 6000, note: 'lunch' });
  assert.deepEqual(parseEntry('rs.60 lunch'), { amountPaise: 6000, note: 'lunch' });
  assert.deepEqual(parseEntry('RS99.99 book'), { amountPaise: 9999, note: 'book' });
  assert.deepEqual(parseEntry('0.05 toffee'), { amountPaise: 5, note: 'toffee' });
});

test('converts to paise without floating-point drift', () => {
  // 0.29 * 100 is 28.999999999999996 in floating point.
  assert.deepEqual(parseEntry('0.29 x'), { amountPaise: 29, note: 'x' });
  assert.deepEqual(parseEntry('1.10 x'), { amountPaise: 110, note: 'x' });
  assert.deepEqual(parseEntry('1.1 x'), { amountPaise: 110, note: 'x' });
});

test('trims and collapses whitespace in the note', () => {
  assert.deepEqual(parseEntry('   120    masala   chai  '), { amountPaise: 12000, note: 'masala chai' });
  assert.deepEqual(parseEntry('120\tmasala\n chai'), { amountPaise: 12000, note: 'masala chai' });
});

test('a missing note yields an empty string', () => {
  assert.deepEqual(parseEntry('120'), { amountPaise: 12000, note: '' });
  assert.deepEqual(parseEntry('₹45.50   '), { amountPaise: 4550, note: '' });
});

test('returns null when there is no leading amount', () => {
  assert.equal(parseEntry('chai'), null);
  assert.equal(parseEntry('chai 120'), null);
  assert.equal(parseEntry('₹ chai'), null);
  assert.equal(parseEntry('Rs'), null);
  assert.equal(parseEntry('.50 chai'), null);
});

test('returns null for a zero or negative amount', () => {
  assert.equal(parseEntry('0 chai'), null);
  assert.equal(parseEntry('0.00 chai'), null);
  assert.equal(parseEntry('-120 chai'), null);
  assert.equal(parseEntry('₹-5 chai'), null);
});

test('returns null for more than two decimal places', () => {
  assert.equal(parseEntry('45.505 auto'), null);
  assert.equal(parseEntry('₹1.234'), null);
  assert.equal(parseEntry('12.5.3 auto'), null);
});

test('returns null for empty, whitespace-only or non-string input without throwing', () => {
  assert.equal(parseEntry(''), null);
  assert.equal(parseEntry('   \t  '), null);
  assert.equal(parseEntry(undefined), null);
  assert.equal(parseEntry(null), null);
  assert.equal(parseEntry(120), null);
});

test('returns null for an amount too large to hold exactly in paise', () => {
  assert.equal(parseEntry('99999999999999999999 yacht'), null);
});

test('the module is dependency-free and makes no network calls', async () => {
  const source = await readFile(new URL('./parse-entry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

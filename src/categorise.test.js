import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CATEGORIES, categorise } from './categorise.js';
import { parseEntry } from './parse-entry.js';

test('exports the fixed, ordered category list', () => {
  assert.deepEqual(
    [...CATEGORIES],
    ['Food', 'Transport', 'Shopping', 'Bills', 'Health', 'Entertainment', 'Other'],
  );
  assert.ok(Object.isFrozen(CATEGORIES));
});

test('maps keywords to their category', () => {
  assert.equal(categorise('chai'), 'Food');
  assert.equal(categorise('auto'), 'Transport');
  assert.equal(categorise('amazon order'), 'Shopping');
  assert.equal(categorise('electricity bill'), 'Bills');
  assert.equal(categorise('pharmacy'), 'Health');
  assert.equal(categorise('movie tickets'), 'Entertainment');
});

test('ignores case', () => {
  assert.equal(categorise('Masala Chai'), 'Food');
  assert.equal(categorise('CHAI'), 'Food');
  assert.equal(categorise('Uber to office'), 'Transport');
});

test('matches whole words only', () => {
  assert.notEqual(categorise('automobile insurance'), 'Transport');
  assert.equal(categorise('automobile'), 'Other');
  assert.equal(categorise('teapot'), 'Other');
  assert.equal(categorise('chai-samosa'), 'Food');
  assert.equal(categorise('auto/rickshaw'), 'Transport');
});

test('returns Other for an empty note or no matching keyword', () => {
  assert.equal(categorise(''), 'Other');
  assert.equal(categorise('   '), 'Other');
  assert.equal(categorise('xyzzy'), 'Other');
  assert.equal(categorise('gift for amma'), 'Other');
  assert.equal(categorise(undefined), 'Other');
  assert.equal(categorise(null), 'Other');
});

test('the first category in list order wins when several match', () => {
  assert.equal(categorise('chai at metro station'), 'Food');
});

test('always returns one of the exported categories', () => {
  for (const note of ['chai', 'auto', '', 'automobile insurance', 'random words', '₹ 12']) {
    assert.ok(CATEGORIES.includes(categorise(note)), note);
  }
});

test('categorises the note part of the parser output', () => {
  assert.equal(categorise(parseEntry('120 chai').note), 'Food');
  assert.equal(categorise(parseEntry('50 auto').note), 'Transport');
});

test('the module is dependency-free and touches no network, storage or DOM', async () => {
  const source = await readFile(new URL('./categorise.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(
    source,
    /\b(?:localStorage|sessionStorage|indexedDB|caches|document|window|navigator)\b/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatPaise } from './format-amount.js';

test('whole rupees show no paise', () => {
  assert.equal(formatPaise(12000), '₹120');
});

test('paise show with trailing zeros dropped', () => {
  assert.equal(formatPaise(4550), '₹45.5');
});

test('large amounts use Indian digit grouping', () => {
  assert.equal(formatPaise(12345000), '₹1,23,450');
});

/* The Compare screen shows a difference as '+' or '−' put before the
   formatted size of it, and no change as formatPaise(0). */
test('zero is ₹0 and every non-negative amount starts with ₹, ready for a sign', () => {
  assert.equal(formatPaise(0), '₹0');
  for (const paise of [1, 50, 100, 4550, 12000, 99900, 12345000]) {
    assert.match(formatPaise(paise), /^₹[\d,]+(\.\d{1,2})?$/, String(paise));
  }
  assert.equal('+' + formatPaise(8000), '+₹80');
  assert.equal('−' + formatPaise(35500), '−₹355');
});

test('the same input always gives the same output', () => {
  assert.equal(formatPaise(4550), formatPaise(4550));
});

test('the module is dependency-free and does no I/O', async () => {
  const source = await readFile(new URL('./format-amount.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);
});

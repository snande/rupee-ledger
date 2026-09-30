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

test('the same input always gives the same output', () => {
  assert.equal(formatPaise(4550), formatPaise(4550));
});

test('the module is dependency-free and does no I/O', async () => {
  const source = await readFile(new URL('./format-amount.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);
});

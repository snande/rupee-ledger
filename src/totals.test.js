import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatRupees, toPaise, totals } from './totals.js';

// Built with the local-time Date constructor, so every fixture means the
// same wall-clock moment whatever time zone the tests run in.
const at = (year, month, day, hours = 12, minutes = 0) =>
  new Date(year, month - 1, day, hours, minutes);

const NOW = at(2026, 9, 30, 18, 0);

test('₹120 and ₹80 on the reference day total 20000 paise today and this month', () => {
  const now = NOW;
  assert.deepEqual(
    totals([{ amount: 120, ts: at(2026, 9, 30, 9) }, { amount: 80, ts: at(2026, 9, 30, 13) }], now),
    { today: 20000, month: 20000 },
  );
  assert.deepEqual(
    totals([
      { amount: 120, note: 'chai', timestamp: at(2026, 9, 30, 9).getTime() },
      { amount: 80, note: 'auto', timestamp: at(2026, 9, 30, 13).toISOString() },
    ], now),
    { today: 20000, month: 20000 },
  );
});

test('an entry already in paise counts as it is', () => {
  assert.deepEqual(
    totals([{ amountPaise: 4550, timestamp: at(2026, 9, 30, 8) }], NOW),
    { today: 4550, month: 4550 },
  );
});

test('an entry from the previous month counts in neither total', () => {
  const entries = [
    { amount: 120, timestamp: at(2026, 9, 30, 9) },
    { amount: 500, timestamp: at(2026, 8, 31, 12) },
    { amount: 700, timestamp: at(2026, 8, 30, 18) },
  ];
  assert.deepEqual(totals(entries, NOW), { today: 12000, month: 12000 });
});

test('an earlier day of the same month counts in month but not today', () => {
  const entries = [
    { amount: 120, timestamp: at(2026, 9, 30, 9) },
    { amount: 45.5, timestamp: at(2026, 9, 1, 7) },
    { amount: 300, timestamp: at(2026, 9, 29, 23, 59) },
  ];
  assert.deepEqual(totals(entries, NOW), { today: 12000, month: 12000 + 4550 + 30000 });
});

test('month is the sum of every entry in the same local calendar year and month', () => {
  const entries = [
    { amount: 10, timestamp: at(2026, 9, 2) },
    { amount: 20, timestamp: at(2026, 9, 15) },
    { amount: 30, timestamp: at(2026, 9, 30, 0, 0) },
    { amount: 40, timestamp: at(2025, 9, 15) },
    { amount: 50, timestamp: at(2026, 10, 1, 0, 0) },
  ];
  assert.deepEqual(totals(entries, NOW), { today: 3000, month: 6000 });
});

test('23:59 on the last day of a month counts in that month, not the next', () => {
  const entry = { amount: 99, timestamp: at(2026, 1, 31, 23, 59) };
  assert.deepEqual(totals([entry], at(2026, 1, 31, 23, 59)), { today: 9900, month: 9900 });
  assert.deepEqual(totals([entry], at(2026, 1, 15)), { today: 0, month: 9900 });
  assert.deepEqual(totals([entry], at(2026, 2, 1, 0, 1)), { today: 0, month: 0 });
});

test('day and month come from the device time zone, not UTC', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';
    // 20:00 UTC on 31 January is 01:30 on 1 February in India.
    const entry = { amount: 150, timestamp: '2026-01-31T20:00:00Z' };
    assert.deepEqual(totals([entry], new Date(2026, 1, 1, 9)), { today: 15000, month: 15000 });
    assert.deepEqual(totals([entry], new Date(2026, 0, 31, 9)), { today: 0, month: 0 });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('totals are integer paise with no floating-point drift', () => {
  const entries = [0.1, 0.2, 0.7, 19.99, 45.5].map((amount) => ({ amount, timestamp: at(2026, 9, 30) }));
  const result = totals(entries, NOW);
  assert.deepEqual(result, { today: 10 + 20 + 70 + 1999 + 4550, month: 6649 });
  assert.ok(Number.isInteger(result.today) && Number.isInteger(result.month));
  assert.equal(toPaise({ amount: 0.29 }), 29);
});

test('entries without a usable amount or timestamp are skipped', () => {
  const day = at(2026, 9, 30);
  const entries = [
    { amount: 120, timestamp: day },
    { amount: Number.NaN, timestamp: day },
    { amount: '80', timestamp: day },
    { timestamp: day },
    { amount: 50 },
    { amount: 50, timestamp: 'not a date' },
    null,
  ];
  assert.deepEqual(totals(entries, NOW), { today: 12000, month: 12000 });
  assert.deepEqual(totals([], NOW), { today: 0, month: 0 });
  assert.deepEqual(totals(undefined, NOW), { today: 0, month: 0 });
});

test('now defaults to the current moment', () => {
  assert.deepEqual(totals([{ amount: 12, timestamp: Date.now() }]), { today: 1200, month: 1200 });
});

test('formatRupees uses ₹ with Indian grouping and paise only when present', () => {
  assert.equal(formatRupees(20000), '₹200');
  assert.equal(formatRupees(12345600), '₹1,23,456');
  assert.equal(formatRupees(4550), '₹45.50');
  assert.equal(formatRupees(5), '₹0.05');
  assert.equal(formatRupees(0), '₹0');
  assert.equal(formatRupees(100000 * 100), '₹1,00,000');
  assert.equal(formatRupees(123456789 * 100), '₹12,34,56,789');
});

test('the module is offline, dependency-free and shows no currency but ₹', async () => {
  const source = await readFile(new URL('./totals.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(source, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
  for (const paise of [0, 5, 4550, 20000, 12345600]) {
    assert.match(formatRupees(paise), /^₹[\d,]+(?:\.\d\d)?$/);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { fromRecord, isDemo, loadEntries, saveEntry } from './ledger.js';
import { totals } from '../../src/totals.js';

const query = (text) => new URLSearchParams(text);

test('a stored record reads as paise and a timestamp the totals understand', () => {
  const at = new Date(2026, 8, 30, 9, 0).getTime();
  const entry = fromRecord({ id: 7, amount: 12000, note: 'chai', category: '', createdAt: at });
  assert.deepEqual(entry, { id: 7, amountPaise: 12000, note: 'chai', timestamp: at });
  assert.deepEqual(totals([entry], new Date(at)), { today: 12000, month: 12000 });
});

test('loadEntries lists the ledger newest first', async () => {
  const list = async () => [
    { id: 1, amount: 12000, note: 'chai', createdAt: 1 },
    { id: 2, amount: 8000, note: 'auto', createdAt: 2 },
  ];
  const entries = await loadEntries(query(''), { list });
  assert.deepEqual(entries.map((entry) => entry.id), [2, 1]);
  assert.equal(entries[0].amountPaise, 8000);
});

test('saveEntry writes rupees and the entry time, and resolves the stored entry', async () => {
  const calls = [];
  const add = async (input) => {
    calls.push(input);
    return { id: 3, amount: Math.round(input.amount * 100), note: input.note, category: '', createdAt: input.createdAt };
  };
  const stored = await saveEntry({ amountPaise: 4550, note: 'auto', timestamp: 1000 }, query(''), { add });
  assert.deepEqual(calls, [{ amount: 45.5, note: 'auto', createdAt: 1000 }]);
  assert.deepEqual(stored, { id: 3, amountPaise: 4550, note: 'auto', timestamp: 1000 });
});

test('a state query goes to the stub and stores nothing', async () => {
  assert.equal(isDemo(query('state=filled')), true);
  assert.equal(isDemo(query('state=nope')), false);
  assert.equal(isDemo(query('')), false);
  const fail = async () => { throw new Error('the ledger should not be touched'); };
  assert.deepEqual(await loadEntries(query('state=empty'), { list: fail }), []);
  assert.equal((await loadEntries(query('state=filled'), { list: fail })).length, 4);
  assert.equal(await saveEntry({ amountPaise: 100, note: '', timestamp: 1 }, query('state=filled'), { add: fail }), null);
});

test('without IndexedDB the load and the save reject, so the screen can say so', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  await assert.rejects(loadEntries(query('')));
  await assert.rejects(saveEntry({ amountPaise: 100, note: '', timestamp: 1 }, query('')));
});

test('the module is offline and shows no currency but ₹', async () => {
  const source = await readFile(new URL('./ledger.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(source, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
});

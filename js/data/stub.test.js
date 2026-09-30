import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_STUB_STATE, loadEntries, stubState } from './stub.js';

const query = (text) => new URLSearchParams(text);
const settled = (promise) => Promise.race([
  promise.then(() => 'resolved', () => 'rejected'),
  new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
]);

test('filled resolves sample entries in integer paise with a note', async () => {
  const entries = await loadEntries(query('state=filled'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(Number.isSafeInteger(entry.amountPaise) && entry.amountPaise > 0);
    assert.equal(typeof entry.note, 'string');
    assert.equal(typeof entry.id, 'string');
  }
});

test('filled hands out fresh copies, so a caller cannot change the samples', async () => {
  const first = await loadEntries(query('state=filled'));
  first[0].note = 'changed';
  const second = await loadEntries(query('state=filled'));
  assert.notEqual(second[0].note, 'changed');
});

test('empty resolves no entries', async () => {
  assert.deepEqual(await loadEntries(query('state=empty')), []);
});

test('loading never settles and error rejects', async () => {
  assert.equal(await settled(loadEntries(query('state=loading'))), 'pending');
  assert.equal(await settled(loadEntries(query('state=error'))), 'rejected');
});

test('a missing or unknown state behaves like a new phone', async () => {
  assert.equal(DEFAULT_STUB_STATE, 'empty');
  assert.equal(stubState(query('')), 'empty');
  assert.equal(stubState(query('state=nope')), 'empty');
  assert.equal(stubState(undefined), 'empty');
  assert.deepEqual(await loadEntries(query('state=nope')), []);
});

test('without an argument it reads the state from the page hash', async () => {
  const before = globalThis.location;
  globalThis.location = { hash: '#/today?state=filled' };
  try {
    assert.equal(stubState(), 'filled');
    assert.ok((await loadEntries()).length > 0);
  } finally {
    if (before === undefined) delete globalThis.location;
    else globalThis.location = before;
  }
});

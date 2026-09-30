import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as ledger from './ledger.js';
import { add, listByDay, listByMonth, closeLedger, SCHEMA_VERSION, UnknownSchemaVersionError } from './ledger.js';
import { openLedger, addEntry } from './ledger/store.js';

import { createFakeIndexedDB, FakeIDBKeyRange } from './ledger/fake-indexeddb.js';

let fake;

const storedRecords = () => [...fake.databases.get('rupee-ledger').stores.get('entries').records.values()];
const writes = () => fake.transactions.filter((tx) => tx.mode === 'readwrite');

// Writes a record exactly as given, bypassing `add`, the way an older or
// newer build of the app might have left it on the device.
async function putRaw(record) {
  const db = await openLedger();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').add(record);
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

test('add then listByDay round-trips the entry', async () => {
  const createdAt = new Date(2026, 8, 30, 9, 15).getTime();
  const saved = await add({ amountPaise: 12000, note: 'chai', createdAt });

  assert.deepEqual(saved, { id: 1, schemaVersion: 1, amountPaise: 12000, note: 'chai', createdAt });
  assert.deepEqual(await listByDay(new Date(2026, 8, 30)), [saved]);
});

test('every record add writes carries schemaVersion 1 with amountPaise, note and createdAt', async () => {
  assert.equal(SCHEMA_VERSION, 1);
  await add({ amountPaise: 12000, note: 'chai', createdAt: 1700000000000 });
  await add({ amountPaise: 4550, createdAt: new Date(1700000000001) });

  assert.deepEqual(storedRecords(), [
    { id: 1, schemaVersion: 1, amountPaise: 12000, note: 'chai', createdAt: 1700000000000 },
    { id: 2, schemaVersion: 1, amountPaise: 4550, note: '', createdAt: 1700000000001 },
  ]);
});

test('add defaults createdAt to now', async () => {
  const before = Date.now();
  const saved = await add({ amountPaise: 1000, note: 'auto' });
  assert.ok(saved.createdAt >= before && saved.createdAt <= Date.now());
  assert.deepEqual(await listByDay(saved.createdAt), [saved]);
});

test('add resolves only once the write transaction completes, in strict durability', async () => {
  let release;
  fake.commitGate = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const pending = add({ amountPaise: 12000, note: 'chai', createdAt: 1 }).finally(() => {
    settled = true;
  });

  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const [tx] = writes();
  assert.equal(tx.requests[0].result, 1, 'the add request has already succeeded');
  assert.deepEqual(tx.options, { durability: 'strict' });
  assert.equal(settled, false, 'add must not resolve before the transaction commits');
  assert.deepEqual(storedRecords(), []);

  release();
  assert.equal((await pending).id, 1);
  assert.equal(storedRecords().length, 1);
});

test('add rejects when the write transaction aborts', async () => {
  fake.failNext = 'abort';
  await assert.rejects(add({ amountPaise: 12000, note: 'chai', createdAt: 1 }), { name: 'QuotaExceededError' });
  assert.deepEqual(storedRecords(), []);
});

test('an added entry is still listed on a fresh connection', async () => {
  const createdAt = new Date(2026, 8, 30, 20).getTime();
  const saved = await add({ amountPaise: 3500, note: 'bus', createdAt });
  await closeLedger();
  assert.deepEqual(await listByDay(createdAt), [saved]);
});

test('listByDay returns only entries on that local calendar day, oldest first', async () => {
  const at = (day, hours, minutes = 0, seconds = 0, ms = 0) =>
    new Date(2026, 8, day, hours, minutes, seconds, ms).getTime();
  await add({ amountPaise: 100, note: 'last of yesterday', createdAt: at(29, 23, 59, 59, 999) });
  await add({ amountPaise: 200, note: 'late', createdAt: at(30, 23, 59, 59, 999) });
  await add({ amountPaise: 300, note: 'midnight', createdAt: at(30, 0) });
  await add({ amountPaise: 400, note: 'lunch', createdAt: at(30, 13, 30) });
  await add({ amountPaise: 500, note: 'first of tomorrow', createdAt: at(31, 0) });

  const today = await listByDay(new Date(2026, 8, 30, 18, 45));
  assert.deepEqual(
    today.map((entry) => entry.note),
    ['midnight', 'lunch', 'late'],
  );
  assert.deepEqual(
    (await listByDay(at(29, 12))).map((entry) => entry.note),
    ['last of yesterday'],
  );
  assert.deepEqual(await listByDay(new Date(2026, 9, 5)), []);
  assert.equal(fake.transactions.at(-1).mode, 'readonly');
});

test('listByDay rejects a record with an unknown schema version instead of returning it', async () => {
  const createdAt = new Date(2026, 8, 30, 10).getTime();
  await add({ amountPaise: 12000, note: 'chai', createdAt });
  await putRaw({ schemaVersion: 2, amountRupees: 45, memo: 'from the future', createdAt: createdAt + 1 });

  await assert.rejects(listByDay(createdAt), (error) => {
    assert.ok(error instanceof UnknownSchemaVersionError);
    assert.equal(error.name, 'UnknownSchemaVersionError');
    assert.deepEqual(error.records, [{ id: 2, schemaVersion: 2 }]);
    assert.match(error.message, /id 2 \(schemaVersion 2\)/);
    return true;
  });
});

test('listByDay reports an unversioned record, such as one from addEntry, as unknown', async () => {
  const createdAt = new Date(2026, 8, 30, 11).getTime();
  await addEntry({ amount: 120, note: 'chai', createdAt });

  await assert.rejects(listByDay(createdAt), (error) => {
    assert.ok(error instanceof UnknownSchemaVersionError);
    assert.deepEqual(error.records, [{ id: 1, schemaVersion: undefined }]);
    return true;
  });
  // A day without the stray record still loads normally.
  assert.deepEqual(await listByDay(createdAt + 24 * 60 * 60 * 1000), []);
});

test('listByMonth returns only entries in that local calendar month, oldest first', async () => {
  const at = (month, day, hours, minutes = 0, seconds = 0, ms = 0) =>
    new Date(2026, month, day, hours, minutes, seconds, ms).getTime();
  await add({ amountPaise: 100, note: 'last of August', createdAt: at(7, 31, 23, 59, 59, 999) });
  await add({ amountPaise: 200, note: 'today', createdAt: at(8, 30, 9) });
  await add({ amountPaise: 300, note: 'first of September', createdAt: at(8, 1, 0) });
  await add({ amountPaise: 400, note: 'first of October', createdAt: at(9, 1, 0) });

  assert.deepEqual(
    (await listByMonth(new Date(2026, 8, 30, 18))).map((entry) => entry.note),
    ['first of September', 'today'],
  );
  assert.deepEqual((await listByMonth(at(7, 2, 12))).map((entry) => entry.note), ['last of August']);
  assert.deepEqual(await listByMonth(new Date(2026, 11, 5)), []);
  assert.equal(fake.transactions.at(-1).mode, 'readonly');
});

test('listByMonth rejects an unknown or missing schema version instead of misreading it', async () => {
  const createdAt = new Date(2026, 8, 3, 10).getTime();
  await add({ amountPaise: 12000, note: 'chai', createdAt });
  await putRaw({ schemaVersion: 2, amountRupees: 45, memo: 'from the future', createdAt: createdAt + 1 });
  await addEntry({ amount: 80, note: 'auto', createdAt: createdAt + 2 });

  await assert.rejects(listByMonth(new Date(2026, 8, 30)), (error) => {
    assert.ok(error instanceof UnknownSchemaVersionError);
    assert.deepEqual(error.records, [{ id: 2, schemaVersion: 2 }, { id: 3, schemaVersion: undefined }]);
    return true;
  });
  for (const date of [undefined, 'this month', new Date('nope')]) {
    await assert.rejects(listByMonth(date), Error);
  }
});

test('add refuses amounts that are not a positive whole number of paise, without writing', async () => {
  for (const amountPaise of [0, -100, 12.5, Number.NaN, Infinity, '12000', null, undefined, 12000n, 2 ** 53]) {
    await assert.rejects(add({ amountPaise, note: 'bad' }), Error, `amountPaise ${String(amountPaise)}`);
  }
  await assert.rejects(add(), Error);
  assert.equal(writes().length, 0);
});

test('add refuses a createdAt that could not be indexed, and listByDay a bad date', async () => {
  for (const createdAt of ['2026-09-30', Number.NaN, new Date('nope'), {}]) {
    await assert.rejects(add({ amountPaise: 100, createdAt }), Error);
  }
  assert.equal(writes().length, 0);
  for (const date of [undefined, 'today', new Date('nope')]) {
    await assert.rejects(listByDay(date), Error);
  }
});

test('the module offers no delete, overwrite or merge operation', () => {
  assert.deepEqual(Object.keys(ledger).sort(), [
    'SCHEMA_VERSION',
    'UnknownSchemaVersionError',
    'add',
    'closeLedger',
    'listByDay',
    'listByMonth',
  ]);
});

test('the module uses only IndexedDB, with no third-party import and no network call', async () => {
  const source = await readFile(new URL('./ledger.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import\b.*?from\s*'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./ledger/store.js']);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/);
  assert.doesNotMatch(source, /\bhttps?:\/\//);
});

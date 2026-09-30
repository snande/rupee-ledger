import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as ledger from './ledger.js';
import { add, listByDay, closeLedger, SCHEMA_VERSION, UnknownSchemaVersionError } from './ledger.js';
import { openLedger, addEntry } from './ledger/store.js';

// Node has no IndexedDB, so the tests drive the ledger through a small
// in-memory stand-in covering the parts of IndexedDB's contract the module
// relies on: databases outlive connections, requests and transaction events
// fire asynchronously, writes land only when the transaction commits and
// `oncomplete` fires after that, and an index `getAll` honours an
// `IDBKeyRange` and skips records whose key is not a valid number.
function createFakeIndexedDB() {
  const databases = new Map();
  const fake = { databases, transactions: [], commitGate: null, failNext: null, open };
  const later = (fn) => setTimeout(fn, 0);

  function open(name, version) {
    const request = { result: undefined, error: null };
    later(() => {
      let database = databases.get(name);
      if (!database) {
        database = { name, version: 0, stores: new Map() };
        databases.set(name, database);
      }
      const oldVersion = database.version;
      const db = connect(database);
      request.result = db;
      if (version > oldVersion) {
        database.version = version;
        db.upgrading = true;
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
        db.upgrading = false;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  function connect(database) {
    const db = {
      name: database.name,
      closed: false,
      upgrading: false,
      onversionchange: null,
      close() {
        db.closed = true;
      },
      createObjectStore(storeName, { keyPath = null, autoIncrement = false } = {}) {
        if (!db.upgrading) throw new Error('InvalidStateError: not in a versionchange transaction');
        const store = { keyPath, autoIncrement, nextKey: 1, records: new Map(), indexes: new Map() };
        database.stores.set(storeName, store);
        return {
          createIndex(indexName, indexKeyPath) {
            store.indexes.set(indexName, indexKeyPath);
          },
        };
      },
      transaction(storeName, mode = 'readonly', options = {}) {
        if (db.closed) throw new Error('InvalidStateError: the connection is closed');
        const store = database.stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: no object store ${storeName}`);
        return transaction(store, mode, options);
      },
    };
    return db;
  }

  function transaction(store, mode, options) {
    const tx = {
      mode,
      options,
      requests: [],
      staged: [],
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => objectStore(tx, store),
    };
    fake.transactions.push(tx);
    later(() => run(tx));
    return tx;
  }

  function objectStore(tx, store) {
    return {
      add(value) {
        if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        return queue(tx, 'add', () => {
          const key = store.nextKey++;
          const stored = structuredClone({ ...value, [store.keyPath]: key });
          tx.staged.push(() => store.records.set(key, stored));
          return key;
        });
      },
      index(indexName) {
        const keyPath = store.indexes.get(indexName);
        if (keyPath === undefined) throw new Error(`NotFoundError: no index ${indexName}`);
        return {
          getAll(range) {
            return queue(tx, 'getAll', () =>
              [...store.records.entries()]
                .filter(([, record]) => typeof record[keyPath] === 'number')
                .filter(([, record]) => range === undefined || range.includes(record[keyPath]))
                .sort(([keyA, a], [keyB, b]) => a[keyPath] - b[keyPath] || keyA - keyB)
                .map(([, record]) => structuredClone(record)),
            );
          },
        };
      },
    };
  }

  function queue(tx, kind, perform) {
    const request = { kind, result: undefined, error: null, onsuccess: null, onerror: null, perform };
    tx.requests.push(request);
    return request;
  }

  async function run(tx) {
    for (const request of tx.requests) {
      if (tx.mode === 'readwrite' && fake.failNext === 'abort') {
        fake.failNext = null;
        tx.error = Object.assign(new Error('Quota exceeded.'), { name: 'QuotaExceededError' });
        tx.onabort?.({ target: tx });
        return;
      }
      request.result = request.perform();
      request.onsuccess?.({ target: request });
      await new Promise(later);
    }
    if (fake.commitGate) await fake.commitGate;
    for (const write of tx.staged) write();
    later(() => tx.oncomplete?.({ target: tx }));
  }

  return fake;
}

const FakeIDBKeyRange = {
  bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return {
      lower,
      upper,
      lowerOpen,
      upperOpen,
      includes(key) {
        return (lowerOpen ? key > lower : key >= lower) && (upperOpen ? key < upper : key <= upper);
      },
    };
  },
};

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

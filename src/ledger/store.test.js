import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { openLedger, closeLedger, addEntry, listEntries } from './store.js';

// Node has no IndexedDB, and the project takes no dependencies, so the tests
// drive the store through a small in-memory stand-in. It keeps the parts of
// IndexedDB's contract the store relies on: databases outlive connections,
// requests and transaction events fire asynchronously, `oncomplete` fires
// only after every request in the transaction has succeeded, and an aborted
// transaction leaves nothing behind. It also records what the store asked
// for, so tests can check the schema, transaction mode and durability.
function createFakeIndexedDB() {
  const databases = new Map();
  const fake = {
    databases,
    connections: [],
    transactions: [],
    succeededRequests: 0,
    // Set to a promise to hold every commit until it settles.
    commitGate: null,
    // 'error' fails the next write request; 'abort' aborts the next write
    // transaction at commit with `abortError` (null, like tx.abort()).
    failNext: null,
    abortError: null,
    open,
  };
  const later = (fn) => setTimeout(fn, 0);

  function open(name, version) {
    const request = { result: undefined, error: null };
    later(() => {
      let database = databases.get(name);
      const oldVersion = database ? database.version : 0;
      if (!database) {
        database = { name, version: 0, stores: new Map() };
        databases.set(name, database);
      }
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
      get version() {
        return database.version;
      },
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
      transaction(storeNames, mode = 'readonly', options = {}) {
        if (db.closed) throw new Error('InvalidStateError: the connection is closed');
        return transaction(database, storeNames, mode, options);
      },
    };
    fake.connections.push(db);
    return db;
  }

  function transaction(database, storeNames, mode, options) {
    const tx = {
      mode,
      options,
      storeNames,
      requests: [],
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(storeName) {
        const store = database.stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: no object store ${storeName}`);
        return objectStore(tx, store);
      },
    };
    fake.transactions.push(tx);
    later(() => run(tx));
    return tx;
  }

  function objectStore(tx, store) {
    return {
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
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
          getAll() {
            return queue(tx, 'getAll', () =>
              [...store.records.entries()]
                .filter(([, record]) => typeof record[keyPath] === 'number')
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
    tx.staged = [];
    for (const request of tx.requests) {
      if (tx.mode === 'readwrite' && fake.failNext === 'error') {
        fake.failNext = null;
        request.error = Object.assign(new Error('Key already exists in the object store.'), {
          name: 'ConstraintError',
        });
        request.onerror?.({ target: request });
        tx.error = request.error;
        tx.onerror?.({ target: request });
        tx.onabort?.({ target: tx });
        return;
      }
      request.result = request.perform();
      fake.succeededRequests += 1;
      request.onsuccess?.({ target: request });
      await new Promise(later);
    }

    if (fake.commitGate) await fake.commitGate;

    if (tx.mode === 'readwrite' && fake.failNext === 'abort') {
      fake.failNext = null;
      tx.error = fake.abortError;
      tx.onabort?.({ target: tx });
      return;
    }
    for (const write of tx.staged) write();
    later(() => tx.oncomplete?.({ target: tx }));
  }

  return fake;
}

// Lets queued timers run until `condition` holds.
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(condition(), 'condition never became true');
}

const writes = (fake) => fake.transactions.filter((tx) => tx.mode === 'readwrite');

let fake;

beforeEach(async () => {
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
});

test('openLedger creates rupee-ledger v1 with an auto-keyed entries store indexed on createdAt', async () => {
  const db = await openLedger();
  assert.equal(db.name, 'rupee-ledger');
  assert.equal(db.version, 1);

  const database = fake.databases.get('rupee-ledger');
  assert.deepEqual([...database.stores.keys()], ['entries']);
  const entries = database.stores.get('entries');
  assert.equal(entries.keyPath, 'id');
  assert.equal(entries.autoIncrement, true);
  assert.deepEqual([...entries.indexes], [['createdAt', 'createdAt']]);
});

test('openLedger reuses one connection until closeLedger', async () => {
  const first = await openLedger();
  assert.equal(await openLedger(), first);

  await closeLedger();
  assert.equal(first.closed, true);
  const second = await openLedger();
  assert.notEqual(second, first);
  assert.equal(fake.connections.length, 2);
});

test('addEntry stores the amount as integer paise', async () => {
  const chai = await addEntry({ amount: 120, note: 'chai', category: 'food', createdAt: 1 });
  const auto = await addEntry({ amount: 45.5, note: 'auto', createdAt: 2 });
  const toffee = await addEntry({ amount: 0.29, note: 'toffee', createdAt: 3 });

  assert.equal(chai.amount, 12000);
  assert.equal(auto.amount, 4550);
  // 0.29 * 100 is 28.999999999999996 in floating point.
  assert.equal(toffee.amount, 29);

  const stored = [...fake.databases.get('rupee-ledger').stores.get('entries').records.values()];
  assert.deepEqual(
    stored.map((record) => record.amount),
    [12000, 4550, 29],
  );
  assert.ok(stored.every((record) => Number.isInteger(record.amount)));
});

test('addEntry resolves with the saved record including its id', async () => {
  const saved = await addEntry({ amount: 120, note: 'chai', category: 'food', createdAt: 1700000000000 });
  assert.deepEqual(saved, {
    id: 1,
    amount: 12000,
    note: 'chai',
    category: 'food',
    createdAt: 1700000000000,
  });

  const next = await addEntry({ amount: 35, note: 'bus ticket', createdAt: 1700000000001 });
  assert.equal(next.id, 2);
  assert.equal(next.category, '');
});

test('addEntry defaults createdAt to now and accepts a Date', async () => {
  const before = Date.now();
  const now = await addEntry({ amount: 10 });
  assert.ok(now.createdAt >= before && now.createdAt <= Date.now());
  assert.equal(now.note, '');

  const dated = await addEntry({ amount: 10, createdAt: new Date(1700000000000) });
  assert.equal(dated.createdAt, 1700000000000);
});

test('addEntry rejects an amount that is not a positive finite number of rupees', async () => {
  for (const amount of [0, -0, -120, Number.NaN, Infinity, -Infinity, 0.001, '120', null, undefined, 120n]) {
    await assert.rejects(addEntry({ amount, note: 'bad' }), Error, `amount ${String(amount)}`);
  }
  await assert.rejects(addEntry(), Error);
  assert.equal(writes(fake).length, 0, 'no write was attempted for a rejected amount');
});

test('addEntry rejects a createdAt that could not be indexed', async () => {
  for (const createdAt of ['2024-01-01', Number.NaN, new Date('nope'), {}]) {
    await assert.rejects(addEntry({ amount: 10, createdAt }), Error);
  }
  assert.equal(writes(fake).length, 0);
});

test('addEntry writes in a readwrite transaction with strict durability, one per entry', async () => {
  await addEntry({ amount: 120, note: 'chai', createdAt: 1 });
  await addEntry({ amount: 35, note: 'bus', createdAt: 2 });

  const txs = writes(fake);
  assert.equal(txs.length, 2, 'each entry gets its own transaction; nothing is batched');
  for (const tx of txs) {
    assert.equal(tx.storeNames, 'entries');
    assert.deepEqual(tx.options, { durability: 'strict' });
    assert.deepEqual(
      tx.requests.map((request) => request.kind),
      ['add'],
    );
  }
});

test('addEntry starts its write immediately, without buffering or debouncing', async () => {
  await openLedger();
  const pending = addEntry({ amount: 120, note: 'chai', createdAt: 1 });
  await until(() => fake.succeededRequests === 1);
  assert.equal(writes(fake).length, 1);
  await pending;
});

test('addEntry resolves only from oncomplete, not when the add request succeeds', async () => {
  let release;
  fake.commitGate = new Promise((resolve) => {
    release = resolve;
  });

  let settled = false;
  const pending = addEntry({ amount: 120, note: 'chai', createdAt: 1 }).finally(() => {
    settled = true;
  });

  await until(() => fake.succeededRequests === 1);
  const [tx] = writes(fake);
  assert.equal(tx.requests[0].result, 1, 'the add request has already succeeded');
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, 'addEntry must not resolve before the transaction commits');

  release();
  const saved = await pending;
  assert.equal(saved.id, 1);
});

test('addEntry rejects when the write request fails and the transaction errors', async () => {
  fake.failNext = 'error';
  await assert.rejects(addEntry({ amount: 120, note: 'chai', createdAt: 1 }), {
    name: 'ConstraintError',
  });
  assert.deepEqual(await listEntries(), []);
});

test('addEntry rejects when the transaction aborts at commit, even after the request succeeded', async () => {
  fake.failNext = 'abort';
  fake.abortError = Object.assign(new Error('Quota exceeded.'), { name: 'QuotaExceededError' });
  await assert.rejects(addEntry({ amount: 120, note: 'chai', createdAt: 1 }), {
    name: 'QuotaExceededError',
  });
  assert.equal(fake.succeededRequests, 1);

  // An abort with no error, as after tx.abort(), still rejects with an Error.
  fake.failNext = 'abort';
  fake.abortError = null;
  await assert.rejects(addEntry({ amount: 35, note: 'bus', createdAt: 2 }), Error);

  assert.deepEqual(await listEntries(), []);
});

test('listEntries resolves with every entry sorted by createdAt ascending', async () => {
  assert.deepEqual(await listEntries(), []);

  await addEntry({ amount: 30, note: 'third', createdAt: 3000 });
  await addEntry({ amount: 10, note: 'first', createdAt: 1000 });
  await addEntry({ amount: 20, note: 'second', createdAt: 2000 });

  const entries = await listEntries();
  assert.deepEqual(
    entries.map((entry) => entry.note),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [2, 3, 1],
  );
  assert.equal(fake.transactions.at(-1).mode, 'readonly');
});

test('an entry is listed on a fresh connection once addEntry resolves', async () => {
  const first = await openLedger();
  const saved = await addEntry({ amount: 120, note: 'chai', category: 'food', createdAt: 1700000000000 });

  await closeLedger();
  const fresh = await openLedger();
  assert.notEqual(fresh, first);
  assert.equal(first.closed, true);

  assert.deepEqual(await listEntries(), [saved]);
});

test('the module is dependency-free and makes no network calls', async () => {
  const source = await readFile(new URL('./store.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/);
  assert.doesNotMatch(source, /\bhttps?:\/\//);

  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { closeLedger, addEntry } from './store.js';
import { initLedger } from './boot.js';

// Node has no IndexedDB, so the store runs against a small in-memory
// stand-in: databases outlive connections, events fire asynchronously, and
// just the calls the store makes (open with upgrade, add, getAll on an
// index) are supported.
function createFakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);

  function open(name, version) {
    const request = { result: undefined, error: null };
    later(() => {
      let database = databases.get(name);
      const oldVersion = database ? database.version : 0;
      if (!database) {
        database = { version: 0, stores: new Map() };
        databases.set(name, database);
      }
      const db = connect(database);
      request.result = db;
      if (version > oldVersion) {
        database.version = version;
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  function connect(database) {
    return {
      onversionchange: null,
      close() {},
      createObjectStore(storeName, { keyPath }) {
        const store = { keyPath, nextKey: 1, records: new Map(), indexes: new Map() };
        database.stores.set(storeName, store);
        return {
          createIndex(indexName, indexKeyPath) {
            store.indexes.set(indexName, indexKeyPath);
          },
        };
      },
      transaction(storeName) {
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
        const store = database.stores.get(storeName);
        tx.objectStore = () => ({
          add(value) {
            const request = {};
            later(() => {
              const key = store.nextKey++;
              store.records.set(key, structuredClone({ ...value, [store.keyPath]: key }));
              request.result = key;
              request.onsuccess?.({ target: request });
              later(() => tx.oncomplete?.({ target: tx }));
            });
            return request;
          },
          index(indexName) {
            const keyPath = store.indexes.get(indexName);
            return {
              getAll() {
                const request = {};
                later(() => {
                  request.result = [...store.records.values()]
                    .sort((a, b) => a[keyPath] - b[keyPath])
                    .map((record) => structuredClone(record));
                  request.onsuccess?.({ target: request });
                  later(() => tx.oncomplete?.({ target: tx }));
                });
                return request;
              },
            };
          },
        });
        return tx;
      },
    };
  }

  return { open };
}

// An IndexedDB whose open request always fails, as when storage is blocked
// or disabled (e.g. some private-browsing modes).
function createFailingIndexedDB() {
  return {
    open() {
      const request = { result: undefined, error: null };
      setTimeout(() => {
        request.error = Object.assign(new Error('The user denied permission to access the database.'), {
          name: 'UnknownError',
        });
        request.onerror?.({ target: request });
      }, 0);
      return request;
    },
  };
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

// A navigator whose `storage.persist()` runs `outcome` and counts its calls.
function navigatorWithPersist(outcome) {
  const nav = {
    persistCalls: 0,
    storage: {
      persist() {
        nav.persistCalls += 1;
        return outcome();
      },
    },
  };
  return nav;
}

let fetchCalls;

beforeEach(async () => {
  await closeLedger();
  globalThis.indexedDB = createFakeIndexedDB();
  setNavigator({});
  fetchCalls = 0;
  Object.defineProperty(globalThis, 'fetch', {
    value: () => {
      fetchCalls += 1;
      return Promise.reject(new Error('offline'));
    },
    configurable: true,
    writable: true,
  });
});

afterEach(async () => {
  await closeLedger();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else delete globalThis.fetch;
});

// Stores two entries out of order, then drops the connection so
// initLedger has to open and read them back as it would on app start.
async function seedEntries() {
  const later = await addEntry({ amount: 45.5, note: 'auto', createdAt: 1700000100000 });
  const earlier = await addEntry({ amount: 120, note: 'chai', category: 'food', createdAt: 1700000000000 });
  await closeLedger();
  return [earlier, later];
}

test('initLedger resolves with stored entries and persisted: true when persistence is granted', async () => {
  const stored = await seedEntries();
  const nav = navigatorWithPersist(() => Promise.resolve(true));
  setNavigator(nav);

  const result = await initLedger();

  assert.deepEqual(result, { entries: stored, persisted: true });
  assert.equal(nav.persistCalls, 1);
});

test('initLedger still loads entries when persist() resolves false', async () => {
  const stored = await seedEntries();
  const nav = navigatorWithPersist(() => Promise.resolve(false));
  setNavigator(nav);

  assert.deepEqual(await initLedger(), { entries: stored, persisted: false });
  assert.equal(nav.persistCalls, 1);
});

test('initLedger still loads entries when persist() rejects', async () => {
  const stored = await seedEntries();
  setNavigator(navigatorWithPersist(() => Promise.reject(new Error('NotAllowedError'))));

  assert.deepEqual(await initLedger(), { entries: stored, persisted: false });
});

test('initLedger still loads entries when persist() throws synchronously', async () => {
  const stored = await seedEntries();
  setNavigator(
    navigatorWithPersist(() => {
      throw new Error('boom');
    }),
  );

  assert.deepEqual(await initLedger(), { entries: stored, persisted: false });
});

test('initLedger still loads entries, unpersisted, when persist() never settles', async () => {
  const stored = await seedEntries();
  // Like a permission prompt the user never answers.
  const nav = navigatorWithPersist(() => new Promise(() => {}));
  setNavigator(nav);

  const started = Date.now();
  assert.deepEqual(await initLedger(), { entries: stored, persisted: false });
  const elapsed = Date.now() - started;

  assert.equal(nav.persistCalls, 1);
  // The default deadline is 1000ms; allow slack for a slow CI machine.
  assert.ok(elapsed >= 900, `resolved after ${elapsed}ms, before the persist deadline`);
  assert.ok(elapsed < 2500, `resolved after ${elapsed}ms, past the persist deadline`);
});

test('initLedger honours a shorter persistTimeoutMs when persist() never settles', async () => {
  const stored = await seedEntries();
  setNavigator(navigatorWithPersist(() => new Promise(() => {})));

  const started = Date.now();
  assert.deepEqual(await initLedger({ persistTimeoutMs: 20 }), { entries: stored, persisted: false });
  assert.ok(Date.now() - started < 500);
});

test('initLedger reports a grant that arrives before the deadline', async () => {
  const stored = await seedEntries();
  setNavigator(navigatorWithPersist(() => new Promise((resolve) => setTimeout(resolve, 30, true))));

  assert.deepEqual(await initLedger({ persistTimeoutMs: 500 }), { entries: stored, persisted: true });
});

test('initLedger resolves with persisted: false when the storage API is absent', async () => {
  const stored = await seedEntries();

  for (const nav of [undefined, {}, { storage: undefined }, { storage: {} }, { storage: { persist: true } }]) {
    await closeLedger();
    setNavigator(nav);
    assert.deepEqual(await initLedger(), { entries: stored, persisted: false });
  }
});

test('initLedger resolves with an empty ledger on first run', async () => {
  setNavigator(navigatorWithPersist(() => Promise.resolve(true)));

  assert.deepEqual(await initLedger(), { entries: [], persisted: true });
});

test('initLedger rejects with "ledger storage unavailable" when IndexedDB is missing', async () => {
  globalThis.indexedDB = undefined;
  setNavigator(navigatorWithPersist(() => Promise.resolve(true)));

  await assert.rejects(initLedger(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ledger storage unavailable/);
    return true;
  });
});

test('initLedger rejects with "ledger storage unavailable" when IndexedDB fails to open', async () => {
  globalThis.indexedDB = createFailingIndexedDB();
  setNavigator(navigatorWithPersist(() => Promise.resolve(false)));

  await assert.rejects(initLedger(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ledger storage unavailable/);
    assert.match(error.cause.message, /denied permission/);
    return true;
  });
});

test('initLedger makes no network request', async () => {
  await seedEntries();
  setNavigator(navigatorWithPersist(() => Promise.resolve(true)));

  await initLedger();
  assert.equal(fetchCalls, 0);

  const source = await readFile(new URL('./boot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:require|fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/);
  assert.doesNotMatch(source, /\bhttps?:\/\//);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  const imports = [...source.matchAll(/^\s*import\b.*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./store.js']);
});

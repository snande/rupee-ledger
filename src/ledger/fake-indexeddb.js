// Node has no IndexedDB, so tests drive the ledger through this small
// in-memory stand-in covering the parts of IndexedDB's contract the module
// relies on: databases outlive connections, requests and transaction events
// fire asynchronously, writes land only when the transaction commits and
// `oncomplete` fires after that, and an index `getAll` honours an
// `IDBKeyRange` and skips records whose key is not a valid number.
export function createFakeIndexedDB() {
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

export const FakeIDBKeyRange = {
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

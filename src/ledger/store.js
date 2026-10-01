// The on-device ledger: a small promise wrapper around raw IndexedDB with
// no library and no network, so every entry stays on the phone.
//
// Durability is the point of this module. `addEntry` resolves only from
// the write transaction's `oncomplete`, which fires once the transaction
// has committed. Resolving on the `add` request's `onsuccess` would let a
// tab kill between the request and the commit lose an entry the screen had
// already shown as saved. Each call writes straight away in its own
// transaction; nothing is buffered, debounced or batched. The one batch
// write is `addMissingEntries`, for a backup import: all of it commits in a
// single transaction or none of it does.
//
// Amounts are stored as integer paise (₹120 is 12000) so totals never
// drift the way sums of fractional rupees do.
//
// Entries saved before categories existed have no `category` field. They are
// never migrated in place: every read hands them back with
// `categorise(note)` filled in (see `withCategory`), and the stored record
// stays exactly as it was until someone picks a category for it.

import { categorise, CATEGORIES } from '../categorise.js';

const DB_NAME = 'rupee-ledger';
const DB_VERSION = 1;
const STORE = 'entries';
const CREATED_AT = 'createdAt';

/** @type {Promise<IDBDatabase> | null} */
let connection = null;

/**
 * Opens the `rupee-ledger` database, creating the `entries` store (keyed by
 * an auto-generated `id`, indexed on `createdAt`) the first time. The
 * connection is shared by `addEntry`, `listEntries` and `updateCategory`
 * until `closeLedger`.
 * @returns {Promise<IDBDatabase>}
 */
export function openLedger() {
  if (!connection) {
    const opening = openDatabase();
    connection = opening;
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
  }
  return connection;
}

/**
 * Closes the shared connection, if any, so the next `openLedger()` opens a
 * fresh one.
 * @returns {Promise<void>}
 */
export async function closeLedger() {
  const open = connection;
  connection = null;
  if (!open) return;
  try {
    (await open).close();
  } catch {
    // A connection that never opened has nothing to close.
  }
}

/**
 * Saves one entry and resolves with the stored record, including its `id`,
 * once the write has committed.
 * @param {{ amount: number, note?: string, category?: string,
 *   createdAt?: number | Date }} entry  `amount` in rupees, e.g. 45.5;
 *   `createdAt` in epoch milliseconds, defaulting to now.
 * @returns {Promise<{ id: number, amount: number, note: string,
 *   category: string, createdAt: number }>}  `amount` in integer paise.
 */
export async function addEntry({ amount, note, category, createdAt } = {}) {
  const record = {
    amount: rupeesToPaise(amount),
    note: String(note ?? ''),
    // Free-form for now; auto-categorisation is a later deliverable.
    category: String(category ?? ''),
    createdAt: toTimestamp(createdAt),
  };
  const db = await openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const request = tx.objectStore(STORE).add(record);
    let id;
    request.onsuccess = () => {
      id = request.result;
    };
    tx.oncomplete = () => resolve({ ...record, id });
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger write was aborted.'));
  });
}

/**
 * Sets one stored entry's `category` and resolves with the updated record
 * once the write has committed. Only `category` changes; amount, note, date
 * and every other field are written back as they were.
 * @param {number} id  the entry's `id`.
 * @param {string} category  one of `CATEGORIES`, e.g. `Food`.
 * @returns {Promise<object>}  the stored record with its new `category`.
 * @throws {Error} when `category` is not one of `CATEGORIES` (nothing is
 *   written) or no entry has that `id`.
 */
export async function updateCategory(id, category) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Category must be one of ${CATEGORIES.join(', ')}; got ${String(category)}.`);
  }
  const db = await openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let updated;
    request.onsuccess = () => {
      if (!request.result) return;
      updated = { ...request.result, category };
      store.put(updated);
    };
    tx.oncomplete = () =>
      updated ? resolve(updated) : reject(new Error(`No ledger entry has id ${String(id)}.`));
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger write was aborted.'));
  });
}

/**
 * Adds a batch of records in one readwrite transaction and resolves with how
 * many were added once it has committed. Inside that transaction it reads
 * every stored record and calls `select(stored)`, which returns the records
 * to add. It only ever adds: no stored record is deleted or overwritten. If
 * the transaction fails, none of the batch is added.
 * @param {(stored: object[]) => object[]} select  must be synchronous; the
 *   returned records are written as given, each getting a fresh `id`.
 * @returns {Promise<number>}
 */
export async function addMissingEntries(select) {
  const db = await openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(STORE);
    const request = store.index(CREATED_AT).getAll();
    let added = 0;
    request.onsuccess = () => {
      for (const record of select(request.result)) {
        const { id, ...fresh } = record;
        store.add(fresh);
        added += 1;
      }
    };
    tx.oncomplete = () => resolve(added);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger write was aborted; nothing was added.'));
  });
}

/**
 * A stored record as the app reads it: one saved before categories existed
 * (no `category` field) gets `categorise(note)`; any other is returned as is.
 * The stored record itself is not touched.
 * @template {{ note?: unknown, category?: unknown }} T
 * @param {T} record
 * @returns {T & { category: unknown }}
 */
export function withCategory(record) {
  if (record.category !== undefined) return record;
  return { ...record, category: categorise(record.note) };
}

/**
 * Every stored entry, oldest first by `createdAt`, each carrying a
 * `category` (see `withCategory`).
 * @returns {Promise<Array<{ id: number, amount: number, note: string,
 *   category: string, createdAt: number }>>}
 */
export async function listEntries() {
  const db = await openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index(CREATED_AT).getAll();
    tx.oncomplete = () =>
      resolve([...request.result].map(withCategory).sort((a, b) => a.createdAt - b.createdAt));
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger read was aborted.'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new Error('IndexedDB is not available, so the ledger cannot be opened.'));
      return;
    }

    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex(CREATED_AT, CREATED_AT);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema needs this connection out of the
      // way; the next call reopens.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('The ledger database could not be opened.'));
  });
}

/**
 * Rupees to integer paise, the one conversion every writer uses. Rounding
 * absorbs float noise (0.29 * 100 is 28.999999999999996) but not a real
 * fraction of a paisa such as ₹120.005, which is refused rather than
 * silently changed; so is anything that is not a positive, finite amount of
 * at least one paisa.
 * @param {number} amount  rupees, e.g. 45.5.
 * @returns {number}  integer paise, e.g. 4550.
 * @throws {Error} when `amount` cannot be stored exactly as whole paise.
 */
export function rupeesToPaise(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Amount must be a positive, finite number of rupees; got ${String(amount)}.`);
  }
  const paise = Math.round(amount * 100);
  if (paise < 1 || !Number.isSafeInteger(paise) || Math.abs(amount * 100 - paise) > 1e-6) {
    throw new Error(`Amount ${amount} cannot be stored as a whole number of paise.`);
  }
  return paise;
}

// An entry without a valid `createdAt` would be left out of the index and
// so out of `listEntries`, so an invalid one is refused.
function toTimestamp(createdAt) {
  if (createdAt === undefined || createdAt === null) return Date.now();
  const time = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new Error(`createdAt must be epoch milliseconds or a valid Date; got ${String(createdAt)}.`);
  }
  return time;
}

// The versioned ledger API the entry box writes through: `add` saves one
// entry, `listByDay` reads back one local calendar day and `listByMonth` one
// local calendar month. It shares the
// `rupee-ledger` database, `entries` store and `createdAt` index opened by
// `./ledger/store.js`, and like that module it uses raw IndexedDB with no
// library and no network, so every entry stays on the phone.
//
// Every record written here carries `schemaVersion: 1`. The loader refuses
// to guess at any other shape: a record with a different or missing version
// (including the unversioned rupee records `addEntry` writes) makes
// `listByDay` and `listByMonth` reject with an `UnknownSchemaVersionError` naming it, rather
// than return it as an entry with misread fields.
//
// `add` stamps each entry with `categorise(note)` in that same single write,
// and resolves only from the write transaction's `oncomplete`, once the
// entry has committed, so a tab kill cannot lose an entry the screen has
// already shown as saved. Entries saved before categories existed are read
// back with `categorise(note)` filled in rather than migrated. The module
// offers no delete, overwrite or merge; re-picking an entry's category is
// `updateCategory` in ./ledger/store.js.

import { categorise } from './categorise.js';
import { openLedger, closeLedger, withCategory } from './ledger/store.js';

export { closeLedger };

export const SCHEMA_VERSION = 1;

const STORE = 'entries';
const CREATED_AT = 'createdAt';

/**
 * Raised by `listByDay` when the day holds a stored record whose
 * `schemaVersion` this build does not know.
 */
export class UnknownSchemaVersionError extends Error {
  /** @param {Array<{ id: unknown, schemaVersion: unknown }>} records */
  constructor(records) {
    const listed = records
      .map(({ id, schemaVersion }) => `id ${String(id)} (schemaVersion ${String(schemaVersion)})`)
      .join(', ');
    super(`The ledger holds records with an unknown schema version: ${listed}.`);
    this.name = 'UnknownSchemaVersionError';
    this.records = records;
  }
}

/**
 * Saves one entry, with `category` set to `categorise(note)`, and resolves
 * with the stored record, including its `id`, once the write has committed.
 * @param {{ amountPaise: number, note?: string, createdAt?: number | Date }} entry
 *   `amountPaise` a positive whole number of paise (₹120 is 12000);
 *   `createdAt` in epoch milliseconds or a Date, defaulting to now.
 * @returns {Promise<{ id: number, schemaVersion: 1, amountPaise: number,
 *   note: string, category: string, createdAt: number }>}
 */
export async function add({ amountPaise, note, createdAt } = {}) {
  const text = String(note ?? '');
  const record = {
    schemaVersion: SCHEMA_VERSION,
    amountPaise: checkPaise(amountPaise),
    note: text,
    category: categorise(text),
    createdAt: toTimestamp(createdAt, 'createdAt'),
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
 * The entries whose `createdAt` falls on the local calendar day containing
 * `date`, oldest first. Rejects with `UnknownSchemaVersionError` if any
 * record on that day is not `schemaVersion: 1`.
 * @param {number | Date} date  any moment on the wanted day.
 * @returns {Promise<Array<{ id: number, schemaVersion: 1, amountPaise: number,
 *   note: string, category: string, createdAt: number }>>}
 */
export async function listByDay(date) {
  const day = new Date(toTimestamp(date, 'date'));
  // Built from calendar fields, not by adding 24 hours, so a day that
  // gains or loses an hour to a clock change still has the right bounds.
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return listRange(start, end);
}

/**
 * The entries whose `createdAt` falls in the local calendar month containing
 * `date`, oldest first; what the This month total is summed from. Rejects
 * with `UnknownSchemaVersionError` like `listByDay`.
 * @param {number | Date} date  any moment in the wanted month.
 * @returns {Promise<Array<{ id: number, schemaVersion: 1, amountPaise: number,
 *   note: string, category: string, createdAt: number }>>}
 */
export async function listByMonth(date) {
  const day = new Date(toTimestamp(date, 'date'));
  const start = new Date(day.getFullYear(), day.getMonth(), 1).getTime();
  const end = new Date(day.getFullYear(), day.getMonth() + 1, 1).getTime();
  return listRange(start, end);
}

// Every record with `start <= createdAt < end`, checked for a known schema
// version before any of it is returned, each carrying a `category`.
async function listRange(start, end) {
  const range = globalThis.IDBKeyRange.bound(start, end, false, true);
  const db = await openLedger();

  const records = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index(CREATED_AT).getAll(range);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger read was aborted.'));
  });

  const unknown = records.filter((record) => record.schemaVersion !== SCHEMA_VERSION);
  if (unknown.length > 0) {
    throw new UnknownSchemaVersionError(
      unknown.map(({ id, schemaVersion }) => ({ id, schemaVersion })),
    );
  }
  return records.map(withCategory).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

// Paise are stored as given; anything that is not a positive safe integer
// is refused rather than rounded into a different amount.
function checkPaise(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1) {
    throw new Error(`amountPaise must be a positive whole number of paise; got ${String(amountPaise)}.`);
  }
  return amountPaise;
}

// An entry without a valid `createdAt` would be left out of the index and
// so out of every day's list, so an invalid one is refused.
function toTimestamp(value, name) {
  if (name === 'createdAt' && (value === undefined || value === null)) return Date.now();
  const time = value instanceof Date ? value.getTime() : value;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new Error(`${name} must be epoch milliseconds or a valid Date; got ${String(value)}.`);
  }
  return time;
}

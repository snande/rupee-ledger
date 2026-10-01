// Backup import: reads a backup file's text and merges its entries into the
// on-device ledger. Like the rest of the ledger it is raw IndexedDB with no
// library and no network; parsing and merging happen entirely on the phone.
//
// A backup file is JSON of this shape (the export writes exactly this, using
// `BACKUP_FORMAT` and `BACKUP_FORMAT_VERSION` from this module):
//
//   {"format":"rupee-ledger-backup","version":1,"exportedAt":"<ISO>",
//    "entries":[{"id":"…","amount":120,"text":"chai","category":"Food",
//                "createdAt":"<ISO>"}]}
//
// `amount` is in rupees (₹120 is 120); it is stored as integer paise, the
// unit the ledger already uses, with no currency conversion.
//
// Merging never deletes or overwrites: an entry is written with `add` only
// when no stored entry has the same key, and every write goes in one
// readwrite transaction, so a failed import leaves nothing behind. The key is
// `createdAt`, paise and note, not `id`: stored ids are auto-incremented per
// device, so phone A's entry 1 and phone B's entry 1 are different entries.
// Imported records get a fresh id and carry `schemaVersion` like those
// `add` in ./ledger.js writes.

import { categorise, CATEGORIES } from './categorise.js';
import { SCHEMA_VERSION } from './ledger.js';

export const BACKUP_FORMAT = 'rupee-ledger-backup';
export const BACKUP_FORMAT_VERSION = 1;

const STORE = 'entries';
const CREATED_AT = 'createdAt';

/**
 * Parses and validates the text of a backup file. Every entry is checked
 * before anything is returned.
 * @param {string} text
 * @returns {{ entries: Array<{ id?: unknown, amount: number, text: string,
 *   category: string, createdAt: string | number }> }}  `amount` in rupees.
 * @throws {Error} naming the problem: malformed JSON, a wrong `format`, a
 *   missing or unknown `version`, or an invalid entry.
 */
export function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text);
  } catch (error) {
    throw new Error(`The backup file is not valid JSON: ${error.message}`);
  }
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('The backup file is not a rupee-ledger backup: expected a JSON object.');
  }
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error(`The backup file format must be "${BACKUP_FORMAT}"; got ${JSON.stringify(backup.format)}.`);
  }
  if (backup.version === undefined) {
    throw new Error('The backup file has no format version.');
  }
  if (backup.version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unknown backup format version ${JSON.stringify(backup.version)}; this build reads version ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  if (!Array.isArray(backup.entries)) {
    throw new Error('The backup file has no entries list.');
  }

  const entries = backup.entries.map((entry, index) => {
    toRecord(entry, index);
    return {
      ...(entry.id === undefined ? {} : { id: entry.id }),
      amount: entry.amount,
      text: entry.text ?? '',
      category: entry.category ?? '',
      createdAt: entry.createdAt,
    };
  });
  return { entries };
}

/**
 * Counts what `importEntries` would add and skip, without writing anything,
 * so an import can be previewed before it runs.
 * @param {{ openLedger: () => Promise<IDBDatabase> }} store  ./ledger/store.js.
 * @param {Array<object>} entries  as `parseBackup` returns them.
 * @returns {Promise<{ added: number, skipped: number }>}
 */
export async function previewImport(store, entries) {
  const records = toRecords(entries);
  const db = await store.openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index(CREATED_AT).getAll();
    tx.oncomplete = () => resolve(split(request.result, records).counts);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The ledger read was aborted.'));
  });
}

/**
 * Adds every backup entry not already in the ledger, all in one readwrite
 * transaction, and resolves once it has committed. Existing entries are
 * never deleted or overwritten; if the transaction fails, nothing is added.
 * @param {{ openLedger: () => Promise<IDBDatabase> }} store  ./ledger/store.js.
 * @param {Array<object>} entries  as `parseBackup` returns them.
 * @returns {Promise<{ added: number, skipped: number }>}
 * @throws {Error} when an entry is invalid (nothing is written).
 */
export async function importEntries(store, entries) {
  const records = toRecords(entries);
  const db = await store.openLedger();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    const objectStore = tx.objectStore(STORE);
    const request = objectStore.index(CREATED_AT).getAll();
    let counts;
    request.onsuccess = () => {
      const result = split(request.result, records);
      counts = result.counts;
      for (const record of result.toAdd) objectStore.add(record);
    };
    tx.oncomplete = () => resolve(counts);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? request.error ?? new Error('The backup import was aborted; nothing was added.'));
  });
}

// The records not yet stored (nor repeated earlier in the backup) and the
// counts of those added and skipped.
function split(existing, records) {
  const seen = new Set(existing.map(dedupeKey));
  const toAdd = [];
  for (const record of records) {
    const key = dedupeKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    toAdd.push(record);
  }
  return { toAdd, counts: { added: toAdd.length, skipped: records.length - toAdd.length } };
}

// Versioned records hold `amountPaise`; older unversioned ones hold paise
// in `amount` (see `addEntry` in ./ledger/store.js).
function dedupeKey(record) {
  return JSON.stringify([record.createdAt, record.amountPaise ?? record.amount, record.note ?? '']);
}

function toRecords(entries) {
  if (!Array.isArray(entries)) throw new Error('Backup entries must be an array.');
  return entries.map(toRecord);
}

// A backup entry as the record the ledger stores, or an Error naming what
// is wrong with it.
function toRecord(entry, index) {
  const where = `Backup entry ${index + 1}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where} is not an object.`);
  }
  const { amount, text, category, createdAt } = entry;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`${where} has a non-numeric amount: ${JSON.stringify(amount)}.`);
  }
  if (amount < 0) {
    throw new Error(`${where} has a negative amount: ₹${amount}.`);
  }
  const amountPaise = Math.round(amount * 100);
  if (amountPaise < 1 || !Number.isSafeInteger(amountPaise)) {
    throw new Error(`${where} has an amount of ₹${amount}, which is not a positive whole number of paise.`);
  }
  if (text !== undefined && typeof text !== 'string') {
    throw new Error(`${where} has a text that is not a string.`);
  }
  if (category !== undefined && typeof category !== 'string') {
    throw new Error(`${where} has a category that is not a string.`);
  }
  const time = typeof createdAt === 'string' || typeof createdAt === 'number' ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(time)) {
    throw new Error(`${where} has an invalid createdAt: ${JSON.stringify(createdAt)}.`);
  }

  const note = text ?? '';
  return {
    schemaVersion: SCHEMA_VERSION,
    amountPaise,
    note,
    category: CATEGORIES.includes(category) ? category : categorise(note),
    createdAt: time,
  };
}

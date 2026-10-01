// Backup import: reads a backup file's text and merges its entries into the
// on-device ledger in ./ledger/store.js. Like the rest of the ledger it uses
// no library and no network; parsing and merging happen entirely on the phone.
//
// A backup file is JSON of this shape (the export writes exactly this, using
// `BACKUP_FORMAT` and `BACKUP_FORMAT_VERSION` from this module):
//
//   {"format":"rupee-ledger-backup","version":1,"exportedAt":"<ISO>",
//    "entries":[{"id":"…","amount":120,"text":"chai","category":"Food",
//                "createdAt":"<ISO>"}]}
//
// `amount` is in rupees (₹120 is 120); it is stored as integer paise through
// `rupeesToPaise`, the same conversion `addEntry` uses, with no currency
// conversion. An amount that is not a whole number of paise is refused
// rather than rounded.
//
// Merging never deletes or overwrites: entries are added through
// `addMissingEntries`, in one readwrite transaction, so a failed import
// leaves nothing behind. Entries match on `createdAt`, paise and note, not
// `id`: stored ids are auto-incremented per device, so phone A's entry 1 and
// phone B's entry 1 are different entries. Matching counts copies, so two
// identical entries in a backup (two chai logged in the same millisecond)
// are both imported, and importing that backup again adds neither. Imported
// records get a fresh id and carry `schemaVersion` like those `add` in
// ./ledger.js writes.

import { categorise } from './categorise.js';
import { SCHEMA_VERSION } from './ledger.js';
import { rupeesToPaise } from './ledger/store.js';

export const BACKUP_FORMAT = 'rupee-ledger-backup';
export const BACKUP_FORMAT_VERSION = 1;

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
 * @param {{ listEntries: () => Promise<object[]> }} store  ./ledger/store.js.
 * @param {Array<object>} entries  as `parseBackup` returns them.
 * @returns {Promise<{ added: number, skipped: number }>}
 */
export async function previewImport(store, entries) {
  const records = toRecords(entries);
  const added = missing(await store.listEntries(), records).length;
  return { added, skipped: records.length - added };
}

/**
 * Adds every backup entry not already in the ledger, all in one readwrite
 * transaction, and resolves once it has committed. Existing entries are
 * never deleted or overwritten; if the transaction fails, nothing is added.
 * @param {{ addMissingEntries: (select: (stored: object[]) => object[]) =>
 *   Promise<number> }} store  ./ledger/store.js.
 * @param {Array<object>} entries  as `parseBackup` returns them.
 * @returns {Promise<{ added: number, skipped: number }>}
 * @throws {Error} when an entry is invalid (nothing is written).
 */
export async function importEntries(store, entries) {
  const records = toRecords(entries);
  const added = await store.addMissingEntries((stored) => missing(stored, records));
  return { added, skipped: records.length - added };
}

// The records not yet stored. Each stored record matches at most one backup
// record with its key, so a key the backup holds twice and the store once
// adds one copy.
function missing(stored, records) {
  const counts = new Map();
  for (const record of stored) {
    const key = dedupeKey(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return records.filter((record) => {
    const key = dedupeKey(record);
    const left = counts.get(key) ?? 0;
    if (left === 0) return true;
    counts.set(key, left - 1);
    return false;
  });
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
  let amountPaise;
  try {
    amountPaise = rupeesToPaise(amount);
  } catch {
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
    // Kept exactly as phone A had it; only an entry with no category gets
    // one, the way every read fills in an uncategorised entry.
    category: category || categorise(note),
    createdAt: time,
  };
}

// Builds the backup file a user exports to move their ledger to another
// device. The `format` marker and `version` number let the importer reject
// foreign files and versions it does not know. Entries are copied exactly as
// stored (amounts are not converted), so they round-trip without loss. Pure:
// no DOM, no storage, no network, no clock — `now` is passed in.

export const BACKUP_FORMAT = 'rupee-ledger-backup';
export const BACKUP_VERSION = 1;

/**
 * The backup object for `entries`, ready for `JSON.stringify`.
 * @param {Array<{ id: number, amount: number, note: string,
 *   category: string, createdAt: number }>} entries  Stored entries as
 *   `listEntries()` in src/ledger/store.js returns them; any other fields
 *   are kept too.
 * @param {Date} now  The export moment.
 * @returns {{ format: string, version: number, exportedAt: string,
 *   entries: Array<object> }}  Entries in their original order, each a copy
 *   with every field unchanged.
 */
export function buildBackup(entries, now) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    entries: entries.map((entry) => ({ ...entry })),
  };
}

/**
 * The download name for a backup taken at `now`, in the shape
 * `rupee-ledger-backup-YYYY-MM-DD.json` and dated by the device-local
 * calendar day, e.g. `rupee-ledger-backup-2025-03-07.json`.
 * @param {Date} now
 * @returns {string}
 */
export function backupFilename(now) {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${BACKUP_FORMAT}-${year}-${month}-${day}.json`;
}

/**
 * The backup file's text: `buildBackup(entries, now)` as indented JSON.
 * `JSON.parse` of the result is deep-equal to `buildBackup(entries, now)`.
 * @param {Array<object>} entries
 * @param {Date} now
 * @returns {string}
 */
export function serializeBackup(entries, now) {
  return JSON.stringify(buildBackup(entries, now), null, 2);
}

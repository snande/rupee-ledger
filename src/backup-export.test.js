import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFilename,
  buildBackup,
  serializeBackup,
} from './backup-export.js';

// Built with the local-time Date constructor, so every fixture means the
// same wall-clock moment whatever time zone the tests run in.
const at = (year, month, day, hours = 12, minutes = 0) =>
  new Date(year, month - 1, day, hours, minutes);

const now = at(2025, 3, 7, 9, 0);

// Shaped like listEntries() in src/ledger/store.js: amount in paise as stored.
const entries = [
  { id: 3, amount: 12000, note: 'chai', category: 'Food', createdAt: 1741318200000 },
  { id: 1, amount: 4550, note: 'auto', category: 'Travel', createdAt: 1741231800000 },
  { id: 2, amount: 30000, note: '', category: '', createdAt: 1741404600000, extra: { kept: true } },
];

test('buildBackup marks the format, version and export time', () => {
  const backup = buildBackup(entries, now);
  assert.equal(backup.format, 'rupee-ledger-backup');
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.version, 1);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.exportedAt, now.toISOString());
  assert.deepEqual(Object.keys(backup).sort(), ['entries', 'exportedAt', 'format', 'version']);
});

test('buildBackup keeps every entry and field unchanged, in order', () => {
  const before = structuredClone(entries);
  const backup = buildBackup(entries, now);
  assert.deepEqual(backup.entries, entries);
  assert.deepEqual(backup.entries.map((entry) => entry.id), [3, 1, 2]);
  assert.notEqual(backup.entries, entries);
  assert.deepEqual(entries, before);
});

test('buildBackup of no entries has an empty entries array', () => {
  const backup = buildBackup([], now);
  assert.deepEqual(backup.entries, []);
  assert.equal(backup.version, 1);
});

test('backupFilename uses the device-local calendar date', () => {
  assert.equal(backupFilename(now), 'rupee-ledger-backup-2025-03-07.json');
  assert.equal(backupFilename(at(2026, 12, 25, 23, 59)), 'rupee-ledger-backup-2026-12-25.json');
  assert.equal(backupFilename(at(2026, 1, 1, 0, 0)), 'rupee-ledger-backup-2026-01-01.json');
});

test('serializeBackup parses back to buildBackup', () => {
  assert.deepEqual(JSON.parse(serializeBackup(entries, now)), buildBackup(entries, now));
  assert.deepEqual(JSON.parse(serializeBackup([], now)), buildBackup([], now));
});

test('the same arguments always give the same output', () => {
  assert.equal(serializeBackup(entries, now), serializeBackup(entries, now));
  assert.equal(backupFilename(now), backupFilename(now));
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseBackup, importEntries, previewImport, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './backup-import.js';
import * as store from './ledger/store.js';
import { add, listByMonth } from './ledger.js';
import { totals } from './totals.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from './ledger/fake-indexeddb.js';

let fake;

const storedRecords = () => [...fake.databases.get('rupee-ledger').stores.get('entries').records.values()];

const now = new Date(2026, 8, 30, 20, 0);
const at = (day, hour) => new Date(2026, 8, day, hour).toISOString();

const backupEntries = [
  { id: 1, amount: 120, text: 'chai', category: 'Food', createdAt: at(1, 9) },
  { id: 2, amount: 45.5, text: 'auto', category: 'Transport', createdAt: at(12, 18) },
  { id: 3, amount: 0.29, text: 'stamp', category: 'Other', createdAt: at(30, 8) },
  { id: 4, amount: 1999.99, text: 'shoes', category: 'Shopping', createdAt: at(30, 11) },
];

const backupText = (entries = backupEntries, extra = {}) =>
  JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, exportedAt: now.toISOString(), entries, ...extra });

const backupTotals = (entries) => totals(entries.map((e) => ({ amount: e.amount, ts: e.createdAt })), now);
const storeTotals = () => totals(storedRecords().map((r) => ({ amountPaise: r.amountPaise ?? r.amount, ts: r.createdAt })), now);

beforeEach(async () => {
  await store.closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

test('BACKUP_FORMAT_VERSION is 1 and parseBackup returns the entries of a valid backup', () => {
  assert.equal(BACKUP_FORMAT_VERSION, 1);
  assert.deepEqual(parseBackup(backupText()), { entries: backupEntries });
});

test('parseBackup throws an Error naming the problem, and never partially returns', () => {
  const cases = [
    ['{"format":', /not valid JSON/],
    ['[]', /expected a JSON object/],
    [JSON.stringify({ format: 'other', version: 1, entries: [] }), /format must be "rupee-ledger-backup"/],
    [JSON.stringify({ format: BACKUP_FORMAT, entries: [] }), /no format version/],
    [backupText([], { version: 2 }), /Unknown backup format version 2/],
    [backupText([], { version: '1' }), /Unknown backup format version "1"/],
    [backupText([], { entries: undefined }), /no entries list/],
    [backupText([...backupEntries, { amount: '120', text: 'chai', createdAt: at(2, 9) }]), /entry 5 has a non-numeric amount/],
    [backupText([{ text: 'chai', createdAt: at(2, 9) }]), /entry 1 has a non-numeric amount/],
    [backupText([backupEntries[0], { amount: -5, text: 'refund', createdAt: at(2, 9) }]), /entry 2 has a negative amount/],
    [backupText([{ amount: 0, text: 'free', createdAt: at(2, 9) }]), /not a positive whole number of paise/],
    [backupText([{ amount: 120.005, text: 'chai', createdAt: at(2, 9) }]), /₹120.005, which is not a positive whole number of paise/],
    [backupText([{ amount: 10, text: 'chai', createdAt: 'yesterday' }]), /entry 1 has an invalid createdAt/],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => parseBackup(text), (error) => error instanceof Error && message.test(error.message), text);
  }
});

test('importing N entries into an empty store leaves exactly N entries and matching totals', async () => {
  const { entries } = parseBackup(backupText());

  assert.deepEqual(await importEntries(store, entries), { added: 4, skipped: 0 });

  assert.equal(storedRecords().length, 4);
  assert.deepEqual(storeTotals(), backupTotals(entries));
  assert.deepEqual(storeTotals(), { today: 200028, month: 216578 });
});

test('imported records carry schemaVersion 1, rupee amounts as paise, and read back through listByMonth', async () => {
  await importEntries(store, parseBackup(backupText()).entries);

  const records = await listByMonth(now);
  assert.equal(records.length, 4);
  assert.deepEqual(records[0], {
    id: 1,
    schemaVersion: 1,
    amountPaise: 12000,
    note: 'chai',
    category: 'Food',
    createdAt: new Date(2026, 8, 1, 9).getTime(),
  });
  assert.deepEqual(records.map((r) => r.amountPaise), [12000, 4550, 29, 199999]);
});

test("a backup entry's category is kept as phone A had it; only a missing one is filled in", async () => {
  const entries = [
    { amount: 80, text: 'chai', category: 'Gifts', createdAt: at(3, 9) },
    { amount: 90, text: 'chai', createdAt: at(4, 9) },
  ];
  await importEntries(store, parseBackup(backupText(entries)).entries);

  assert.deepEqual(storedRecords().map((r) => r.category), ['Gifts', 'Food']);
});

test('importing the same backup a second time adds nothing and skips all N', async () => {
  const { entries } = parseBackup(backupText());
  await importEntries(store, entries);
  const before = storeTotals();

  assert.deepEqual(await importEntries(store, entries), { added: 0, skipped: 4 });
  assert.equal(storedRecords().length, 4);
  assert.deepEqual(storeTotals(), before);
});

test('two identical entries in one backup are both imported, and a re-import adds neither', async () => {
  const chai = { amount: 20, text: 'chai', category: 'Food', createdAt: at(30, 16) };
  const { entries } = parseBackup(backupText([chai, { ...chai }]));

  assert.deepEqual(await importEntries(store, entries), { added: 2, skipped: 0 });
  assert.equal(storedRecords().length, 2);
  assert.deepEqual(storeTotals(), backupTotals(entries));
  assert.deepEqual(storeTotals(), { today: 4000, month: 4000 });

  assert.deepEqual(await importEntries(store, entries), { added: 0, skipped: 2 });
  assert.equal(storedRecords().length, 2);
  assert.deepEqual(storeTotals(), backupTotals(entries));
});

test('a key stored once and held twice in the backup adds the one missing copy', async () => {
  const chai = { amount: 20, text: 'chai', category: 'Food', createdAt: at(30, 16) };
  await importEntries(store, parseBackup(backupText([chai])).entries);

  assert.deepEqual(await importEntries(store, parseBackup(backupText([chai, chai])).entries), { added: 1, skipped: 1 });
  assert.equal(storedRecords().length, 2);
});

test('importing into a store with other entries keeps them and adds only the new backup entries', async () => {
  const mine = await add({ amountPaise: 5000, note: 'lunch', createdAt: new Date(2026, 8, 30, 13).getTime() });
  const legacy = await store.addEntry({ amount: 120, note: 'chai', createdAt: new Date(2026, 8, 1, 9) });
  const kept = structuredClone(storedRecords());

  // Backup entry 1 is the same chai already on this phone (an older,
  // unversioned record); the other three are new.
  const result = await importEntries(store, parseBackup(backupText()).entries);

  assert.deepEqual(result, { added: 3, skipped: 1 });
  const records = storedRecords();
  assert.equal(records.length, 5);
  assert.deepEqual(records.slice(0, 2), kept);
  assert.deepEqual(kept.map((r) => r.id), [mine.id, legacy.id]);
});

test('ids from another device do not hide entries that merely share an id', async () => {
  await add({ amountPaise: 999, note: 'here', createdAt: new Date(2026, 8, 5).getTime() });

  assert.deepEqual(await importEntries(store, parseBackup(backupText()).entries), { added: 4, skipped: 0 });
  assert.equal(storedRecords().length, 5);
});

test('the import is one readwrite transaction that only adds, never puts or deletes', async () => {
  await importEntries(store, parseBackup(backupText()).entries);

  const writes = fake.transactions.filter((tx) => tx.mode === 'readwrite');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].requests.map((r) => r.kind), ['getAll', 'add', 'add', 'add', 'add']);
  assert.deepEqual(writes[0].options, { durability: 'strict' });
});

test('a failed import rejects and adds no entries at all', async () => {
  await add({ amountPaise: 5000, note: 'lunch', createdAt: new Date(2026, 8, 30, 13).getTime() });
  fake.failNext = 'abort';

  await assert.rejects(importEntries(store, parseBackup(backupText()).entries), /Quota exceeded/);
  assert.equal(storedRecords().length, 1);
});

test('an invalid entry is refused before any transaction opens', async () => {
  const transactions = fake.transactions.length;
  await assert.rejects(
    importEntries(store, [...backupEntries, { amount: -1, text: 'x', createdAt: at(2, 9) }]),
    /entry 5 has a negative amount/,
  );
  assert.equal(fake.transactions.length, transactions);
});

test('previewImport counts what an import would add and skip without writing', async () => {
  const { entries } = parseBackup(backupText());
  await importEntries(store, entries.slice(0, 2));

  assert.deepEqual(await previewImport(store, entries), { added: 2, skipped: 2 });
  assert.equal(storedRecords().length, 2);
  assert.equal(fake.transactions.filter((tx) => tx.mode === 'readwrite').length, 1);
});

test('previewImport rejects when the ledger cannot be read', async () => {
  globalThis.indexedDB = undefined;

  await assert.rejects(previewImport(store, parseBackup(backupText()).entries), /IndexedDB is not available/);
});

test('the module makes no network request and adds no currency conversion', async () => {
  const source = await readFile(new URL('./backup-import.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  assert.doesNotMatch(source, /\b(USD|EUR|exchange rate|convertCurrency)\b/i);
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseBackup, importEntries, previewImport, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './backup-import.js';
import * as store from './ledger/store.js';
import { add, listByMonth } from './ledger.js';
import { totals } from './totals.js';
import { serializeBackup } from './backup-export.js';
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
    [backupText([{ text: 'chai', createdAt: at(2, 9) }]), /entry 1 has no amount: expected amountPaise \(in paise\) or amount \(in rupees\)/],
    [backupText([backupEntries[0], { amount: -5, text: 'refund', createdAt: at(2, 9) }]), /entry 2 has a negative amount/],
    [backupText([{ amount: 0, text: 'free', createdAt: at(2, 9) }]), /not a positive whole number of paise/],
    [backupText([{ amount: 120.005, text: 'chai', createdAt: at(2, 9) }]), /₹120.005, which is not a positive whole number of paise/],
    [backupText([{ amount: 10, text: 'chai', createdAt: 'yesterday' }]), /entry 1 has an invalid createdAt/],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => parseBackup(text), (error) => error instanceof Error && message.test(error.message), text);
  }
});

test('rupeesToPaise is the one conversion: the import and addEntry both refuse a fraction of a paisa', async () => {
  assert.equal(store.rupeesToPaise(0.29), 29);
  assert.equal(store.rupeesToPaise(1999.99), 199999);
  assert.throws(() => store.rupeesToPaise(120.005), /cannot be stored as a whole number of paise/);

  await assert.rejects(store.addEntry({ amount: 120.005, note: 'chai', createdAt: 1 }), /whole number of paise/);
  assert.deepEqual(await store.listEntries(), []);
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

test('a backup written by serializeBackup from stored records imports, and a re-import adds 0', async () => {
  await add({ amountPaise: 12000, note: 'chai', createdAt: new Date(2026, 8, 30, 9).getTime() });
  await store.addEntry({ amount: 45.5, note: 'auto', createdAt: new Date(2026, 8, 30, 10) });
  await store.addEntry({ amount: 10, createdAt: new Date(2026, 8, 30, 11) }); // legacy, empty note
  const text = serializeBackup(await store.listEntries(), now);
  const exported = JSON.parse(text).entries;
  assert.equal(exported[0].amountPaise, 12000);
  assert.equal(exported[0].note, 'chai');
  assert.equal(exported[2].note, '');
  assert.equal(exported[2].amount, 1000);
  const before = storeTotals();

  // Phone B: an empty ledger.
  await store.closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;

  const { entries } = parseBackup(text);
  assert.deepEqual(await previewImport(store, entries), { added: 3, skipped: 0 });
  assert.deepEqual(await importEntries(store, entries), { added: 3, skipped: 0 });
  assert.deepEqual(storeTotals(), before);
  assert.deepEqual(storedRecords().map((r) => r.amountPaise), [12000, 4550, 1000]);
  assert.ok(storedRecords().every((r) => r.schemaVersion === 1));

  assert.deepEqual(await importEntries(store, parseBackup(text).entries), { added: 0, skipped: 3 });
  assert.equal(storedRecords().length, 3);
  assert.deepEqual(storeTotals(), before);
});

/* Test #91: a build that read every entry's `amount` refused phone A's file
   with "Backup entry 1 has a non-numeric amount: undefined", since a record
   from add() holds `amountPaise` and no `amount` at all. */
test('an exported record with amountPaise and no amount imports, never "non-numeric amount: undefined"', async () => {
  await add({ amountPaise: 12000, note: 'chai', createdAt: new Date(2026, 8, 30, 9).getTime() });
  const text = serializeBackup(await store.listEntries(), now);
  const [exported] = JSON.parse(text).entries;
  assert.equal('amount' in exported, false);

  await store.closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;

  assert.deepEqual(await importEntries(store, parseBackup(text).entries), { added: 1, skipped: 0 });
  assert.deepEqual(storedRecords().map((r) => [r.schemaVersion, r.amountPaise, r.note]), [[1, 12000, 'chai']]);

  const noAmount = backupText([{ schemaVersion: 1, note: 'chai', createdAt: 1 }]);
  assert.throws(() => parseBackup(noAmount), (error) => {
    assert.match(error.message, /entry 1 has no amount/);
    assert.doesNotMatch(error.message, /undefined/);
    return true;
  });
});

/* Test #91, from the file side: the exact text Export backup writes on
   phone A, kept as a literal rather than rebuilt with serializeBackup.
   Entries typed into the quick-entry box are stored by add() with
   `amountPaise` and no `amount`; an older phone's addEntry() record holds
   paise in `amount` and has no schemaVersion. Both import, and nothing
   reads an amount as undefined. */
test('a backup file exactly as phone A exports it imports in full, and a second import adds 0', async () => {
  const time = (day, hour) => new Date(2026, 8, day, hour).getTime();
  const file = `{
  "format": "rupee-ledger-backup",
  "version": 1,
  "exportedAt": "2026-09-30T14:30:00.000Z",
  "entries": [
    {
      "schemaVersion": 1,
      "amountPaise": 12000,
      "note": "chai",
      "category": "Food",
      "createdAt": ${time(30, 9)},
      "id": 1
    },
    {
      "schemaVersion": 1,
      "amountPaise": 4550,
      "note": "auto",
      "category": "Transport",
      "createdAt": ${time(30, 10)},
      "id": 2
    },
    {
      "amount": 25000,
      "note": "groceries",
      "category": "",
      "createdAt": ${time(12, 18)},
      "id": 3
    }
  ]
}
`;
  const { entries } = parseBackup(file);
  assert.deepEqual(await previewImport(store, entries), { added: 3, skipped: 0 });
  assert.deepEqual(await importEntries(store, entries), { added: 3, skipped: 0 });
  assert.deepEqual(
    storedRecords().map((r) => [r.schemaVersion, r.amountPaise, r.note, r.category]),
    [[1, 12000, 'chai', 'Food'], [1, 4550, 'auto', 'Transport'], [1, 25000, 'groceries', 'Shopping']],
  );
  assert.deepEqual(storeTotals(), { today: 16550, month: 41550 });

  assert.deepEqual(await importEntries(store, parseBackup(file).entries), { added: 0, skipped: 3 });
  assert.equal(storedRecords().length, 3);
  assert.deepEqual(storeTotals(), { today: 16550, month: 41550 });
});

test('stored-shape entries: createdAt may be a number or an ISO string; bad amounts are refused', async () => {
  const v = (entry) => backupText([{ schemaVersion: 1, note: 'x', createdAt: 1, ...entry }]);
  const iso = parseBackup(v({ amountPaise: 500, createdAt: at(3, 9) })).entries;
  const num = parseBackup(v({ amountPaise: 500, createdAt: new Date(2026, 8, 3, 9).getTime() })).entries;
  assert.deepEqual(await previewImport(store, iso), { added: 1, skipped: 0 });
  await importEntries(store, iso);
  assert.deepEqual(await previewImport(store, num), { added: 0, skipped: 1 });

  assert.throws(() => parseBackup(v({ amountPaise: 'a' })), /entry 1 has a non-numeric amount: "a"/);
  assert.throws(() => parseBackup(v({ amountPaise: null })), /non-numeric amount: null/);
  assert.throws(() => parseBackup(v({ amountPaise: 10.5 })), /whole number of paise/);
  assert.throws(() => parseBackup(v({ amountPaise: 0 })), /whole number of paise/);
  assert.throws(() => parseBackup(v({ amountPaise: -5 })), /negative amount: -5 paise/);
  assert.throws(() => parseBackup(backupText([{ note: 'x', createdAt: 1 }])), /entry 1 has no amount/);
});

test('ambiguous or unknown-version entries are refused, never misread', () => {
  const entry = (extra) => backupText([backupEntries[0], { createdAt: 1, ...extra }]);
  // Mixed shapes.
  assert.throws(() => parseBackup(entry({ amountPaise: 12000, amount: 120, schemaVersion: 1 })), /entry 2 mixes entry shapes/);
  assert.throws(() => parseBackup(entry({ amountPaise: null, amount: 120, text: 'chai', schemaVersion: 1 })), /entry 2 mixes entry shapes/);
  assert.throws(() => parseBackup(entry({ amount: 120, text: 'a', note: 'a' })), /entry 2 mixes entry shapes/);
  // A rupee amount with `note` and an ISO date must not become 120 paise.
  assert.throws(() => parseBackup(entry({ amount: 120, note: 'chai', createdAt: at(2, 9) })), /use text for an amount in rupees/);
  // Versions.
  assert.throws(() => parseBackup(entry({ amountPaise: 100, note: 'x', schemaVersion: 2 })), /entry 2 has an unknown schemaVersion 2/);
  assert.throws(() => parseBackup(entry({ amountPaise: 100, note: 'x', schemaVersion: '1' })), /unknown schemaVersion "1"/);
  assert.throws(() => parseBackup(entry({ amountPaise: 100, note: 'x' })), /no schemaVersion/);
  assert.throws(() => parseBackup(entry({ amount: 100, text: 'x', schemaVersion: 9 })), /unknown schemaVersion 9/);
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
  // The fake's `failNext` only fails readwrite transactions and the preview
  // only reads, so the read fails by having no IndexedDB at all.
  globalThis.indexedDB = undefined;

  await assert.rejects(previewImport(store, parseBackup(backupText()).entries), /IndexedDB is not available/);
});

test('the module makes no network request and adds no currency conversion', async () => {
  const source = await readFile(new URL('./backup-import.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
  assert.doesNotMatch(source, /\b(USD|EUR|exchange rate|convertCurrency)\b/i);
});

/* Regression for #107: phone A's spends typed into the quick-entry box, the
   file the Export backup button downloads, and phone B's import of it. The
   three values the operator compares are read the way the Today screen
   reads them (loadEntries, then totals). */
test('export on phone A, import on phone B: same entries and totals, and a second import adds 0', async () => {
  const { exportBackup } = await import('./backup-download.js');
  const { parseEntry } = await import('./parse-entry.js');
  const { loadEntries } = await import('../js/data/ledger.js');

  const lines = [
    ['120 chai', new Date(2026, 8, 30, 9)],
    ['₹45.50 auto', new Date(2026, 8, 30, 10)],
    ['1999.99 shoes', new Date(2026, 8, 12, 18)],
    ['120 chai', new Date(2026, 8, 30, 9)], // the same spend twice in one millisecond
  ];
  for (const [line, when] of lines) await add({ ...parseEntry(line), createdAt: when.getTime() });
  const onPage = async () => {
    const entries = await loadEntries({ now });
    return { ...totals(entries, now), count: entries.length };
  };
  const phoneA = await onPage();
  assert.deepEqual(phoneA, { today: 28550, month: 228549, count: 4 });

  let blob;
  await exportBackup({
    now,
    doc: { body: { appendChild() {} }, createElement: () => ({ setAttribute() {}, click() {}, remove() {} }) },
    url: { createObjectURL: (b) => ((blob = b), 'blob:backup'), revokeObjectURL() {} },
  });
  const file = await blob.text();

  // Phone B: an empty ledger.
  await store.closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;

  const { entries } = parseBackup(file);
  assert.deepEqual(await importEntries(store, entries), { added: 4, skipped: 0 });
  assert.deepEqual(await onPage(), phoneA);
  assert.deepEqual(
    (await loadEntries({ now })).map(({ amountPaise, note }) => [amountPaise, note]).sort(),
    [[12000, 'chai'], [12000, 'chai'], [199999, 'shoes'], [4550, 'auto']],
  );

  assert.deepEqual(await importEntries(store, parseBackup(file).entries), { added: 0, skipped: 4 });
  assert.deepEqual(await onPage(), phoneA);
});

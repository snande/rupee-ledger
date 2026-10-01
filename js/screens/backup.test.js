import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { renderBackup, mountBackup, importSummary, readFileText } from './backup.js';
import { renderTodayView } from './today.js';
import { renderMonthView } from './month.js';
import { loadEntries, loadMonthEntries } from '../data/ledger.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../../src/backup-import.js';
import * as store from '../../src/ledger/store.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from '../../src/ledger/fake-indexeddb.js';

let fake;

const storedRecords = () => [...fake.databases.get('rupee-ledger').stores.get('entries').records.values()];

const now = new Date(2026, 8, 30, 20, 0);
const at = (day, hour) => new Date(2026, 8, day, hour).toISOString();

const entries = [
  { id: 1, amount: 120, text: 'chai', category: 'Food', createdAt: at(1, 9) },
  { id: 2, amount: 45.5, text: 'auto', category: 'Transport', createdAt: at(12, 18) },
  { id: 3, amount: 80, text: 'lunch', category: 'Food', createdAt: at(30, 8) },
];

const backupText = () =>
  JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, exportedAt: now.toISOString(), entries });

/* A picked file: just the text the screen reads. */
const fileOf = (text) => ({ name: 'backup.json', text: async () => text });

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeElement() {
  const attrs = new Map();
  const listeners = new Map();
  return {
    textContent: '',
    value: 'C:\\fakepath\\backup.json',
    files: [],
    disabled: false,
    focusCount: 0,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    addEventListener: (type, fn) => listeners.set(type, fn),
    /* Choosing a file fires change; the promise is the import's. */
    choose(file) {
      this.files = file ? [file] : [];
      return listeners.get('change')();
    },
    focus() {
      this.focusCount += 1;
    },
  };
}

function fakeScreen() {
  const parts = {
    '[data-backup-file]': fakeElement(),
    '[data-backup-result]': fakeElement(),
    '[data-backup-error]': fakeElement(),
  };
  return {
    main: { querySelector: (selector) => parts[selector] ?? null },
    input: parts['[data-backup-file]'],
    result: parts['[data-backup-result]'],
    error: parts['[data-backup-error]'],
  };
}

/* The totals the Today and Month screens draw from what is in the store. */
async function shownTotals() {
  const today = renderTodayView({ status: 'filled', entries: await loadEntries(new URLSearchParams(), { now }), now });
  const month = renderMonthView({ status: 'filled', entries: await loadMonthEntries('2026-09'), month: '2026-09', now });
  const pick = (html, key) => new RegExp('data-' + key + '-total>([^<]*)<').exec(html)?.[1];
  return {
    today: pick(today, 'today'),
    month: pick(month, 'month'),
    thisMonth: pick(today, 'month'),
  };
}

beforeEach(async () => {
  await store.closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

test('the Backup screen has a file input that accepts .json and application/json', () => {
  assert.match(renderBackup(), /<input type="file"[^>]*accept="\.json,application\/json"[^>]*data-backup-file>/);
  assert.match(renderBackup(), /<label for="backup-file">Import backup<\/label>/);
});

test('choosing a backup file adds its entries, says how many, and the totals follow without a reload', async () => {
  const screen = fakeScreen();
  mountBackup({ main: screen.main });
  assert.equal(screen.input.focusCount, 1);
  const before = await shownTotals();
  assert.equal(before.month, '₹0');

  await screen.input.choose(fileOf(backupText()));
  assert.equal(screen.result.textContent, '3 added, 0 skipped');
  assert.equal(screen.result.getAttribute('hidden'), null);
  assert.equal(screen.error.getAttribute('hidden'), '');
  assert.equal(storedRecords().length, 3);
  assert.equal(screen.input.disabled, false);
  assert.equal(screen.input.value, '', 'the picker is cleared so the same file can be chosen again');

  const after = await shownTotals();
  assert.notEqual(after.month, before.month);
  assert.match(after.month, /245\.50|245\.5/);
  assert.match(after.today, /80/);
});

test('choosing the same file again shows 0 added and leaves the totals as they were', async () => {
  const screen = fakeScreen();
  mountBackup({ main: screen.main });
  await screen.input.choose(fileOf(backupText()));
  const first = await shownTotals();

  await screen.input.choose(fileOf(backupText()));
  assert.equal(screen.result.textContent, '0 added, 3 skipped');
  assert.equal(storedRecords().length, 3);
  assert.deepEqual(await shownTotals(), first);
});

test('an invalid file shows the parseBackup message and leaves the store unchanged', async () => {
  const screen = fakeScreen();
  mountBackup({ main: screen.main });
  await screen.input.choose(fileOf(backupText()));
  const before = storedRecords();

  for (const text of ['not json', JSON.stringify({ format: 'something-else', version: 1, entries: [] })]) {
    let expected;
    try {
      (await import('../../src/backup-import.js')).parseBackup(text);
    } catch (error) {
      expected = error.message;
    }
    await screen.input.choose(fileOf(text));
    assert.equal(screen.error.textContent, expected);
    assert.equal(screen.error.getAttribute('hidden'), null);
    assert.equal(screen.result.textContent, '');
    assert.deepEqual(storedRecords(), before);
  }
});

test('a file that cannot be read shows an error and writes nothing', async () => {
  const screen = fakeScreen();
  let ran = false;
  mountBackup({ main: screen.main, read: async () => { throw new Error('gone'); }, run: async () => { ran = true; } });
  await screen.input.choose(fileOf(''));
  assert.match(screen.error.textContent, /could not be read/);
  assert.equal(ran, false);
  assert.equal(screen.input.disabled, false);
});

test('a failed write shows an error and adds no entries', async () => {
  const screen = fakeScreen();
  mountBackup({ main: screen.main, run: async () => { throw new Error('quota'); } });
  await screen.input.choose(fileOf(backupText()));
  assert.match(screen.error.textContent, /Nothing was added/);
  assert.equal(screen.result.textContent, '');
});

test('nothing is drawn once the router has replaced the screen', async () => {
  const screen = fakeScreen();
  mountBackup({ main: screen.main, isCurrent: () => false });
  await screen.input.choose(fileOf(backupText()));
  await tick();
  assert.equal(screen.result.textContent, '');
  assert.equal(storedRecords().length, 3, 'the import itself still commits');
});

test('importSummary names the added and skipped counts', () => {
  assert.equal(importSummary({ added: 0, skipped: 2 }), '0 added, 2 skipped');
});

test('readFileText uses File.text(), else a FileReader, and never the network', async () => {
  assert.equal(await readFileText({ text: async () => 'abc' }), 'abc');
  const original = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsText() {
      this.result = 'from reader';
      this.onload();
    }
  };
  try {
    assert.equal(await readFileText({}), 'from reader');
  } finally {
    globalThis.FileReader = original;
  }
  const source = await readFile(new URL('./backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/);
});

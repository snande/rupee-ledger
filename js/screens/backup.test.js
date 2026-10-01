// The Backup screen against a fake IndexedDB: choosing a backup file adds
// its entries and says how many, choosing it again adds none and leaves the
// Today and Month totals as they were, and a file that is not a backup shows
// parseBackup's message and writes nothing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { addedMessage, IMPORT_LABEL, mountBackup, readFileText, renderBackup } from './backup.js';
import { mountToday } from './today.js';
import { mountMonth } from './month.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, parseBackup } from '../../src/backup-import.js';
import { formatPaise } from '../../src/format-amount.js';
import { closeLedger } from '../../src/ledger/store.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from '../../src/ledger/fake-indexeddb.js';

/* The fake ledger answers on timers, so wait a few of them out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let fake;

beforeEach(async () => {
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

afterEach(async () => {
  await closeLedger();
});

const storedRecords = () => [...(fake.databases.get('rupee-ledger')?.stores.get('entries')?.records.values() ?? [])];

/* Just enough of a rendered screen for its mount: every selector asked for
   gets an element that keeps innerHTML, attributes and listeners. */
function fakeMain() {
  const parts = new Map();
  const element = () => {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    return {
      innerHTML: '',
      textContent: '',
      value: '',
      files: null,
      disabled: false,
      offsetWidth: 0,
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      hasAttribute: (name) => attrs.has(name),
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
      dispatch: (type, event = {}) => listeners.get(type)?.(event),
      focus() {},
    };
  };
  return {
    part(selector) {
      if (!parts.has(selector)) parts.set(selector, element());
      return parts.get(selector);
    },
    querySelector(selector) {
      return this.part(selector);
    },
  };
}

/* A File as the picker hands it over: only text() is offered. */
const fileOf = (text) => ({ name: 'rupee-ledger-backup.json', type: 'application/json', text: async () => text });

/* Two spends from the first minutes of today, as Export backup writes them. */
function backupText(now = new Date()) {
  const earlier = (minutes) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minutes).toISOString();
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    entries: [
      { id: 1, amount: 120, text: 'chai', category: 'Food', createdAt: earlier(0) },
      { id: 2, amount: 45.5, text: 'auto', category: 'Transport', createdAt: earlier(1) },
    ],
  });
}

/* Chooses `file` on the Backup screen and waits for the import to settle. */
async function choose(screen, mounted, file) {
  const input = screen.part('[data-import-file]');
  input.files = [file];
  input.value = 'C:\\fakepath\\' + file.name;
  input.dispatch('change', { target: input });
  await mounted.importing();
  return screen.part('[data-import-status]');
}

const shown = (html, key) => new RegExp('data-' + key + '-total>([^<]*)<').exec(html)?.[1];

/* The totals the Today and Month screens show, each freshly mounted, the
   way the router mounts them when their tab is opened. */
async function totals() {
  const today = fakeMain();
  await mountToday({ main: today });
  const todayView = today.part('[data-today-view]').innerHTML;
  const month = fakeMain();
  await mountMonth({ main: month });
  return {
    today: shown(todayView, 'today'),
    month: shown(todayView, 'month'),
    monthScreen: shown(month.part('[data-month-view]').innerHTML, 'month'),
  };
}

test('the screen offers a JSON file picker labelled Import backup', () => {
  const html = renderBackup();
  assert.match(html, /<input type="file" id="backup-file" accept="\.json,application\/json"[^>]*data-import-file>/);
  assert.match(html, /<label for="backup-file">/);
  assert.ok(html.includes(IMPORT_LABEL));
  assert.match(html, /role="status" data-import-status hidden/);
});

test('addedMessage states the added and skipped counts', () => {
  assert.equal(addedMessage({ added: 2, skipped: 0 }), '2 added, 0 skipped');
  assert.equal(addedMessage({ added: 0, skipped: 2 }), '0 added, 2 skipped');
});

test('choosing a backup adds its entries, says how many, and the Today and Month totals include them', async () => {
  assert.deepEqual(await totals(), { today: '₹0', month: '₹0', monthScreen: '₹0' });

  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  const status = await choose(screen, mounted, fileOf(backupText()));

  assert.equal(status.textContent, '2 added, 0 skipped');
  assert.equal(status.getAttribute('hidden'), null);
  assert.equal(status.classList.contains('hint-error'), false);
  assert.equal(storedRecords().length, 2);
  assert.equal(screen.part('[data-import-file]').value, '', 'the picker is cleared for the next file');
  assert.equal(screen.part('[data-import-file]').disabled, false);

  assert.deepEqual(await totals(), { today: formatPaise(16550), month: formatPaise(16550), monthScreen: formatPaise(16550) });
});

test('choosing the same backup again shows 0 added and the totals do not change', async () => {
  const text = backupText();
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  await choose(screen, mounted, fileOf(text));
  const before = await totals();

  const status = await choose(screen, mounted, fileOf(text));
  assert.equal(status.textContent, '0 added, 2 skipped');
  assert.match(status.textContent, /^0 added/);
  assert.equal(storedRecords().length, 2);
  assert.deepEqual(await totals(), before);
});

test('a file that is not a backup shows parseBackup’s message and leaves the store unchanged', async () => {
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  await choose(screen, mounted, fileOf(backupText()));
  const before = storedRecords();

  for (const text of ['not json at all', JSON.stringify({ format: 'something-else', version: 1, entries: [] }),
    JSON.stringify({ format: BACKUP_FORMAT, version: 1, entries: [{ amount: -5, createdAt: '2026-09-01T10:00:00Z' }] })]) {
    let expected;
    try {
      parseBackup(text);
    } catch (error) {
      expected = error.message;
    }
    assert.ok(expected, 'the sample is refused by parseBackup');
    const status = await choose(screen, mounted, fileOf(text));
    assert.equal(status.textContent, expected);
    assert.equal(status.classList.contains('hint-error'), true);
    assert.equal(status.getAttribute('role'), 'alert');
    assert.deepEqual(storedRecords(), before, 'nothing was written');
  }
});

test('a result that arrives after the route changed writes nothing', async () => {
  let current = true;
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen, isCurrent: () => current });
  const input = screen.part('[data-import-file]');
  input.files = [fileOf(backupText())];
  input.dispatch('change', { target: input });
  current = false;
  await mounted.importing();
  assert.equal(screen.part('[data-import-status]').textContent, 'Importing your backup');
});

test('readFileText falls back to FileReader when File.text() is missing', async () => {
  const original = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsText(file) {
      this.result = file.contents;
      setTimeout(() => this.onload());
    }
  };
  try {
    assert.equal(await readFileText({ contents: '{"a":1}' }), '{"a":1}');
  } finally {
    globalThis.FileReader = original;
  }
});

test('the Backup screen reads files on the phone and never uses the network', async () => {
  const source = await readFile(new URL('./backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
  assert.match(source, /parseBackup/);
  assert.match(source, /importEntries/);
});

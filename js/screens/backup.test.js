// The Backup screen against a fake IndexedDB: choosing a backup file
// previews what it would add and writes nothing until Import is tapped;
// Import adds its entries and says how many, Cancel adds none, choosing it
// again adds none and leaves the Today and Month totals as they were, and a
// file that is not a backup shows parseBackup's message and writes nothing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { addedMessage, CANCELLED, IMPORT_LABEL, mountBackup, previewMessage, readFileText, renderBackup } from './backup.js';
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

const waiting = (screen) => screen.part('[data-import-confirm]').getAttribute('hidden') === null;

/* Chooses `file` on the Backup screen and waits for its preview; then, with
   `confirm` (the default), taps Import when it is offered and waits for the
   import to settle. */
async function choose(screen, mounted, file, { confirm = true } = {}) {
  const input = screen.part('[data-import-file]');
  input.files = [file];
  input.value = 'C:\\fakepath\\' + file.name;
  input.dispatch('change', { target: input });
  await mounted.importing();
  if (confirm && waiting(screen)) {
    screen.part('[data-import-accept]').dispatch('click');
    await mounted.importing();
  }
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
  assert.match(html, /<div class="backup-confirm" data-import-confirm hidden><div class="button-row">/);
  assert.match(html, /<button type="button" data-import-accept>Import<\/button>/);
  assert.match(html, /<button type="button" class="button-secondary" data-import-cancel>Cancel<\/button>/);
});

test('the Import and Cancel buttons are styled controls at least 44px tall, hidden until a preview waits', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  assert.match(css, /\nbutton \{[^}]*appearance: none;[^}]*min-height: var\(--control-min-height\);/);
  assert.match(tokens, /--control-min-height: var\(--space-7\);/);
  assert.match(tokens, /--space-7: 48px;/);
  assert.match(css, /\.backup-confirm\[hidden\] \{\s*display: none;/);
});

test('previewMessage gives the count, the dates spanned and what is new', () => {
  const on = (day) => ({ createdAt: new Date(2026, 8, day, 9).getTime() });
  // 'Sep' or 'Sept', as the phone's own en-IN dates have it.
  const date = (day) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(2026, 8, day, 9));
  assert.match(date(12), /^12 Sept? 2026$/);
  assert.equal(
    previewMessage({ added: 3, skipped: 1 }, [on(30), on(12), on(30), on(14)]),
    `4 spends from ${date(12)} to ${date(30)}: 3 to add, 1 already on this phone.`,
  );
  assert.equal(previewMessage({ added: 1, skipped: 0 }, [on(30)]), `1 spend on ${date(30)}: 1 to add, 0 already on this phone.`);
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

  assert.equal(waiting(screen), false, 'the Import button goes once it is tapped');
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
  assert.equal(waiting(screen), false, 'nothing new, so nothing to confirm');
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
  assert.equal(screen.part('[data-import-status]').textContent, 'Reading your backup');
  assert.equal(waiting(screen), false);
  assert.equal(storedRecords().length, 0);
});

test('choosing a backup previews it and writes nothing until Import is tapped', async () => {
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  const text = backupText();
  const status = await choose(screen, mounted, fileOf(text), { confirm: false });

  assert.equal(status.textContent, previewMessage({ added: 2, skipped: 0 }, parseBackup(text).entries));
  assert.match(status.textContent, /^2 spends on .*: 2 to add, 0 already on this phone\.$/);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(waiting(screen), true);
  assert.equal(screen.part('[data-import-accept]').textContent, 'Import 2 spends');
  assert.equal(storedRecords().length, 0, 'a preview writes nothing');

  screen.part('[data-import-accept]').dispatch('click');
  await mounted.importing();
  assert.equal(status.textContent, '2 added, 0 skipped');
  assert.equal(storedRecords().length, 2);
});

test('Cancel after a preview writes nothing and says so', async () => {
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  const status = await choose(screen, mounted, fileOf(backupText()), { confirm: false });
  assert.equal(waiting(screen), true);

  screen.part('[data-import-cancel]').dispatch('click');
  await mounted.importing();
  assert.equal(status.textContent, CANCELLED);
  assert.equal(waiting(screen), false);
  assert.equal(storedRecords().length, 0);

  // A late tap on the hidden Import button does nothing either.
  screen.part('[data-import-accept]').dispatch('click');
  await mounted.importing();
  assert.equal(storedRecords().length, 0);
});

test('a file as Export backup writes it (stored records, amounts in paise) restores, then re-imports 0', async () => {
  const now = new Date();
  const earlier = (minutes) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minutes).getTime();
  const text = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    entries: [
      { id: 1, schemaVersion: 1, amountPaise: 12000, note: 'chai', category: 'Food', createdAt: earlier(0) },
      { id: 2, schemaVersion: 1, amountPaise: 4550, note: 'auto', category: 'Transport', createdAt: earlier(1) },
    ],
  });
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  assert.equal((await choose(screen, mounted, fileOf(text))).textContent, '2 added, 0 skipped');
  assert.deepEqual(await totals(), { today: formatPaise(16550), month: formatPaise(16550), monthScreen: formatPaise(16550) });

  const again = await choose(screen, mounted, fileOf(text), { confirm: false });
  assert.equal(again.textContent, '0 added, 2 skipped');
  assert.equal(waiting(screen), false);
  assert.equal(storedRecords().length, 2);
});

test('an entry with no amount is refused with a message that names the fields', async () => {
  const screen = fakeMain();
  const mounted = mountBackup({ main: screen });
  const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, entries: [{ note: 'chai', createdAt: 1 }] });
  const status = await choose(screen, mounted, fileOf(text));
  assert.equal(status.textContent, 'Backup entry 1 has no amount: expected amountPaise (in paise) or amount (in rupees).');
  assert.equal(status.classList.contains('hint-error'), true);
  assert.equal(storedRecords().length, 0);
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
  assert.match(source, /previewImport/);
});

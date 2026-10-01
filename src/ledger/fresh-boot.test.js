// A newly installed phone: an empty IndexedDB boots to an empty ledger, the
// Today and Month screens both show ₹0, the first spend is written to the
// store before the screen says "Added", and booting again on the same store
// returns it. Nothing on the runtime path reads sample data or the network.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { initLedger } from './boot.js';
import { closeLedger } from './store.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from './fake-indexeddb.js';
import { add } from '../ledger.js';
import { mountToday } from '../../js/screens/today.js';
import { mountMonth } from '../../js/screens/month.js';

const ROOT = new URL('../../', import.meta.url);

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
      offsetWidth: 0,
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
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

const shown = (html, key) => new RegExp('data-' + key + '-total>([^<]*)<').exec(html)?.[1];

test('a fresh, empty IndexedDB boots to a ledger with zero entries', async () => {
  const { entries } = await initLedger({ persistTimeoutMs: 10 });
  assert.deepEqual(entries, []);
  assert.deepEqual(storedRecords(), [], 'booting writes nothing, so no seed data');
});

test('after an empty boot the Today and Month screens both show ₹0', async () => {
  await initLedger({ persistTimeoutMs: 10 });

  const today = fakeMain();
  await mountToday({ main: today });
  const todayView = today.part('[data-today-view]').innerHTML;
  assert.equal(shown(todayView, 'today'), '₹0');
  assert.equal(shown(todayView, 'month'), '₹0');
  assert.match(todayView, /today-empty/);
  assert.doesNotMatch(todayView, /entry-list/, 'no sample entries');

  const month = fakeMain();
  await mountMonth({ main: month });
  assert.equal(shown(month.part('[data-month-view]').innerHTML, 'month'), '₹0');
  assert.deepEqual(storedRecords(), []);
});

test('the first spend is in the store before the Today screen says Added, and a re-boot returns it', async () => {
  await initLedger({ persistTimeoutMs: 10 });
  const screen = fakeMain();
  await mountToday({ main: screen });
  const status = screen.part('[data-entry-status]');
  const view = screen.part('[data-today-view]');

  let release;
  fake.commitGate = new Promise((resolve) => {
    release = resolve;
  });
  screen.part('#quick-entry').value = '120 chai';
  screen.part('[data-today-form]').dispatch('submit', { preventDefault() {} });

  await settle();
  assert.deepEqual(storedRecords(), [], 'the commit is still held');
  assert.doesNotMatch(status.textContent, /Added/, 'nothing confirms a spend the store does not hold');
  assert.match(view.innerHTML, /<li aria-busy="true"/, 'the row is marked as saving');

  release();
  await settle();
  assert.equal(storedRecords().length, 1, 'written once the gate opens');
  assert.equal(status.textContent, 'Added ₹120 chai');
  assert.doesNotMatch(view.innerHTML, /aria-busy="true"><span/);

  await closeLedger();
  const { entries } = await initLedger({ persistTimeoutMs: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountPaise, 12000);
  assert.equal(entries[0].note, 'chai');
});

test('add() itself only resolves once the write has committed', async () => {
  await initLedger({ persistTimeoutMs: 10 });
  let release;
  fake.commitGate = new Promise((resolve) => {
    release = resolve;
  });
  let resolved = false;
  const saving = add({ amountPaise: 4550, note: 'auto', createdAt: Date.now() }).then(() => {
    resolved = true;
  });
  await settle();
  assert.equal(resolved, false);
  release();
  await saving;
  assert.equal(storedRecords().length, 1);
});

/* Every .js file under `dir` that is not a test, relative to the repo root. */
async function runtimeFiles(dir) {
  const found = [];
  for (const item of await readdir(new URL(dir, ROOT), { withFileTypes: true })) {
    const path = dir + item.name;
    if (item.isDirectory()) found.push(...(await runtimeFiles(path + '/')));
    else if (item.name.endsWith('.js') && !item.name.endsWith('.test.js')) found.push(path);
  }
  return found;
}

test('no runtime file reads sample data or sends anything over the network', async () => {
  const files = [...(await runtimeFiles('js/')), ...(await runtimeFiles('src/'))];
  assert.ok(files.includes('js/app.js') && files.includes('src/ledger/store.js'));
  assert.ok(!files.includes('js/data/stub.js'), 'the stub module is gone');
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /data\/stub|\.\/stub\.js/, file);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/, file);
  }
  const html = await readFile(new URL('index.html', ROOT), 'utf8');
  assert.doesNotMatch(html, /stub/);
  const worker = await readFile(new URL('sw.js', ROOT), 'utf8');
  assert.doesNotMatch(worker, /stub/, 'the service worker does not precache the stub');
});

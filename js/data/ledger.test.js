import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { fromRecord, isDemo, ledgerFor, loadEntries } from './ledger.js';
import { mountToday } from '../screens/today.js';
import { add, closeLedger } from '../../src/ledger.js';
import { addEntry } from '../../src/ledger/store.js';
import { totals } from '../../src/totals.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from '../../src/ledger/fake-indexeddb.js';

const query = (text) => new URLSearchParams(text);

/* The fake ledger answers on timers, so wait a few of them out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let fake;

beforeEach(async () => {
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

const storedRecords = () => [...fake.databases.get('rupee-ledger').stores.get('entries').records.values()];

/* Just enough of the rendered Today screen for mountToday. */
function fakeScreen() {
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
  const parts = {};
  for (const selector of ['.today', '[data-today-view]', '[data-today-form]', '#quick-entry', '#quick-entry-hint', '[data-entry-status]']) {
    parts[selector] = element();
  }
  const screen = {
    main: { querySelector: (selector) => parts[selector] ?? null },
    view: parts['[data-today-view]'],
    input: parts['#quick-entry'],
    type(text) {
      parts['#quick-entry'].value = text;
      parts['[data-today-form]'].dispatch('submit', { preventDefault() {} });
    },
  };
  return screen;
}

const shown = (html, key) => (html.match(new RegExp('data-' + key + '-total[^>]*>([^<]*)<')) ?? [])[1];

test('a stored record reads as paise and a timestamp the totals understand', () => {
  const at = new Date(2026, 8, 30, 9, 0).getTime();
  const entry = fromRecord({ id: 7, schemaVersion: 1, amountPaise: 12000, note: 'chai', createdAt: at });
  assert.deepEqual(entry, { id: 7, amountPaise: 12000, note: 'chai', timestamp: at });
  assert.deepEqual(totals([entry], new Date(at)), { today: 12000, month: 12000 });
});

test('the quick-entry box writes through the versioned ledger add, and loadEntries reads it back', async () => {
  const at = new Date(2026, 8, 30, 9, 0).getTime();
  const ledger = ledgerFor(query(''));
  assert.equal(ledger.add, add, 'no wrapper between the box and src/ledger.js');
  const saved = await ledger.add({ amountPaise: 4550, note: 'auto', createdAt: at });
  assert.deepEqual(fromRecord(saved), { id: 1, amountPaise: 4550, note: 'auto', timestamp: at });
  assert.deepEqual(storedRecords(), [{ id: 1, schemaVersion: 1, amountPaise: 4550, note: 'auto', createdAt: at }]);

  await ledger.add({ amountPaise: 12000, note: 'chai', createdAt: at + 1 });
  const loaded = await loadEntries(query(''), { now: new Date(at) });
  assert.deepEqual(loaded.map((entry) => [entry.id, entry.amountPaise]), [[2, 12000], [1, 4550]], 'newest first');
});

test('loadEntries reads only the current month', async () => {
  await add({ amountPaise: 100, note: 'last of August', createdAt: new Date(2026, 7, 31, 23).getTime() });
  await add({ amountPaise: 200, note: 'September', createdAt: new Date(2026, 8, 2, 9).getTime() });
  const loaded = await loadEntries(query(''), { now: new Date(2026, 8, 30, 12) });
  assert.deepEqual(loaded.map((entry) => entry.note), ['September']);
});

test('a record with an unknown or missing schema version makes the load report it', async () => {
  await add({ amountPaise: 12000, note: 'chai' });
  await addEntry({ amount: 80, note: 'unversioned' });
  await assert.rejects(loadEntries(query('')), { name: 'UnknownSchemaVersionError' });

  const screen = fakeScreen();
  await mountToday({ main: screen.main, query: query('') });
  assert.match(screen.view.innerHTML, /today-error/);
  assert.equal(shown(screen.view.innerHTML, 'today'), '—', 'no misread sum');
});

test('a state query goes to the stub and stores nothing', async () => {
  assert.equal(isDemo(query('state=filled')), true);
  assert.equal(isDemo(query('state=nope')), false);
  assert.equal(isDemo(query('')), false);
  const fail = async () => { throw new Error('the ledger should not be touched'); };
  assert.deepEqual(await loadEntries(query('state=empty'), { list: fail }), []);
  assert.equal((await loadEntries(query('state=filled'), { list: fail })).length, 4);
  assert.equal(await ledgerFor(query('state=filled')).add({ amountPaise: 100, note: '', createdAt: 1 }), null);
  assert.equal(fake.transactions.length, 0);
});

test('end to end: from an empty ledger, 120 chai then 80 auto shows ₹200 and ₹200, and reloads as ₹200', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, query: query('') });
  assert.equal(shown(screen.view.innerHTML, 'today'), '₹0');
  assert.equal(shown(screen.view.innerHTML, 'month'), '₹0');

  screen.type('120 chai');
  assert.equal(shown(screen.view.innerHTML, 'today'), '₹120');
  assert.equal(shown(screen.view.innerHTML, 'month'), '₹120');
  screen.type('80 auto');
  assert.equal(shown(screen.view.innerHTML, 'today'), '₹200');
  assert.equal(shown(screen.view.innerHTML, 'month'), '₹200');
  assert.equal(screen.input.value, '');

  await settle();
  assert.deepEqual(storedRecords().map((record) => [record.schemaVersion, record.amountPaise, record.note]),
    [[1, 12000, 'chai'], [1, 8000, 'auto']]);
  assert.equal(shown(screen.view.innerHTML, 'today'), '₹200');

  await closeLedger();
  const reopened = fakeScreen();
  await mountToday({ main: reopened.main, query: query('') });
  assert.equal(shown(reopened.view.innerHTML, 'today'), '₹200');
  assert.equal(shown(reopened.view.innerHTML, 'month'), '₹200');
  assert.match(reopened.view.innerHTML, /2 spends/);
});

test('without IndexedDB the load and the save reject, so the screen can say so', async () => {
  await closeLedger();
  globalThis.indexedDB = undefined;
  await assert.rejects(loadEntries(query('')));
  await assert.rejects(ledgerFor(query('')).add({ amountPaise: 100, note: '', createdAt: 1 }));
});

test('the module is offline and shows no currency but ₹', async () => {
  const source = await readFile(new URL('./ledger.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:|fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(source, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
});

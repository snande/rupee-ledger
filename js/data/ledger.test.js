import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { categoryOf, fromRecord, isDemo, ledgerFor, loadAllEntries, loadEntries, loadMonthEntries } from './ledger.js';
import { mountToday } from '../screens/today.js';
import { add, closeLedger, UnknownSchemaVersionError } from '../../src/ledger.js';
import { addEntry, updateCategory } from '../../src/ledger/store.js';
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
  assert.deepEqual(entry, { id: 7, amountPaise: 12000, note: 'chai', category: 'Food', timestamp: at });
  assert.equal(fromRecord({ id: 8, amountPaise: 100, note: 'chai', category: 'Bills', createdAt: at }).category, 'Bills');
  assert.deepEqual(totals([entry], new Date(at)), { today: 12000, month: 12000 });
});

test('the quick-entry box writes through the versioned ledger add, and loadEntries reads it back', async () => {
  const at = new Date(2026, 8, 30, 9, 0).getTime();
  const ledger = ledgerFor(query(''));
  assert.equal(ledger.add, add, 'no wrapper between the box and src/ledger.js');
  const saved = await ledger.add({ amountPaise: 4550, note: 'auto', createdAt: at });
  assert.deepEqual(fromRecord(saved), { id: 1, amountPaise: 4550, note: 'auto', category: 'Transport', timestamp: at });
  assert.deepEqual(storedRecords(), [
    { id: 1, schemaVersion: 1, amountPaise: 4550, note: 'auto', category: 'Transport', createdAt: at },
  ]);

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

test('loadMonthEntries reads one chosen month from the on-device ledger', async () => {
  await add({ amountPaise: 100, note: 'chai', createdAt: new Date(2026, 6, 31, 23).getTime() });
  await add({ amountPaise: 200, note: 'auto', createdAt: new Date(2026, 7, 1, 0).getTime() });
  await add({ amountPaise: 300, note: 'rent', createdAt: new Date(2026, 7, 31, 23).getTime() });
  await add({ amountPaise: 400, note: 'chai', createdAt: new Date(2026, 8, 1, 0).getTime() });
  const august = await loadMonthEntries('2026-08');
  assert.deepEqual(august.map((entry) => [entry.amountPaise, entry.note]), [[200, 'auto'], [300, 'rent']]);
  assert.deepEqual(Object.keys(august[0]).sort(), ['amountPaise', 'category', 'id', 'note', 'timestamp']);
  assert.equal(august[0].timestamp, new Date(2026, 7, 1, 0).getTime());
});

test('loadMonthEntries passes a blank category on, so it counts as Uncategorised', async () => {
  const at = new Date(2026, 8, 3).getTime();
  const asked = [];
  const list = async (date) => {
    asked.push(date);
    return [{ id: 1, schemaVersion: 1, amountPaise: 500, note: 'chai', category: '', createdAt: at }];
  };
  const [entry] = await loadMonthEntries('2026-09', { list });
  assert.equal(entry.category, '');
  assert.equal(asked[0].getFullYear(), 2026);
  assert.equal(asked[0].getMonth(), 8);
});

test('loadMonthEntries refuses a malformed month and reports an unknown schema version', async () => {
  for (const bad of ['2026-13', '2026-00', '2026-9', 'September', null]) {
    await assert.rejects(loadMonthEntries(bad), TypeError, String(bad));
  }
  await addEntry({ amount: 80, note: 'unversioned', createdAt: new Date(2026, 8, 2).getTime() });
  await assert.rejects(loadMonthEntries('2026-09'), { name: 'UnknownSchemaVersionError' });
});

test('a state query goes to the stub and stores nothing', async () => {
  assert.equal(isDemo(query('state=filled')), true);
  assert.equal(isDemo(query('state=nope')), false);
  assert.equal(isDemo(query('')), false);
  const fail = async () => { throw new Error('the ledger should not be touched'); };
  assert.deepEqual(await loadEntries(query('state=empty'), { list: fail }), []);
  assert.equal((await loadEntries(query('state=filled'), { list: fail })).length, 4);
  assert.equal(await ledgerFor(query('state=filled')).add({ amountPaise: 100, note: '', createdAt: 1 }), null);
  assert.equal(await ledgerFor(query('state=filled')).updateCategory('sample-1', 'Bills'), null);
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

test('end to end: Enter on 120 chai and 50 auto stores Food and Transport in one strict write each', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, query: query('') });
  const before = fake.transactions.length;

  screen.type('120 chai');
  screen.type('50 auto');
  await settle();

  assert.deepEqual(storedRecords().map(({ amountPaise, note, category }) => [amountPaise, note, category]),
    [[12000, 'chai', 'Food'], [5000, 'auto', 'Transport']]);
  const saves = fake.transactions.slice(before).filter((tx) => tx.mode === 'readwrite');
  assert.equal(saves.length, 2, 'one write per Enter, none afterwards for the category');
  for (const tx of saves) {
    assert.deepEqual(tx.requests.map((request) => request.kind), ['add']);
    assert.deepEqual(tx.options, { durability: 'strict' });
  }
});

test('today and month totals are the same whether entries carry a category or predate it', async () => {
  const at = new Date(2026, 8, 30, 9, 0).getTime();
  const lines = [[12000, 'chai', at], [8000, 'auto', at + 1], [4550, 'rent', new Date(2026, 8, 2, 9).getTime()]];
  const reloadedTotals = async () => {
    await closeLedger();
    const loaded = await loadEntries(query(''), { now: new Date(at) });
    return totals(loaded, new Date(at));
  };

  for (const [amountPaise, note, createdAt] of lines) await add({ amountPaise, note, createdAt });
  const categorised = await reloadedTotals();

  // The same entries again, as a build from before categories stored them.
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  for (const [amountPaise, note, createdAt] of lines) {
    await add({ amountPaise, note, createdAt });
    delete storedRecords().at(-1).category;
  }
  assert.ok(storedRecords().every((record) => !('category' in record)));
  const legacy = await reloadedTotals();

  assert.deepEqual(categorised, { today: 20000, month: 24550 });
  assert.deepEqual(legacy, categorised);
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

test('one rule reads an entry\'s category: the one it carries if known, else its note\'s', () => {
  assert.equal(categoryOf({ note: 'chai', category: 'Bills' }), 'Bills');
  assert.equal(categoryOf({ note: 'chai' }), 'Food');
  assert.equal(categoryOf({ note: 'chai', category: '' }), 'Food', 'a free-form blank from addEntry');
  assert.equal(categoryOf({ note: 'chai', category: 'Snacks' }), 'Food');
  assert.equal(categoryOf({}), 'Other');
  assert.equal(fromRecord({ id: 1, amountPaise: 100, note: 'auto', category: '', createdAt: 1 }).category, 'Transport');
});

test('the Today screen changes a category through the store update', () => {
  assert.equal(ledgerFor(query('')).updateCategory, updateCategory);
});

test('end to end: tapping a chip then a category stores it, and a reload shows it', async () => {
  await add({ amountPaise: 12000, note: 'chai' });
  const screen = fakeScreen();
  await mountToday({ main: screen.main, query: query('') });
  assert.match(screen.view.innerHTML, /data-entry-id="1" aria-haspopup="listbox" aria-expanded="false" aria-label="Category: Food\. Change category">Food</);

  const tap = (attrs, inPicker) => screen.view.dispatch('click', {
    target: { closest: (selector) => (selector === '[data-action]' ? { getAttribute: (name) => attrs[name] ?? null } : inPicker ? {} : null) },
  });
  tap({ 'data-action': 'open-category', 'data-entry-id': '1' });
  assert.match(screen.view.innerHTML, /role="listbox"/);
  const before = fake.transactions.length;
  tap({ 'data-action': 'pick-category', 'data-entry-id': '1', 'data-category': 'Health' }, true);
  assert.doesNotMatch(screen.view.innerHTML, /role="listbox"/);
  assert.match(screen.view.innerHTML, /aria-label="Category: Health\. Change category">Health</);

  await settle();
  const writes = fake.transactions.slice(before).filter((tx) => tx.mode === 'readwrite');
  assert.equal(writes.length, 1, 'one write, no Save step');
  assert.deepEqual(writes[0].options, { durability: 'strict' });
  assert.deepEqual(storedRecords().map(({ id, note, category, amountPaise }) => [id, note, category, amountPaise]),
    [[1, 'chai', 'Health', 12000]]);

  await closeLedger();
  const reopened = fakeScreen();
  await mountToday({ main: reopened.main, query: query('') });
  assert.match(reopened.view.innerHTML, /aria-label="Category: Health\. Change category">Health</);
});

test('loadAllEntries reads every month from the on-device store, amounts in paise', async () => {
  await add({ amountPaise: 2000, note: 'chai', createdAt: new Date(2026, 6, 3, 9).getTime() });
  await add({ amountPaise: 50000, note: 'rent', createdAt: new Date(2026, 7, 1, 9).getTime() });
  await addEntry({ amount: 15, note: 'masala chai', createdAt: new Date(2026, 8, 2, 9).getTime() });

  const entries = await loadAllEntries();
  assert.deepEqual(entries.map(({ note, amountPaise }) => ({ note, amountPaise })), [
    { note: 'chai', amountPaise: 2000 },
    { note: 'rent', amountPaise: 50000 },
    { note: 'masala chai', amountPaise: 1500 },
  ]);
  assert.equal(entries[0].timestamp, new Date(2026, 6, 3, 9).getTime());
});

test('loadAllEntries maps whatever list resolves and passes its rejection on', async () => {
  const entries = await loadAllEntries({
    list: async () => [
      { id: 4, schemaVersion: 1, amountPaise: 300, note: 'pen', category: 'Shopping', createdAt: 7 },
      { id: 5, amount: 1200, note: 'chai', category: 'Food', createdAt: 8 },
    ],
  });
  assert.deepEqual(entries, [
    { id: 4, amountPaise: 300, note: 'pen', category: 'Shopping', timestamp: 7 },
    { id: 5, amountPaise: 1200, note: 'chai', category: 'Food', timestamp: 8 },
  ]);
  await assert.rejects(loadAllEntries({ list: async () => { throw new Error('no ledger'); } }), /no ledger/);
});

test('loadAllEntries rejects a record with an unknown schemaVersion rather than misreading it', async () => {
  const list = async () => [
    { id: 1, schemaVersion: 1, amountPaise: 300, note: 'pen', createdAt: 7 },
    { id: 2, schemaVersion: 2, amountPaise: 400, note: 'chai', createdAt: 8 },
  ];
  await assert.rejects(loadAllEntries({ list }), (error) => {
    assert.ok(error instanceof UnknownSchemaVersionError);
    assert.deepEqual(error.records, [{ id: 2, schemaVersion: 2 }]);
    return true;
  });
});

test('loadAllEntries rejects a record with no whole-paise amount rather than totalling NaN', async () => {
  for (const bad of [{}, { amountPaise: 12.5 }, { amount: '1200' }, { amountPaise: null, amount: undefined }]) {
    const list = async () => [{ id: 9, note: 'chai', createdAt: 7, ...bad }];
    await assert.rejects(loadAllEntries({ list }), TypeError, JSON.stringify(bad));
  }
});

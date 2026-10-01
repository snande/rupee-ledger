import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  dateLabel,
  ERROR_MESSAGE,
  matchCount,
  mountSearch,
  NO_MATCHES,
  renderSearch,
  renderSearchView,
  TOTAL_LABEL,
} from './search.js';
import { formatPaise } from '../../src/format-amount.js';

const at = (month, day) => new Date(2026, month - 1, day, 10).getTime();

/* Chai in three different months, among other spends. */
const ENTRIES = [
  { id: 1, amountPaise: 2000, note: 'chai', category: 'Food', timestamp: at(7, 3) },
  { id: 2, amountPaise: 50000, note: 'rent', category: 'Bills', timestamp: at(8, 1) },
  { id: 3, amountPaise: 1500, note: 'Masala Chai', category: 'Food', timestamp: at(8, 12) },
  { id: 4, amountPaise: 8000, note: 'auto', category: 'Transport', timestamp: at(9, 4) },
  { id: 5, amountPaise: 2500, note: 'chai & biscuit', category: 'Food', timestamp: at(9, 20) },
];

const CHAI_NOTES = ['chai &amp; biscuit', 'Masala Chai', 'chai'];

const tick = () => new Promise((resolve) => setImmediate(resolve));

const notes = (html) => [...html.matchAll(/<span class="entry-note">([^<]*)<\/span>/g)].map((m) => m[1]);
const totalOf = (html) => html.match(/<span class="amount total-amount" data-search-total>([^<]*)<\/span>/)?.[1];

/* Just enough of the rendered screen for mountSearch. */
function fakeScreen(value = '') {
  const element = (initial = '') => {
    const attrs = new Map();
    const listeners = new Map();
    return {
      innerHTML: '',
      textContent: '',
      value: initial,
      focusCount: 0,
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, v) => attrs.set(name, String(v)),
      addEventListener: (type, fn) => listeners.set(type, fn),
      dispatch: (type, event = {}) => listeners.get(type)?.(event),
      focus() {
        this.focusCount += 1;
      },
    };
  };
  const parts = {
    '.search': element(),
    '[data-search-view]': element(),
    '[data-search-input]': element(value),
    '[data-search-form]': element(),
    '[data-search-status]': element(),
  };
  return {
    main: { querySelector: (selector) => parts[selector] ?? null },
    root: parts['.search'],
    view: parts['[data-search-view]'],
    input: parts['[data-search-input]'],
    form: parts['[data-search-form]'],
    status: parts['[data-search-status]'],
    type(text) {
      this.input.value = text;
      return this.input.dispatch('input', { target: this.input });
    },
  };
}

/* A load that resolves ENTRIES and counts its calls. */
function loader(entries = ENTRIES) {
  const calls = { count: 0 };
  const load = async () => {
    calls.count += 1;
    return entries;
  };
  return { calls, load };
}

test('the screen renders a labelled search field and a results area', () => {
  const html = renderSearch();
  assert.match(html, /<div class="search" data-status="loading">/);
  assert.match(html, /<label for="search-query">Search spends<\/label><input type="search" id="search-query" name="query"[^>]* data-search-input>/);
  assert.match(html, /<div class="search-view" data-search-view>/);
  assert.match(html, /Type part of a note/, 'an empty field shows the hint');
});

test('a query lists every match from every month with date, note and ₹ amount, newest first', () => {
  const html = renderSearchView({ status: 'filled', entries: ENTRIES, query: 'chai' });
  assert.match(html, /<ul class="entry-list search-results" data-search-results>/);
  assert.deepEqual(notes(html), CHAI_NOTES);
  for (const paise of [2500, 1500, 2000]) {
    assert.ok(html.includes('<span class="amount entry-amount">' + formatPaise(paise) + '</span>'), formatPaise(paise));
  }
  for (const [month, day] of [[9, 20], [8, 12], [7, 3]]) {
    const iso = '2026-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    assert.ok(html.includes('<time class="search-date" datetime="' + iso + '">' + dateLabel(at(month, day)) + '</time>'), iso);
  }
  assert.doesNotMatch(html, /rent|auto/);
});

test('the total of the matches is shown in ₹ and labelled as such', () => {
  const html = renderSearchView({ status: 'filled', entries: ENTRIES, query: 'chai' });
  assert.equal(totalOf(html), formatPaise(6000));
  assert.ok(html.includes(TOTAL_LABEL), 'labelled as the total of the matches');
  assert.match(TOTAL_LABEL, /total of matches/i);
  assert.match(html, /\(3 matches\)/);
});

test('matchCount says 1 match or N matches', () => {
  assert.equal(matchCount(0), '0 matches');
  assert.equal(matchCount(1), '1 match');
  assert.equal(matchCount(3), '3 matches');
});

test('a non-empty query with no match says so and totals ₹0', () => {
  const html = renderSearchView({ status: 'filled', entries: ENTRIES, query: 'samosa' });
  assert.match(NO_MATCHES, /no matching entries/i);
  assert.match(html, /data-search-none>No matching entries for “samosa”\.<\/p>/);
  assert.equal(totalOf(html), formatPaise(0));
  assert.doesNotMatch(html, /data-search-results/);
});

test('leading and trailing spaces are ignored, so " chai " finds the chai spends', () => {
  const html = renderSearchView({ status: 'filled', entries: ENTRIES, query: '  chai ' });
  assert.deepEqual(notes(html), CHAI_NOTES);
  assert.equal(totalOf(html), formatPaise(6000));
  assert.match(renderSearchView({ status: 'filled', entries: ENTRIES, query: '   ' }), /Type part of a note/);
});

test('notes are escaped, never markup', () => {
  const entries = [{ id: 1, amountPaise: 100, note: 'chai <b>hot</b>', timestamp: at(9, 1) }];
  const html = renderSearchView({ status: 'filled', entries, query: '<b>' });
  assert.ok(html.includes('chai &lt;b&gt;hot&lt;/b&gt;'));
  assert.doesNotMatch(html, /<b>hot/);
});

test('typing chai loads every entry and lists the chai spends with their ₹ total', async () => {
  const screen = fakeScreen();
  const { calls, load } = loader();
  await mountSearch({ main: screen.main, load });
  assert.equal(screen.input.focusCount, 1, 'focus goes to the field');
  assert.equal(calls.count, 0, 'an empty field needs no load');
  assert.match(screen.view.innerHTML, /Type part of a note/);

  await screen.type('chai');
  await tick();
  assert.equal(calls.count, 1);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.deepEqual(notes(screen.view.innerHTML), CHAI_NOTES);
  assert.equal(totalOf(screen.view.innerHTML), formatPaise(6000));
  assert.equal(screen.status.textContent, '3 matches, ' + formatPaise(6000) + ' in all');

  await screen.type('samosa');
  await tick();
  assert.equal(calls.count, 2, 'each input loads the entries again');
  assert.match(screen.view.innerHTML, /No matching entries/);
  assert.equal(totalOf(screen.view.innerHTML), formatPaise(0));
  assert.equal(screen.status.textContent, NO_MATCHES);
});

test('clearing the field shows the hint and resets the status', async () => {
  const screen = fakeScreen();
  await mountSearch({ main: screen.main, load: loader().load });
  await screen.type('chai');
  await tick();
  assert.equal(screen.root.getAttribute('data-status'), 'filled');

  await screen.type('  ');
  assert.equal(screen.root.getAttribute('data-status'), 'loading');
  assert.match(screen.view.innerHTML, /Type part of a note/);
  assert.equal(screen.status.textContent, '');
});

test('a load overtaken by newer typing writes nothing', async () => {
  const screen = fakeScreen();
  const resolvers = [];
  const load = () => new Promise((resolve) => resolvers.push(resolve));
  mountSearch({ main: screen.main, load });
  screen.type('rent');
  screen.type('chai');
  resolvers[1](ENTRIES);
  await tick();
  resolvers[0](ENTRIES);
  await tick();
  assert.deepEqual(notes(screen.view.innerHTML), CHAI_NOTES);
});

test('nothing is written once the route has moved on', async () => {
  const screen = fakeScreen('chai');
  let current = true;
  let resolve;
  const done = mountSearch({ main: screen.main, isCurrent: () => current, load: () => new Promise((r) => { resolve = r; }) });
  const before = screen.view.innerHTML;
  current = false;
  resolve(ENTRIES);
  await done;
  assert.equal(screen.view.innerHTML, before);
});

test('a failed load shows Try again, which searches again', async () => {
  const screen = fakeScreen('chai');
  let fail = true;
  const load = async () => {
    if (fail) throw new Error('no ledger');
    return ENTRIES;
  };
  await mountSearch({ main: screen.main, load });
  assert.equal(screen.root.getAttribute('data-status'), 'error');
  assert.match(screen.view.innerHTML, /role="alert"/);
  assert.ok(screen.view.innerHTML.includes(ERROR_MESSAGE));
  assert.match(screen.view.innerHTML, /data-action="retry"/);

  fail = false;
  screen.view.dispatch('click', { target: { closest: (selector) => (selector === '[data-action="retry"]' ? {} : null) } });
  await tick();
  assert.equal(totalOf(screen.view.innerHTML), formatPaise(6000));
});

test('submitting the form searches without navigating', async () => {
  const screen = fakeScreen('auto');
  const { load } = loader();
  await mountSearch({ main: screen.main, load });
  let prevented = false;
  screen.form.dispatch('submit', { preventDefault: () => { prevented = true; } });
  await tick();
  assert.equal(prevented, true);
  assert.equal(totalOf(screen.view.innerHTML), formatPaise(8000));
});

test('the screen makes no network request', async () => {
  const source = await readFile(new URL('./search.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket/);
  assert.ok(!source.includes('$'), 'the only currency sign is ₹');
});

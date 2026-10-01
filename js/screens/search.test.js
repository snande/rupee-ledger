import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ERROR_MESSAGE,
  NO_MATCHES,
  TOTAL_LABEL,
  entryDate,
  mountSearch,
  renderSearch,
  renderSearchView,
  shownStatus,
} from './search.js';
import { formatPaise } from '../../src/format-amount.js';
import { searchEntries } from '../../src/search.js';

/* Records as listEntries() in src/ledger/store.js returns them, from three
   months: paise as amountPaise (src/ledger.js) or amount (the store). */
const jan = new Date(2026, 0, 14, 9).getTime();
const feb = new Date(2026, 1, 3, 17).getTime();
const mar = new Date(2026, 2, 21, 8).getTime();
const records = [
  { id: 1, amountPaise: 2000, note: 'Chai', category: 'Food', createdAt: jan },
  { id: 2, amountPaise: 45000, note: 'Auto <to> station', category: 'Transport', createdAt: jan },
  { id: 3, amount: 3500, note: 'chai and biscuits', category: 'Food', createdAt: feb },
  { id: 4, amountPaise: 1500, note: 'masala CHAI', category: 'Food', createdAt: mar },
  { id: 5, amountPaise: 99900, note: 'Groceries', category: 'Groceries', createdAt: mar },
];

/* Just enough of an element for the screen: attributes, events, focus. */
function fakeElement() {
  const attrs = new Map();
  const listeners = new Map();
  return {
    innerHTML: '',
    value: '',
    focusCount: 0,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
    focus() {
      this.focusCount += 1;
    },
  };
}

/* The rendered screen, as the parts mountSearch looks up in <main>. */
function fakeScreen() {
  const parts = {
    '.search': fakeElement(),
    '[data-search-form]': fakeElement(),
    '[data-search-view]': fakeElement(),
    '#search-query': fakeElement(),
  };
  return {
    main: { querySelector: (selector) => parts[selector] ?? null },
    root: parts['.search'],
    form: parts['[data-search-form]'],
    view: parts['[data-search-view]'],
    input: parts['#search-query'],
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function typeQuery(screen, text) {
  screen.input.value = text;
  screen.input.dispatch('input');
}

/* The notes listed in the rendered view, in order. */
const listedNotes = (html) => [...html.matchAll(/<span class="entry-note">([^<]*)<\/span>/g)].map((m) => m[1]);
const shownTotal = (html) => html.match(/data-search-total>([^<]*)</)?.[1];

test('the screen renders a labelled text input and a results region', () => {
  const html = renderSearch();
  assert.match(html, /<label for="search-query">Search spends<\/label>/);
  assert.match(html, /<input id="search-query"[^>]*type="search"/);
  assert.match(html, /data-search-view/);
  assert.match(html, /data-status="idle"/);
  assert.equal((html.match(/<input\b/g) ?? []).length, 1);
});

test('a blank query matches nothing and shows a prompt, with no total', () => {
  for (const query of ['', '   ']) {
    const html = renderSearchView({ status: 'done', query, entries: records });
    assert.equal(listedNotes(html).length, 0);
    assert.equal(shownTotal(html), undefined);
    assert.match(html, /chai/);
  }
});

test('chai lists the chai entries from every month, newest first, with date, note and ₹ amount', () => {
  const html = renderSearchView({ status: 'done', query: 'chai', entries: records });
  assert.deepEqual(listedNotes(html), ['masala CHAI', 'chai and biscuits', 'Chai']);
  assert.match(html, /3 matches/);
  for (const time of [jan, feb, mar]) {
    assert.ok(html.includes(entryDate({ createdAt: time })), 'no date for ' + new Date(time).toDateString());
  }
  assert.match(html, /21 Mar 2026/);
  for (const paise of [2000, 3500, 1500]) {
    assert.ok(html.includes('>' + formatPaise(paise) + '<'), formatPaise(paise) + ' is not listed');
  }
  assert.doesNotMatch(html, /Groceries|station/);
});

test('the total of the matches is shown in ₹ and labelled as such', () => {
  const html = renderSearchView({ status: 'done', query: 'chai', entries: records });
  assert.equal(TOTAL_LABEL, 'Total of matches');
  assert.match(html, new RegExp('<span class="total-label">' + TOTAL_LABEL + '</span>'));
  assert.equal(shownTotal(html), formatPaise(searchEntries(records, 'chai').total));
  assert.equal(shownTotal(html), formatPaise(7000));
  assert.match(shownTotal(html), /^₹/);
});

test('a query nothing matches says no matching entries over a ₹0 total', () => {
  const state = { status: 'done', query: 'petrol', entries: records };
  const html = renderSearchView(state);
  assert.match(html, new RegExp(NO_MATCHES));
  assert.match(NO_MATCHES, /no matching entries/i);
  assert.equal(shownTotal(html), formatPaise(0));
  assert.equal(shownTotal(html), '₹0');
  assert.equal(listedNotes(html).length, 0);
  assert.equal(shownStatus(state), 'empty');
  assert.match(renderSearch(state), /data-status="empty"/);
});

test('notes and the query are escaped', () => {
  const html = renderSearchView({ status: 'done', query: '<to>', entries: records });
  assert.deepEqual(listedNotes(html), ['Auto &lt;to&gt; station']);
  const none = renderSearchView({ status: 'done', query: '<b>', entries: records });
  assert.match(none, /&lt;b&gt;/);
  assert.doesNotMatch(none, /<b>/);
});

test('the error view shows Try again', () => {
  const html = renderSearchView({ status: 'error', query: 'chai' });
  assert.match(html, new RegExp(ERROR_MESSAGE));
  assert.match(html, /data-action="retry"/);
});

test('each change of the box reads every entry from the store and redraws the list and total', async () => {
  const screen = fakeScreen();
  let reads = 0;
  const load = async () => {
    reads += 1;
    return records;
  };
  await mountSearch({ main: screen.main, load });
  assert.equal(screen.input.focusCount, 1);
  assert.equal(reads, 0, 'a blank box reads nothing');

  typeQuery(screen, 'chai');
  await tick();
  assert.equal(reads, 1);
  assert.deepEqual(listedNotes(screen.view.innerHTML), ['masala CHAI', 'chai and biscuits', 'Chai']);
  assert.equal(shownTotal(screen.view.innerHTML), formatPaise(7000));
  assert.equal(screen.root.getAttribute('data-status'), 'done');

  typeQuery(screen, 'chai and');
  await tick();
  assert.equal(reads, 2);
  assert.deepEqual(listedNotes(screen.view.innerHTML), ['chai and biscuits']);
  assert.equal(shownTotal(screen.view.innerHTML), formatPaise(3500));

  typeQuery(screen, 'petrol');
  await tick();
  assert.match(screen.view.innerHTML, new RegExp(NO_MATCHES));
  assert.equal(shownTotal(screen.view.innerHTML), '₹0');
  assert.equal(screen.root.getAttribute('data-status'), 'empty');

  typeQuery(screen, '');
  await tick();
  assert.equal(reads, 3);
  assert.equal(shownTotal(screen.view.innerHTML), undefined);
});

test('the store is read with listEntries by default', async () => {
  const source = await readFile(new URL('./search.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ listEntries \} from '\.\.\/\.\.\/src\/ledger\/store\.js';/);
  assert.match(source, /import \{ searchEntries \} from '\.\.\/\.\.\/src\/search\.js';/);
  assert.match(source, /import \{ formatPaise \} from '\.\.\/\.\.\/src\/format-amount\.js';/);
  assert.match(source, /load = listEntries/);
});

test('a slow read for an older query never overwrites a newer one', async () => {
  const screen = fakeScreen();
  const pending = [];
  const load = () => new Promise((resolve) => pending.push(resolve));
  mountSearch({ main: screen.main, load });
  typeQuery(screen, 'chai');
  typeQuery(screen, 'groceries');
  pending[1](records);
  await tick();
  pending[0](records);
  await tick();
  assert.deepEqual(listedNotes(screen.view.innerHTML), ['Groceries']);
});

test('a read that fails shows Try again, which searches again', async () => {
  const screen = fakeScreen();
  let fail = true;
  const load = async () => {
    if (fail) throw new Error('blocked');
    return records;
  };
  mountSearch({ main: screen.main, load });
  typeQuery(screen, 'chai');
  await tick();
  assert.match(screen.view.innerHTML, /data-action="retry"/);
  assert.equal(screen.root.getAttribute('data-status'), 'error');

  fail = false;
  const button = { getAttribute: () => 'retry' };
  screen.view.dispatch('click', { target: { closest: () => button } });
  await tick();
  assert.equal(listedNotes(screen.view.innerHTML).length, 3);
});

test('Enter in the box searches and never submits the page', async () => {
  const screen = fakeScreen();
  mountSearch({ main: screen.main, load: async () => records });
  screen.input.value = 'chai';
  let prevented = false;
  screen.form.dispatch('submit', { preventDefault: () => { prevented = true; } });
  await tick();
  assert.equal(prevented, true);
  assert.equal(listedNotes(screen.view.innerHTML).length, 3);
});

test('once the router has moved on, a late read draws nothing', async () => {
  const screen = fakeScreen();
  let current = true;
  let release;
  mountSearch({ main: screen.main, isCurrent: () => current, load: () => new Promise((resolve) => { release = resolve; }) });
  const before = screen.view.innerHTML;
  typeQuery(screen, 'chai');
  current = false;
  release(records);
  await tick();
  assert.equal(screen.view.innerHTML, before);
});

test('mountSearch throws on markup without the screen, so the router shows its error', () => {
  assert.throws(() => mountSearch({ main: { querySelector: () => null } }), /Search screen markup/);
});

test('the screen makes no network request and shows no currency but ₹', async () => {
  const source = await readFile(new URL('./search.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|https?:\/\//);
  assert.doesNotMatch(code, /\bimport\s*\(/);
  for (const [, specifier] of code.matchAll(/\bfrom\s*'([^']+)'/g)) {
    assert.ok(specifier.startsWith('.'), specifier + ' is not a local module');
  }
  const html = renderSearchView({ status: 'done', query: 'chai', entries: records });
  for (const text of [source, html]) {
    assert.doesNotMatch(text, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
  }
  assert.match(html, /₹/);
});

test('every class the screen uses is styled from tokens in css/controls.css', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const html = [
    renderSearch(),
    renderSearchView({ status: 'loading', query: 'chai' }),
    renderSearchView({ status: 'error', query: 'chai' }),
    renderSearchView({ status: 'done', query: 'chai', entries: records }),
    renderSearchView({ status: 'done', query: 'petrol', entries: records }),
  ].join('');
  /* Section names used only as test and script hooks; the .card rule draws them. */
  const hooks = new Set(['search-results', 'search-empty', 'search-idle', 'search-row', 'today-loading']);
  const used = new Set(html.match(/class="([^"]+)"/g).flatMap((m) => m.slice(7, -1).split(' ')));
  for (const name of used) {
    if (hooks.has(name)) continue;
    assert.match(css, new RegExp('\\.' + name + '[\\s,{:.]'), 'no rule for .' + name);
  }
  const section = css.slice(css.indexOf('Search screen'), css.indexOf('Tab bar'));
  const body = section.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d(?:px|rem|em|pt)\b/i);
  for (const [, name] of body.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.match(tokens, new RegExp(name + ':'), name + ' is not a token');
  }
});

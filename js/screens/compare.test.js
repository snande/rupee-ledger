import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  categoryRows,
  defaultMonths,
  ERROR_MESSAGE,
  formatDifference,
  monthLabel,
  monthOptions,
  MONTH_COUNT,
  mountCompare,
  renderCompare,
  renderCompareView,
  UNCATEGORISED,
} from './compare.js';
import { formatPaise } from '../../src/format-amount.js';
import { compareMonths } from '../../src/compare-months.js';

const NOW = new Date(2026, 8, 15, 12);
const at = (month, day) => new Date(2026, month - 1, day, 10).getTime();

/* August and September 2026, plus one July spend no comparison of those
   two months may count. */
const ENTRIES = [
  { id: 1, amountPaise: 12000, note: 'chai', category: 'Food', timestamp: at(8, 3) },
  { id: 2, amountPaise: 50000, note: 'rent', category: 'Bills', timestamp: at(8, 5) },
  { id: 3, amountPaise: 2500, note: 'pen', category: '', timestamp: at(8, 9) },
  { id: 4, amountPaise: 20000, note: 'thali', category: 'Food', timestamp: at(9, 2) },
  { id: 5, amountPaise: 8000, note: 'auto', category: 'Transport', timestamp: at(9, 4) },
  { id: 6, amountPaise: 1000, note: 'misc', category: null, timestamp: at(9, 6) },
  { id: 7, amountPaise: 99900, note: 'july', category: 'Bills', timestamp: at(7, 20) },
];

const inMonth = (id) => ENTRIES.filter((entry) => {
  const date = new Date(entry.timestamp);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') === id;
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* The row for one category, or the Total row, as its four cells' text. */
function rowCells(html, hook) {
  const match = html.match(new RegExp('<tr class="compare-row[^"]*" ' + hook + '>([\\s\\S]*?)</tr>'));
  if (!match) return null;
  return [...match[1].matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map((cell) => cell[1]);
}

const categoryOrder = (html) => [...html.matchAll(/<tr class="compare-row" data-category="([^"]*)"/g)].map((m) => m[1]);

/* Just enough of the rendered screen for mountCompare. */
function fakeScreen({ first = '2026-08', second = '2026-09' } = {}) {
  const element = (value = '') => {
    const attrs = new Map();
    const listeners = new Map();
    return {
      innerHTML: '',
      textContent: '',
      value,
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
    '.compare': element(),
    '[data-compare-view]': element(),
    '[data-compare-first]': element(first),
    '[data-compare-second]': element(second),
    '[data-compare-status]': element(),
  };
  return {
    main: { querySelector: (selector) => parts[selector] ?? null },
    root: parts['.compare'],
    view: parts['[data-compare-view]'],
    first: parts['[data-compare-first]'],
    second: parts['[data-compare-second]'],
    status: parts['[data-compare-status]'],
    pick(which, month) {
      const select = which === 'first' ? this.first : this.second;
      select.value = month;
      select.dispatch('change', { target: select });
    },
  };
}

/* A load that reads ENTRIES by month and records each month asked for. */
function monthLoader() {
  const asked = [];
  const load = async (month) => {
    asked.push(month);
    return inMonth(month);
  };
  return { asked, load };
}

test('the screen offers two month pickers, opening on last month against this month', () => {
  assert.deepEqual(defaultMonths(NOW), { first: '2026-08', second: '2026-09' });
  assert.deepEqual(defaultMonths(new Date(2026, 0, 10)), { first: '2025-12', second: '2026-01' });
  const options = monthOptions(NOW);
  assert.equal(options.length, MONTH_COUNT);
  assert.deepEqual(options.slice(0, 3), ['2026-09', '2026-08', '2026-07']);

  const html = renderCompare({ now: NOW });
  assert.equal((html.match(/<select /g) ?? []).length, 2);
  assert.match(html, /<label for="compare-first">First month<\/label><select id="compare-first" name="first" data-compare-first>/);
  assert.match(html, /<label for="compare-second">Second month<\/label><select id="compare-second" name="second" data-compare-second>/);
  const selected = [...html.matchAll(/<option value="([^"]+)" selected>/g)].map((m) => m[1]);
  assert.deepEqual(selected, ['2026-08', '2026-09']);
  assert.match(html, new RegExp('<option value="2026-09" selected>' + monthLabel('2026-09') + '</option>'));
  assert.match(html, /aria-busy="true"/, 'opens loading');
});

test('each month total and each category sit side by side on one row, with the difference', () => {
  const html = renderCompareView({ status: 'filled', entries: ENTRIES, first: '2026-08', second: '2026-09' });
  assert.match(html, /<table class="compare-table">/);
  assert.match(html, new RegExp('data-compare-heading="first">' + monthLabel('2026-08') + '<'));
  assert.match(html, new RegExp('data-compare-heading="second">' + monthLabel('2026-09') + '<'));

  assert.deepEqual(rowCells(html, 'data-compare-total'),
    ['Total', formatPaise(64500), formatPaise(29000), '−' + formatPaise(35500)]);
  assert.deepEqual(rowCells(html, 'data-category="Food"'),
    ['Food', formatPaise(12000), formatPaise(20000), '+' + formatPaise(8000)]);
  assert.deepEqual(rowCells(html, 'data-category="Bills"'),
    ['Bills', formatPaise(50000), formatPaise(0), '−' + formatPaise(50000)]);
  assert.deepEqual(rowCells(html, 'data-category="Transport"'),
    ['Transport', formatPaise(0), formatPaise(8000), '+' + formatPaise(8000)]);
  assert.deepEqual(categoryOrder(html), ['Bills', 'Food', 'Transport', UNCATEGORISED]);
  assert.ok(html.indexOf('data-compare-total') < html.indexOf('data-category='), 'Total comes first');
});

test('entries without a category are shown under an Uncategorised row', () => {
  const html = renderCompareView({ status: 'filled', entries: ENTRIES, first: '2026-08', second: '2026-09' });
  assert.deepEqual(rowCells(html, 'data-category="Uncategorised"'),
    [UNCATEGORISED, formatPaise(2500), formatPaise(1000), '−' + formatPaise(1500)]);
  const only = renderCompareView({
    status: 'filled',
    entries: [{ amountPaise: 700, timestamp: at(9, 1) }],
    first: '2026-08',
    second: '2026-09',
  });
  assert.deepEqual(categoryOrder(only), [UNCATEGORISED]);
});

test('the rows are exactly what compareMonths gives, every amount formatted as ₹', () => {
  const result = compareMonths(ENTRIES, '2026-08', '2026-09');
  assert.deepEqual(categoryRows(result), ['Bills', 'Food', 'Transport', UNCATEGORISED]);
  const html = renderCompareView({ status: 'filled', entries: ENTRIES, first: '2026-08', second: '2026-09' });
  for (const category of categoryRows(result)) {
    assert.equal(rowCells(html, 'data-category="' + category + '"')[3], formatDifference(result.diff.byCategory[category]));
  }
  const amounts = [...html.matchAll(/<td class="amount[^"]*">([^<]*)</g)].map((m) => m[1]);
  assert.equal(amounts.length, 5 * 3);
  for (const amount of amounts) assert.match(amount, /^[+−]?₹[\d,]+(\.\d+)?$/, amount);
  assert.doesNotMatch(html, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
});

test('a difference carries its sign and a class, not colour alone', () => {
  assert.equal(formatDifference(150), '+' + formatPaise(150));
  assert.equal(formatDifference(-150), '−' + formatPaise(150));
  assert.equal(formatDifference(0), formatPaise(0));
  const html = renderCompareView({ status: 'filled', entries: ENTRIES, first: '2026-08', second: '2026-09' });
  assert.match(html, /compare-difference compare-up">\+/);
  assert.match(html, /compare-difference compare-down">−/);
  const same = renderCompareView({ status: 'filled', entries: [], first: '2026-08', second: '2026-09' });
  assert.match(same, /compare-difference compare-same">₹0</);
  assert.match(same, /No spends in either month yet/);
});

test('mounting loads both chosen months and draws the comparison, focusing the first picker', async () => {
  const screen = fakeScreen();
  const { asked, load } = monthLoader();
  const done = mountCompare({ main: screen.main, load, now: NOW });
  assert.match(screen.view.innerHTML, /aria-busy="true"/);
  assert.equal(screen.first.focusCount, 1);
  await done;
  assert.deepEqual(asked, ['2026-08', '2026-09']);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.equal(rowCells(screen.view.innerHTML, 'data-compare-total')[1], formatPaise(64500));
  assert.match(screen.status.textContent, /Showing August 2026 against September 2026/);
});

test('changing either picker re-renders for the newly chosen months', async () => {
  const screen = fakeScreen();
  const { asked, load } = monthLoader();
  await mountCompare({ main: screen.main, load, now: NOW });

  screen.pick('first', '2026-07');
  assert.match(screen.view.innerHTML, /aria-busy="true"/);
  await tick();
  assert.deepEqual(asked.slice(2), ['2026-07', '2026-09']);
  assert.deepEqual(rowCells(screen.view.innerHTML, 'data-compare-total'),
    ['Total', formatPaise(99900), formatPaise(29000), '−' + formatPaise(70900)]);
  assert.match(screen.view.innerHTML, new RegExp('data-compare-heading="first">' + monthLabel('2026-07') + '<'));

  screen.pick('second', '2026-08');
  await tick();
  assert.deepEqual(asked.slice(4), ['2026-07', '2026-08']);
  assert.deepEqual(rowCells(screen.view.innerHTML, 'data-category="Bills"'),
    ['Bills', formatPaise(99900), formatPaise(50000), '−' + formatPaise(49900)]);
});

test('a load overtaken by a newer pick or by another screen writes nothing', async () => {
  const screen = fakeScreen();
  const pending = [];
  const load = (month) => new Promise((resolve) => pending.push(() => resolve(inMonth(month))));
  let current = true;
  mountCompare({ main: screen.main, load, now: NOW, isCurrent: () => current });
  screen.pick('first', '2026-07');
  pending[2]();
  pending[3]();
  await tick();
  const fresh = screen.view.innerHTML;
  assert.match(fresh, new RegExp(monthLabel('2026-07')));
  pending[0]();
  pending[1]();
  await tick();
  assert.equal(screen.view.innerHTML, fresh, 'the older load is dropped');

  screen.pick('second', '2026-08');
  const before = screen.view.innerHTML;
  current = false;
  pending[4]();
  pending[5]();
  await tick();
  assert.equal(screen.view.innerHTML, before, 'a replaced screen is not redrawn');
  assert.equal(screen.status.textContent.includes(monthLabel('2026-08') + ' against'), false);
});

test('one month picked twice is loaded once, so nothing is counted twice', async () => {
  const screen = fakeScreen({ first: '2026-09', second: '2026-09' });
  const { asked, load } = monthLoader();
  await mountCompare({ main: screen.main, load, now: NOW });
  assert.deepEqual(asked, ['2026-09']);
  assert.deepEqual(rowCells(screen.view.innerHTML, 'data-compare-total'),
    ['Total', formatPaise(29000), formatPaise(29000), formatPaise(0)]);
});

test('a failed load shows Try again, which loads again', async () => {
  const screen = fakeScreen();
  let calls = 0;
  const load = async (month) => {
    calls += 1;
    if (calls <= 2) throw new Error('UnknownSchemaVersionError');
    return inMonth(month);
  };
  await mountCompare({ main: screen.main, load, now: NOW });
  assert.equal(screen.root.getAttribute('data-status'), 'error');
  assert.match(screen.view.innerHTML, /role="alert"/);
  assert.match(screen.view.innerHTML, new RegExp(ERROR_MESSAGE));
  assert.match(screen.view.innerHTML, /data-action="retry">Try again</);
  assert.doesNotMatch(screen.view.innerHTML, /compare-table/, 'no misread sums');

  const retry = { closest: (selector) => (selector === '[data-action="retry"]' ? retry : null) };
  screen.view.dispatch('click', { target: retry });
  await tick();
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.equal(rowCells(screen.view.innerHTML, 'data-compare-total')[1], formatPaise(64500));
});

test('the screen reads only through the ledger load and makes no network request', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('no network');
  };
  try {
    const screen = fakeScreen();
    const { load } = monthLoader();
    await mountCompare({ main: screen.main, load, now: NOW });
    assert.equal(screen.root.getAttribute('data-status'), 'filled');
  } finally {
    globalThis.fetch = original;
  }
  const source = await readFile(new URL('./compare.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(source, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
  assert.match(source, /from '\.\.\/\.\.\/src\/compare-months\.js'/);
  assert.match(source, /from '\.\.\/\.\.\/src\/format-amount\.js'/);
  assert.match(source, /load = loadMonthEntries/);
  assert.doesNotMatch(source, /\.(?:add|addEntry|put|delete|clear|updateCategory)\(/, 'the screen only reads');
});

test('every class the screen uses is styled from tokens in css/controls.css', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const html = [
    renderCompare({ now: NOW }),
    renderCompareView({ status: 'error' }),
    renderCompareView({ status: 'filled', entries: ENTRIES, first: '2026-08', second: '2026-09' }),
    renderCompareView({ status: 'filled', entries: [], first: '2026-08', second: '2026-09' }),
  ].join('');
  /* Section names used only as hooks; the .card rule draws them. */
  const hooks = new Set(['compare-result', 'compare-loading', 'compare-error']);
  const used = new Set(html.match(/class="([^"]+)"/g).flatMap((m) => m.slice(7, -1).split(' ')));
  for (const name of used) {
    if (hooks.has(name)) continue;
    assert.match(css, new RegExp('\\.' + name + '[\\s,{:.]'), 'no rule for .' + name);
  }
  const section = css.slice(css.indexOf('Compare screen'), css.indexOf('Tab bar'));
  const body = section.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d(?:px|rem|em|pt)\b/i);
  for (const [, name] of body.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.match(tokens, new RegExp(name + ':'), name + ' is not a token');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  EMPTY_MESSAGE,
  ERROR_MESSAGE,
  SLICE_COLOURS,
  monthSummary,
  mountMonth,
  pieSlices,
  renderMonth,
  renderMonthView,
} from './month.js';
import { formatPaise } from '../../src/format-amount.js';
import { totals } from '../../src/totals.js';

const now = new Date(2026, 9, 15, 12, 0);
const at = (day, hour = 10) => new Date(2026, 9, day, hour, 0).getTime();

const mixed = [
  { id: 1, amountPaise: 12000, note: 'chai', timestamp: at(1) },
  { id: 2, amountPaise: 8050, note: 'auto', timestamp: at(2) },
  { id: 3, amountPaise: 100001, note: 'rent', timestamp: at(3) },
  { id: 4, amountPaise: 3333, note: 'lunch', timestamp: at(15) },
  { id: 5, amountPaise: 777, note: 'something odd', timestamp: at(9) },
  { id: 6, amountPaise: 99900, note: 'chai last month', timestamp: new Date(2026, 8, 30, 23, 0).getTime() },
];

const filled = (entries) => renderMonthView({ status: 'filled', entries, now });
const shownTotal = (html) => (html.match(/data-month-total[^>]*>([^<]*)</) ?? [])[1];
const legendAmounts = (html) => [...html.matchAll(/data-category-amount>([^<]*)</g)].map((m) => m[1]);
const legendNames = (html) => [...html.matchAll(/class="month-legend-name">([^<]*)</g)].map((m) => m[1]);

/* '₹1,000.01' back to integer paise. */
const toPaise = (text) => Math.round(Number(text.replace(/[₹,]/g, '')) * 100);

test('the legend lists each category with its ₹ amount, largest first', () => {
  const html = filled(mixed);
  assert.deepEqual(legendNames(html), ['Bills', 'Food', 'Transport', 'Other']);
  assert.deepEqual(legendAmounts(html), [formatPaise(100001), formatPaise(15333), formatPaise(8050), formatPaise(777)]);
});

test('the legend amounts sum exactly to the displayed month total', () => {
  const html = filled(mixed);
  const total = shownTotal(html);
  assert.equal(total, formatPaise(124161));
  assert.equal(legendAmounts(html).map(toPaise).reduce((a, b) => a + b, 0), toPaise(total));

  const { rows, total: summed } = monthSummary(mixed, now);
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), summed);
  assert.equal(summed, totals(mixed, now).month, 'the same month total Today shows');
});

test('the pie has one slice per category, each an arc path, coloured like its legend row', () => {
  const html = filled(mixed);
  assert.match(html, /<svg class="month-pie" viewBox="0 0 100 100" role="img" aria-label="Spend by category: Bills ₹/);
  const paths = [...html.matchAll(/<path class="month-slice month-slice-(\d)" d="M 50,50 L [\d.]+,[\d.]+ A 48,48 0 [01] 1 [\d.]+,[\d.]+ Z">/g)];
  assert.equal(paths.length, 4);
  assert.deepEqual(paths.map((m) => m[1]), ['1', '2', '3', '4']);
  assert.doesNotMatch(html, /<circle/);
  const swatches = [...html.matchAll(/month-swatch month-slice month-slice-(\d)/g)].map((m) => m[1]);
  assert.deepEqual(swatches, ['1', '2', '3', '4']);
});

test('slices start at the top, run clockwise and close the circle', () => {
  const slices = pieSlices([{ amount: 3 }, { amount: 1 }]);
  assert.equal(slices.length, 2);
  assert.equal(slices[0].d, 'M 50,50 L 50,2 A 48,48 0 1 1 2,50 Z', 'three quarters is the large arc');
  assert.equal(slices[1].d, 'M 50,50 L 2,50 A 48,48 0 0 1 50,2 Z');
  const half = pieSlices([{ amount: 1 }, { amount: 1 }]);
  assert.match(half[0].d, / A 48,48 0 0 1 50,98 Z$/, 'exactly half is not the large arc');
});

test('a month with a single category is a full circle, not a zero-angle arc', () => {
  const html = filled([
    { id: 1, amountPaise: 2000, note: 'chai', timestamp: at(1) },
    { id: 2, amountPaise: 4000, note: 'lunch', timestamp: at(2) },
  ]);
  assert.match(html, /<circle class="month-slice month-slice-1" cx="50" cy="50" r="48"><\/circle>/);
  assert.doesNotMatch(html, /<path/);
  assert.equal(shownTotal(html), '₹60');
  assert.deepEqual(legendAmounts(html), ['₹60']);
  assert.deepEqual(pieSlices([{ amount: 5 }]), [{ shape: 'circle', index: 0 }]);
});

test('a month with no entries shows ₹0 and the empty message, with no pie', () => {
  for (const entries of [[], undefined, null, [mixed[5]]]) {
    let html;
    assert.doesNotThrow(() => {
      html = filled(entries);
    });
    assert.equal(shownTotal(html), '₹0');
    assert.match(html, new RegExp(EMPTY_MESSAGE));
    assert.match(html, /href="#\/today"/);
    assert.doesNotMatch(html, /<svg|month-legend/);
  }
  assert.deepEqual(pieSlices([]), []);
});

test('an entry\'s own category is kept; others are read from the note', () => {
  const html = filled([
    { id: 1, amountPaise: 500, note: 'chai', category: 'Treats', timestamp: at(1) },
    { id: 2, amountPaise: 300, note: 'chai', category: '  ', timestamp: at(1) },
  ]);
  assert.deepEqual(legendNames(html), ['Treats', 'Food']);
});

test('category names are escaped', () => {
  const html = filled([{ id: 1, amountPaise: 500, note: 'x', category: '<b>', timestamp: at(1) }]);
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test('more categories than colours reuse the slice colours in turn', () => {
  const entries = Array.from({ length: SLICE_COLOURS + 1 }, (_, i) => (
    { id: i, amountPaise: 1000 - i, note: '', category: 'C' + i, timestamp: at(1) }
  ));
  const html = filled(entries);
  const classes = [...html.matchAll(/<path class="month-slice month-slice-(\d)"/g)].map((m) => Number(m[1]));
  assert.equal(classes.length, SLICE_COLOURS + 1);
  assert.equal(classes.at(-1), 1);
});

test('loading shows a skeleton and error a dash with Try again, never a ₹ total', () => {
  const loading = renderMonth();
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /data-month-total|<svg/);
  const error = renderMonthView({ status: 'error', now });
  assert.match(error, new RegExp(ERROR_MESSAGE));
  assert.match(error, /data-action="retry"/);
  assert.equal(shownTotal(error), '—');
});

test('the chart is hand-written SVG with no library, CDN or new dependency', async () => {
  const source = await readFile(new URL('./month.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const name of imports) assert.match(name, /^\.\.?\//, name + ' is not a local module');
  assert.doesNotMatch(source, /https?:\/\/|<script/);
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('every class the screen uses is styled from tokens in css/controls.css', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const html = [renderMonth(), renderMonthView({ status: 'error', now }), filled([]), filled(mixed)].join('');
  const hooks = new Set(['month-empty', 'month-loading']);
  const used = new Set(html.match(/class="([^"]+)"/g).flatMap((m) => m.slice(7, -1).split(' ')));
  for (const name of used) {
    if (hooks.has(name)) continue;
    assert.match(css, new RegExp('\\.' + name + '[\\s,{:.]'), 'no rule for .' + name);
  }
  for (let i = 1; i <= SLICE_COLOURS; i += 1) {
    assert.match(css, new RegExp('\\.month-slice-' + i + ' \\{[^}]*fill: var\\(--color-chart-' + i + '\\)'));
    assert.match(tokens, new RegExp('--color-chart-' + i + ':'));
  }
});

/* Just enough of <main> for the mount. */
function fakeMain() {
  const view = { innerHTML: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  return {
    view,
    focused: 0,
    querySelector: (selector) => (selector === '[data-month-view]' ? view : null),
    focus() {
      this.focused += 1;
    },
  };
}

test('mountMonth loads the entries and draws the pie, legend and total', async () => {
  const main = fakeMain();
  const ready = mountMonth({ main, load: async () => mixed, now: () => now });
  assert.match(main.view.innerHTML, /aria-busy="true"/);
  assert.equal(main.focused, 1);
  await ready;
  assert.equal(shownTotal(main.view.innerHTML), formatPaise(124161));
  assert.match(main.view.innerHTML, /<svg class="month-pie"/);
});

test('mountMonth shows the error on a failed load, and Try again loads afresh', async () => {
  const main = fakeMain();
  let calls = 0;
  const load = () => {
    calls += 1;
    if (calls === 1) throw new Error('nope');
    return Promise.resolve([]);
  };
  await mountMonth({ main, load, now: () => now });
  assert.match(main.view.innerHTML, /data-action="retry"/);
  const button = {};
  await main.view.listeners.click({ target: { closest: () => button } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(shownTotal(main.view.innerHTML), '₹0');
});

test('mountMonth writes nothing once the screen has been replaced', async () => {
  const main = fakeMain();
  let current = true;
  const ready = mountMonth({ main, load: async () => mixed, isCurrent: () => current, now: () => now });
  const before = main.view.innerHTML;
  current = false;
  await ready;
  assert.equal(main.view.innerHTML, before);
});

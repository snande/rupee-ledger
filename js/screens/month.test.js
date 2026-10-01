import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CHART_COLOURS,
  EMPTY_MESSAGE,
  ERROR_MESSAGE,
  monthSummary,
  mountMonth,
  pieSlices,
  renderMonth,
  renderMonthView,
  share,
  slicePath,
  UNCATEGORISED,
} from './month.js';
import { formatPaise } from '../../src/format-amount.js';
import { categoryTotalsForMonth } from '../../src/category-totals.js';

const NOW = new Date(2026, 8, 15, 12);
const at = (month, day) => new Date(2026, month - 1, day, 10).getTime();

/* September 2026, plus one August spend the month may not count. */
const ENTRIES = [
  { id: 1, amountPaise: 20000, note: 'thali', category: 'Food', timestamp: at(9, 2) },
  { id: 2, amountPaise: 8050, note: 'auto', category: 'Transport', timestamp: at(9, 4) },
  { id: 3, amountPaise: 1000, note: 'misc', category: null, timestamp: at(9, 6) },
  { id: 4, amountPaise: 4525, note: 'chai', category: 'Food', timestamp: at(9, 7) },
  { id: 5, amountPaise: 99900, note: 'august', category: 'Bills', timestamp: at(8, 20) },
];

const filled = (entries, month = '2026-09') => renderMonthView({ status: 'filled', entries, month, now: NOW });
const total = (html) => (html.match(/data-month-total>([^<]*)</) ?? [])[1];
const legendAmounts = (html) => [...html.matchAll(/data-legend-amount>([^<]*)</g)].map((m) => m[1]);
const legendNames = (html) => [...html.matchAll(/<li class="month-legend-row" data-category="([^"]*)"/g)].map((m) => m[1]);
const sliceNames = (html) => [...html.matchAll(/<path class="month-slice[^"]*" d="[^"]+" data-slice="([^"]*)"/g)].map((m) => m[1]);
const rupeesToPaise = (text) => Math.round(Number(text.replace(/[₹,]/g, '')) * 100);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the month total and the legend come from categoryTotalsForMonth and add up exactly', () => {
  const html = filled(ENTRIES);
  const rows = categoryTotalsForMonth(ENTRIES, 2026, 9);
  const sum = rows.reduce((paise, row) => paise + row.amount, 0);
  assert.equal(total(html), formatPaise(sum));
  assert.equal(total(html), formatPaise(33575));
  assert.deepEqual(legendNames(html), rows.map((row) => row.category));
  assert.deepEqual(legendAmounts(html), rows.map((row) => formatPaise(row.amount)));
  assert.equal(legendAmounts(html).map(rupeesToPaise).reduce((a, b) => a + b, 0), rupeesToPaise(total(html)));
  assert.deepEqual(monthSummary(ENTRIES, '2026-09'), { rows, total: sum });
  assert.doesNotMatch(html, /Bills/, 'an August spend is not counted');
  assert.ok(legendNames(html).includes(UNCATEGORISED));
});

test('the chart is an inline SVG with one slice per category', () => {
  const html = filled(ENTRIES);
  assert.equal((html.match(/<svg class="month-pie"/g) ?? []).length, 1);
  const slices = [...html.matchAll(/<path class="month-slice month-colour-(\d)" d="([^"]+)" data-slice="([^"]*)"/g)];
  assert.deepEqual(slices.map((m) => m[3]), ['Food', 'Transport', UNCATEGORISED]);
  assert.deepEqual(slices.map((m) => m[1]), ['1', '2', '3']);
  for (const [, , d] of slices) {
    assert.match(d, /^M 50,50 L [\d.-]+,[\d.-]+ A 50,50 0 [01] 1 [\d.-]+,[\d.-]+ Z$/);
  }
  assert.match(html, /<svg[^>]* role="img" aria-label="Spends in September 2026 by category"/);
});

test('a month with no entries shows ₹0 and the empty message, with no pie', () => {
  for (const entries of [[], undefined, null, ENTRIES.filter((e) => e.id === 5)]) {
    const html = filled(entries);
    assert.equal(total(html), '₹0');
    assert.match(html, new RegExp(EMPTY_MESSAGE));
    assert.doesNotMatch(html, /<svg|month-legend/);
  }
  assert.doesNotThrow(() => renderMonth({ status: 'filled', entries: [], now: NOW }));
});

test('a single category is a full circle, not a zero-angle arc', () => {
  const html = filled(ENTRIES.filter((entry) => entry.category === 'Food'));
  assert.equal(total(html), formatPaise(24525));
  assert.match(html, /<circle class="month-slice month-colour-1" cx="50" cy="50" r="50" data-slice="Food">/);
  assert.doesNotMatch(html, /<path/);
});

test('slicePath draws a wedge, with the large-arc flag past half the circle', () => {
  assert.equal(slicePath(50, 50, 50, 0, Math.PI / 2), 'M 50,50 L 50,0 A 50,50 0 0 1 100,50 Z');
  assert.match(slicePath(50, 50, 50, 0, (3 * Math.PI) / 2), / A 50,50 0 1 1 0,50 Z$/);
  const html = filled([
    { amountPaise: 30000, category: 'Rent', timestamp: at(9, 1) },
    { amountPaise: 10000, category: 'Food', timestamp: at(9, 2) },
  ]);
  assert.match(html, /d="M 50,50 L 50,0 A 50,50 0 1 1 0,50 Z" data-slice="Rent"/);
  assert.match(html, /d="M 50,50 L 0,50 A 50,50 0 0 1 50,0 Z" data-slice="Food"/);
});

test('a slice that is nearly the whole month is drawn as two arcs, so it does not vanish', () => {
  const html = filled([
    { amountPaise: 10_000_000, category: 'Rent', timestamp: at(9, 1) },
    { amountPaise: 1, category: 'Pen', timestamp: at(9, 2) },
  ]);
  assert.match(html, /d="M 50,50 L 50,0 A 50,50 0 0 1 50,100 A 50,50 0 0 1 50,0 Z" data-slice="Rent"/);
  /* Every arc ends somewhere other than where it starts. */
  const rent = html.match(/d="([^"]+)" data-slice="Rent"/)[1];
  let from = rent.match(/L ([\d.-]+,[\d.-]+)/)[1];
  for (const [, to] of rent.matchAll(/A 50,50 0 [01] 1 ([\d.-]+,[\d.-]+)/g)) {
    assert.notEqual(to, from);
    from = to;
  }
  assert.deepEqual(sliceNames(html), ['Rent', 'Pen']);
});

test('every category with spend gets its own slice, the colours cycling past the last', () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({
    amountPaise: (10 - i) * 1000,
    category: 'Cat ' + (i + 1),
    timestamp: at(9, 1 + i),
  }));
  const rows = categoryTotalsForMonth(entries, 2026, 9);
  const slices = pieSlices(rows);
  assert.equal(slices.length, rows.length);
  assert.deepEqual(slices.map((slice) => slice.label), rows.map((row) => row.category));
  assert.deepEqual(slices.map((slice) => slice.colour), [1, 2, 3, 4, 5, 6, 7, 1, 2]);
  assert.equal(CHART_COLOURS, 7);
  const html = filled(entries);
  assert.equal(legendNames(html).length, 9);
  assert.deepEqual(sliceNames(html), rows.map((row) => row.category));
  assert.match(html, /data-category="Cat 9"><span class="month-swatch month-colour-2"/);
});

test('the legend shows each share as a whole percent', () => {
  assert.equal(share(1, 3), '33%');
  assert.equal(share(0, 0), '');
  assert.match(filled(ENTRIES), /<span class="month-legend-share">73%<\/span>/);
});

test('category names are escaped in the legend and the chart', () => {
  const html = filled([
    { amountPaise: 100, category: '<b>x</b>', timestamp: at(9, 1) },
    { amountPaise: 200, category: 'Food', timestamp: at(9, 1) },
  ]);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('the router render opens on this month, loading', () => {
  const html = renderMonth();
  assert.match(html, /^<div class="month" data-status="loading">/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /data-month-total/);
  assert.match(renderMonthView({ status: 'error' }), new RegExp(ERROR_MESSAGE));
});

/* Just enough of the rendered screen for mountMonth. */
function fakeScreen() {
  const listeners = new Map();
  const attrs = new Map();
  const view = {
    innerHTML: '',
    addEventListener: (type, fn) => listeners.set(type, fn),
    click: (target) => listeners.get('click')?.({ target }),
  };
  const root = { setAttribute: (name, value) => attrs.set(name, value), status: () => attrs.get('data-status') };
  const main = {
    focused: false,
    focus() {
      this.focused = true;
    },
    querySelector: (selector) => ({ '.month': root, '[data-month-view]': view })[selector] ?? null,
  };
  return { main, view, root };
}

test('mountMonth loads this month and draws it', async () => {
  const screen = fakeScreen();
  const asked = [];
  const done = mountMonth({ main: screen.main, now: NOW, load: async (month) => { asked.push(month); return ENTRIES; } });
  assert.equal(screen.root.status(), 'loading');
  assert.ok(screen.main.focused);
  await done;
  assert.deepEqual(asked, ['2026-09']);
  assert.equal(screen.root.status(), 'filled');
  assert.equal(total(screen.view.innerHTML), formatPaise(33575));
  assert.match(screen.view.innerHTML, /<svg class="month-pie"/);
});

test('a failed load shows Try again, which loads again', async () => {
  const screen = fakeScreen();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error('no store');
    return [];
  };
  await mountMonth({ main: screen.main, now: NOW, load });
  assert.equal(screen.root.status(), 'error');
  assert.match(screen.view.innerHTML, /data-action="retry"/);
  screen.view.click({ closest: (selector) => (selector === '[data-action="retry"]' ? {} : null) });
  await tick();
  assert.equal(calls, 2);
  assert.equal(total(screen.view.innerHTML), '₹0');
  assert.match(screen.view.innerHTML, new RegExp(EMPTY_MESSAGE));
});

test('a load overtaken by a route change writes nothing', async () => {
  const screen = fakeScreen();
  let current = true;
  const done = mountMonth({ main: screen.main, now: NOW, isCurrent: () => current, load: async () => ENTRIES });
  current = false;
  await done;
  assert.doesNotMatch(screen.view.innerHTML, /data-month-total/);
});

test('the screen is hand-written: no network, no chart library, ₹ only, read only', async () => {
  const source = await readFile(new URL('./month.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(source, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
  assert.match(source, /from '\.\.\/\.\.\/src\/category-totals\.js'/);
  assert.match(source, /from '\.\.\/\.\.\/src\/format-amount\.js'/);
  assert.doesNotMatch(source, /\.(?:add|addEntry|put|delete|clear|updateCategory)\(/, 'the screen only reads');
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('every class the screen uses is styled from tokens in css/controls.css', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const html = [
    renderMonth({ now: NOW }),
    renderMonthView({ status: 'error' }),
    filled(ENTRIES),
    filled([]),
    filled(ENTRIES.filter((entry) => entry.category === 'Food')),
  ].join('');
  /* Section names used only as hooks; the .card rule draws them. */
  const hooks = new Set(['month-breakdown', 'month-empty', 'month-loading', 'month-error']);
  const used = new Set(html.match(/class="([^"]+)"/g).flatMap((m) => m.slice(7, -1).split(' ')));
  for (const name of used) {
    if (hooks.has(name)) continue;
    assert.match(css, new RegExp('\\.' + name + '[\\s,{:.]'), 'no rule for .' + name);
  }
  for (let i = 1; i <= CHART_COLOURS; i += 1) {
    assert.match(css, new RegExp('\\.month-colour-' + i + ' \\{'), 'no rule for .month-colour-' + i);
    assert.match(tokens, new RegExp('--chart-' + i + ':'), '--chart-' + i + ' is not a token');
  }
  const section = css.slice(css.indexOf('Month screen'), css.indexOf('Tab bar'));
  const body = section.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d(?:px|rem|em|pt)\b/i);
  for (const [, name] of body.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.match(tokens, new RegExp(name + ':'), name + ' is not a token');
  }
});

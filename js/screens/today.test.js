import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CATEGORIES,
  ENTRY_HINT,
  ERROR_MESSAGE,
  INVALID_HINT,
  formatPaise,
  categoryOf,
  isToday,
  saveFailedHint,
  mountToday,
  renderToday,
  renderTodayView,
  shownStatus,
} from './today.js';
import { formatPaise as sharedFormatPaise } from '../../src/format-amount.js';
import { INVALID_HINT as QUICK_ENTRY_HINT } from '../../src/quick-entry.js';
import { fromRecord } from '../data/ledger.js';

const now = Date.now();
const sample = [
  { id: 'a', amountPaise: 124500, note: 'Electricity top-up', timestamp: now },
  { id: 'b', amountPaise: 4550, note: 'Auto <to> station', timestamp: now },
];

/* A ledger whose add() succeeds and stores nothing, as on a demo visit. */
const keep = { add: async () => null };

/* Just enough of an element for the screen: attributes, classes, events. */
function fakeElement() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    offsetWidth: 0,
    focusCount: 0,
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
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
    focus() {
      this.focusCount += 1;
    },
  };
}

/* The rendered screen, as the parts mountToday looks up in <main>. */
function fakeScreen() {
  const parts = {
    '.today': fakeElement(),
    '[data-today-view]': fakeElement(),
    '[data-today-form]': fakeElement(),
    '#quick-entry': fakeElement(),
    '#quick-entry-hint': fakeElement(),
    '[data-entry-status]': fakeElement(),
  };
  /* The view finds controls to focus by selector, and says which targets
     sit inside it, as the picker's focus moves and document taps need. */
  const view = parts['[data-today-view]'];
  view.focused = null;
  view.querySelector = (selector) => ({ focus: () => { view.focused = selector; } });
  view.contains = (target) => Boolean(target && target.insideView);
  return {
    main: { querySelector: (selector) => parts[selector] ?? null },
    root: parts['.today'],
    view: parts['[data-today-view]'],
    form: parts['[data-today-form]'],
    input: parts['#quick-entry'],
    hint: parts['#quick-entry-hint'],
    status: parts['[data-entry-status]'],
  };
}

function clickAction(view, action) {
  const button = { getAttribute: () => action };
  view.dispatch('click', { target: { closest: () => button } });
}

function submit(form) {
  let prevented = false;
  form.dispatch('submit', { preventDefault: () => { prevented = true; } });
  return prevented;
}

function type(screen, text) {
  screen.input.value = text;
  return submit(screen.form);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* A tap on a control in the view, given the data attributes it renders
   with; `inPicker` says whether it sits inside the open picker. */
function tap(view, attrs, inPicker = false) {
  const button = { getAttribute: (name) => attrs[name] ?? null };
  view.dispatch('click', {
    target: {
      closest: (selector) => (selector === '[data-action]' ? button : selector === '.category-picker' && inPicker ? {} : null),
    },
  });
}

const tapChip = (view, id) => tap(view, { 'data-action': 'open-category', 'data-entry-id': String(id) });
const tapCategory = (view, id, category) =>
  tap(view, { 'data-action': 'pick-category', 'data-entry-id': String(id), 'data-category': category }, true);
/* A tap on the view that lands on no control, inside the picker or not. */
const tapBlank = (view, inPicker) => view.dispatch('click', {
  target: { closest: (selector) => (selector === '.category-picker' && inPicker ? {} : null) },
});
/* A key pressed on an option of the open picker. */
const keyOnOption = (view, key, category) => {
  let prevented = false;
  view.dispatch('keydown', { key, target: { getAttribute: () => category }, preventDefault: () => { prevented = true; } });
  return prevented;
};

/* The name each chip shows, by entry id, in the rendered view. */
const chips = (html) => Object.fromEntries([...html.matchAll(/class="category-chip"[^>]*data-entry-id="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
  .map(([, id, name]) => [id, name]));
const pickerOptions = (html) => [...html.matchAll(/class="category-option[^"]*"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)</g)]
  .map(([, selected, name]) => [name, selected === 'true']);

/* A page document for the picker's Escape and outside-tap listeners; the
   screen reads it when it mounts. */
async function withDocument(fn) {
  const listeners = new Map();
  const doc = {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    dispatch: (type, event) => listeners.get(type)?.(event),
  };
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    await fn(doc);
  } finally {
    if (had) globalThis.document = previous;
    else delete globalThis.document;
  }
}

test('amounts go through the shared formatPaise: ₹, Indian grouping, paise only when present', () => {
  assert.equal(formatPaise, sharedFormatPaise);
  assert.equal(formatPaise(12000), '₹120');
  assert.equal(formatPaise(4550), '₹45.5');
  assert.equal(formatPaise(5), '₹0.05');
  assert.equal(formatPaise(0), '₹0');
  assert.equal(formatPaise(123450 * 100), '₹1,23,450');
  assert.equal(formatPaise(1234567 * 100), '₹12,34,567');
  assert.equal(formatPaise(100000 * 100), '₹1,00,000');
  assert.equal(formatPaise(999 * 100), '₹999');
  assert.equal(INVALID_HINT, QUICK_ENTRY_HINT);
  assert.equal(INVALID_HINT, 'Start with an amount, e.g. 120 chai');
});

test('each status renders its own distinct view', () => {
  const views = {
    empty: renderTodayView({ status: 'empty' }),
    loading: renderTodayView({ status: 'loading' }),
    error: renderTodayView({ status: 'error' }),
    filled: renderTodayView({ status: 'filled', entries: sample }),
  };
  assert.equal(new Set(Object.values(views)).size, 4);

  assert.match(views.empty, /class="card today-empty"/);
  assert.match(views.empty, /120<\/span> chai/);
  assert.match(views.empty, /<button type="button" class="button-secondary today-cta" data-action="focus-entry">/);

  assert.match(views.loading, /class="card today-loading" aria-busy="true"/);
  assert.match(views.loading, /skeleton-row/);

  assert.match(views.error, /class="card today-error" role="alert"/);
  assert.ok(views.error.includes(ERROR_MESSAGE));
  assert.match(views.error, /<button type="button" class="button-secondary" data-action="retry">Try again<\/button>/);

  assert.match(views.filled, /class="entry-list"/);
  assert.match(views.filled, /Electricity top-up<\/span><span class="amount entry-amount">₹1,245<\/span>/);
  assert.match(views.filled, /data-today-total>₹1,290.5</);
  assert.match(views.filled, /2 spends/);
});

test('renderToday marks the screen with the status it shows', () => {
  for (const status of ['empty', 'loading', 'error', 'filled']) {
    const html = renderToday({ status, entries: status === 'filled' ? sample : [] });
    assert.match(html, new RegExp('<div class="today" data-status="' + status + '">'));
  }
  assert.match(renderToday(), /data-status="loading"/);
  assert.equal(shownStatus({ status: 'error', entries: sample }), 'filled');
  assert.equal(shownStatus({ status: 'loading', entries: sample }), 'filled');
  assert.equal(shownStatus({ status: 'empty', entries: sample }), 'filled');
  assert.equal(shownStatus({ status: 'filled', entries: [] }), 'empty');
});

test('the error view shows a given message, escaped', () => {
  const html = renderTodayView({ status: 'error', message: 'Backup <b>broken</b>' });
  assert.match(html, /Backup &lt;b&gt;broken&lt;\/b&gt;/);
});

test('entry notes are escaped, and an empty note reads No note', () => {
  const html = renderTodayView({ status: 'filled', entries: [...sample, { id: 'c', amountPaise: 100, note: '', timestamp: now }] });
  assert.match(html, /Auto &lt;to&gt; station/);
  assert.doesNotMatch(html, /<to>/);
  assert.match(html, /entry-note-empty">No note</);
});

test('filled with no entries falls back to the empty view; unknown status is loading', () => {
  assert.equal(renderTodayView({ status: 'filled', entries: [] }), renderTodayView({ status: 'empty' }));
  assert.equal(renderTodayView({ status: 'nope' }), renderTodayView({ status: 'loading' }));
});

test('the screen carries a one-line text input and a submit button, and no other control', () => {
  for (const status of ['empty', 'loading', 'error', 'filled']) {
    const html = renderToday({ status, entries: status === 'filled' ? sample : [] });
    assert.match(html, /<input class="quick-entry" id="quick-entry" name="entry" type="text" placeholder="120 chai"/);
    assert.match(html, /<button type="submit">Add<\/button>/);
    assert.match(html, /<label for="quick-entry">Add a spend<\/label>/);
    assert.doesNotMatch(html, /<(select|textarea)\b/);
    assert.equal((html.match(/<input\b/g) ?? []).length, 1);
  }
});

test('the screen shows no currency but ₹, in its output or its code', async () => {
  const source = await readFile(new URL('./today.js', import.meta.url), 'utf8');
  const stub = await readFile(new URL('../data/stub.js', import.meta.url), 'utf8');
  const html = renderToday({ status: 'filled', entries: sample });
  for (const text of [source, stub, html]) {
    assert.doesNotMatch(text, /[$€£¥₩₽¢]|\bUSD\b|\bINR\b|\bRs\.?\s/);
  }
  assert.match(html, /₹/);
});

test('every class the screen uses is styled from tokens in css/controls.css', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const html = [
    renderToday({ status: 'empty' }),
    renderTodayView({ status: 'loading' }),
    renderTodayView({ status: 'error' }),
    renderTodayView({ status: 'filled', entries: sample, newestId: 'a' }),
    renderTodayView({ status: 'filled', entries: sample, picking: 'a' }),
  ].join('');
  /* Section names used only as test and script hooks; the .card rule draws them. */
  const hooks = new Set(['today-empty', 'today-list', 'today-loading']);
  const used = new Set(html.match(/class="([^"]+)"/g).flatMap((m) => m.slice(7, -1).split(' ')));
  for (const name of used) {
    if (hooks.has(name)) continue;
    assert.match(css, new RegExp('\\.' + name + '[\\s,{:.]'), 'no rule for .' + name);
  }
  const todaySection = css.slice(css.indexOf('Today screen'), css.indexOf('Tab bar'));
  const body = todaySection.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d(?:px|rem|em|pt)\b/i);
  for (const [, name] of body.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.match(tokens, new RegExp(name + ':'), name + ' is not a token');
  }
});

test('every tap target on the screen is at least 44 by 44 CSS pixels', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const px = (token) => {
    const value = tokens.match(new RegExp(token + ':\\s*([^;]+);'))[1].trim();
    const direct = value.match(/^(\d+)px$/);
    if (direct) return Number(direct[1]);
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (ref) return px(ref[1]);
    const sum = value.match(/^calc\(var\((--[\w-]+)\) \+ var\((--[\w-]+)\)\)$/);
    return px(sum[1]) + px(sum[2]);
  };
  const rule = (selector) => css.match(new RegExp('\\n' + selector.replace(/[.[\]]/g, '\\$&') + ' \\{([^}]*)\\}'))[1];

  assert.match(rule('button'), /min-height: var\(--control-min-height\)/);
  assert.match(rule('input'), /min-height: var\(--control-min-height\)/);
  assert.match(rule('.quick-entry'), /min-height: var\(--quick-entry-height\)/);
  assert.match(rule('.today-entry-row button'), /min-width: var\(--control-min-height\)/);
  assert.match(rule('.today-cta'), /width: 100%/);
  assert.match(rule('.category-chip'), /min-height: var\(--control-min-height\)/);
  assert.match(rule('.category-chip'), /min-width: var\(--control-min-height\)/);
  assert.match(rule('.category-option'), /min-height: var\(--control-min-height\)/);
  assert.ok(px('--control-min-height') >= 44);
  assert.equal(px('--quick-entry-height'), 56);
});

test('on open the entry box has focus and the screen shows loading until the load settles', async () => {
  const screen = fakeScreen();
  let resolve;
  const ready = mountToday({ main: screen.main, ledger: keep, load: () => new Promise((yes) => { resolve = yes; }) });
  assert.equal(screen.input.focusCount, 1);
  assert.match(screen.view.innerHTML, /aria-busy="true"/);
  assert.equal(screen.root.getAttribute('data-status'), 'loading');

  resolve(sample);
  await ready;
  assert.match(screen.view.innerHTML, /class="entry-list"/);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
});

test('a load that resolves [] shows the empty view, and its call to action focuses the box', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => [] });
  assert.match(screen.view.innerHTML, /today-empty/);
  assert.equal(screen.root.getAttribute('data-status'), 'empty');
  const before = screen.input.focusCount;
  clickAction(screen.view, 'focus-entry');
  assert.equal(screen.input.focusCount, before + 1);
});

test('a load that rejects shows the error view, and Try again loads again', async () => {
  const screen = fakeScreen();
  let calls = 0;
  const load = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('disk')) : Promise.resolve(sample);
  };
  await mountToday({ main: screen.main, ledger: keep, load });
  assert.match(screen.view.innerHTML, /today-error/);
  assert.match(screen.view.innerHTML, /Try again/);
  assert.equal(screen.root.getAttribute('data-status'), 'error');

  clickAction(screen.view, 'retry');
  assert.equal(calls, 2);
  assert.match(screen.view.innerHTML, /aria-busy="true"/);
  await tick();
  assert.match(screen.view.innerHTML, /entry-list/);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
});

test('a spend added during an error stays listed across Try again, and the totals wait for a load', async () => {
  const screen = fakeScreen();
  let calls = 0;
  const load = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('disk'));
    if (calls === 2) return Promise.reject(new Error('disk again'));
    return Promise.resolve(sample);
  };
  await mountToday({ main: screen.main, ledger: keep, load });

  type(screen, '120 chai');
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.match(screen.view.innerHTML, /entry-new"><span class="entry-note">chai</);
  assert.match(screen.view.innerHTML, /data-today-total aria-hidden="true">—</, 'no part-sum while the ledger is unread');
  assert.match(screen.view.innerHTML, /today-error/, 'the failed load is still reported');

  clickAction(screen.view, 'retry');
  await tick();
  assert.equal(calls, 2);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.match(screen.view.innerHTML, /1 spend</);
  assert.doesNotMatch(screen.view.innerHTML, /data-today-total>₹/);
  assert.match(screen.view.innerHTML, /today-error/);

  clickAction(screen.view, 'retry');
  await tick();
  assert.equal(calls, 3);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.match(screen.view.innerHTML, /data-today-total>₹1,410.5</);
  assert.match(screen.view.innerHTML, /3 spends/);
  assert.doesNotMatch(screen.view.innerHTML, /today-error/);
});

test('a load that throws synchronously also shows the error view', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: () => { throw new Error('no'); } });
  assert.match(screen.view.innerHTML, /today-error/);
});

test('the query from the router reaches the data source', async () => {
  const screen = fakeScreen();
  const seen = [];
  await mountToday({
    main: screen.main,
    ledger: keep,
    query: new URLSearchParams('state=filled'),
    load: async (query) => { seen.push(query.get('state')); return []; },
  });
  assert.deepEqual(seen, ['filled']);
});

test('typing 120 chai and pressing Enter saves it, clears the box and updates the total at once', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => [] });

  screen.input.value = '120 chai';
  screen.input.dispatch('input');
  assert.equal(screen.hint.textContent, '₹120 · chai');

  const started = performance.now();
  const prevented = submit(screen.form);
  const elapsed = performance.now() - started;

  assert.equal(prevented, true, 'no page reload');
  assert.ok(elapsed < 100, 'rendered in ' + elapsed + 'ms');
  assert.equal(screen.input.value, '');
  assert.match(screen.view.innerHTML, /data-today-total>₹120</);
  assert.match(screen.view.innerHTML, /class="entry-row entry-new"><span class="entry-note">chai<\/span>/);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');
  assert.equal(screen.hint.textContent, ENTRY_HINT);
  assert.equal(screen.status.textContent, 'Added ₹120 chai');
  assert.ok(screen.input.focusCount >= 2, 'focus stays in the box');

  type(screen, '45.50 auto');
  assert.match(screen.view.innerHTML, /data-today-total>₹165.5</);
  assert.match(screen.view.innerHTML, /entry-new"><span class="entry-note">auto/);
});

test('a line with no amount shakes, shows an inline hint and keeps the text', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => [] });
  const before = screen.view.innerHTML;

  type(screen, 'chai');
  assert.equal(screen.input.value, 'chai');
  assert.equal(screen.input.getAttribute('aria-invalid'), 'true');
  assert.ok(screen.input.classList.contains('shake'));
  assert.ok(screen.hint.classList.contains('hint-error'));
  assert.equal(screen.hint.textContent, INVALID_HINT);
  assert.equal(screen.view.innerHTML, before);

  screen.input.dispatch('animationend');
  assert.ok(!screen.input.classList.contains('shake'));

  screen.input.value = '20 chai';
  screen.input.dispatch('input');
  assert.equal(screen.input.getAttribute('aria-invalid'), null);
  assert.ok(!screen.hint.classList.contains('hint-error'));
});

test('an empty Enter does nothing', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => [] });
  const before = screen.view.innerHTML;
  type(screen, '   ');
  assert.equal(screen.view.innerHTML, before);
  assert.equal(screen.input.getAttribute('aria-invalid'), null);
});

test('a spend added while loading shows at once and joins the loaded ones', async () => {
  const screen = fakeScreen();
  let resolve;
  const ready = mountToday({ main: screen.main, ledger: keep, load: () => new Promise((yes) => { resolve = yes; }) });
  type(screen, '120 chai');
  assert.match(screen.view.innerHTML, /entry-new"><span class="entry-note">chai</);
  assert.match(screen.view.innerHTML, /total-skeleton/, 'the totals wait for the ledger');
  assert.match(screen.view.innerHTML, /aria-busy="true"/);
  assert.equal(screen.root.getAttribute('data-status'), 'filled');

  resolve(sample);
  await ready;
  assert.match(screen.view.innerHTML, /data-today-total>₹1,410.5</);
  assert.doesNotMatch(screen.view.innerHTML, /aria-busy/);
});

test('once the router has moved on, a late load writes nothing', async () => {
  const screen = fakeScreen();
  let current = true;
  let resolve;
  const ready = mountToday({
    main: screen.main,
    ledger: keep,
    isCurrent: () => current,
    load: () => new Promise((yes) => { resolve = yes; }),
  });
  const before = screen.view.innerHTML;
  current = false;
  resolve(sample);
  await ready;
  assert.equal(screen.view.innerHTML, before);
});

test('mountToday throws on markup without the screen, so the router shows its error', () => {
  assert.throws(() => mountToday({ main: { querySelector: () => null }, load: async () => [] }));
});

/* ---------- Today and This month totals ---------- */

const today = (html) => (html.match(/data-today-total[^>]*>([^<]*)</) ?? [])[1];
const month = (html) => (html.match(/data-month-total[^>]*>([^<]*)</) ?? [])[1];

test('an empty ledger shows both totals as ₹0, labelled Today and This month', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => [] });
  const html = screen.view.innerHTML;
  assert.equal(today(html), '₹0');
  assert.equal(month(html), '₹0');
  assert.match(html, /<span class="total-label">Today<\/span><span class="amount total-amount" data-today-total>/);
  assert.match(html, /<span class="total-label">This month<\/span><span class="amount total-amount" data-month-total>/);
  assert.ok(html.indexOf('today-totals') < html.indexOf('today-empty'), 'totals sit above the prompt');
});

test('the total cards come first in every state and never show NaN or undefined', () => {
  for (const status of ['empty', 'loading', 'error', 'filled']) {
    const html = renderTodayView({ status, entries: status === 'filled' ? sample : [] });
    assert.ok(html.startsWith('<section class="today-totals"'), status);
    assert.doesNotMatch(html, /NaN|undefined/);
  }
  const loading = renderToday();
  assert.match(loading, /class="today-totals" aria-label="Totals" aria-busy="true"/);
  assert.match(loading, /total-skeleton/);
  assert.doesNotMatch(loading, /data-(today|month)-total/);
});

test('a failed load with nothing known shows a dash in both totals, never ₹0', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: keep, load: async () => { throw new Error('disk'); } });
  const html = screen.view.innerHTML;
  assert.match(html, /today-error/);
  assert.doesNotMatch(html, /data-today-total>₹0/);
  assert.doesNotMatch(html, /data-month-total>₹0/);
  assert.doesNotMatch(html, /data-(today|month)-total[^>]*>₹/);
  assert.equal(today(html), '—');
  assert.equal(month(html), '—');
  assert.match(html, /<span class="visually-hidden">not known<\/span>/);
  assert.equal(renderTodayView({ status: 'error' }), renderTodayView({ status: 'error', entries: [] }));
});

test('saving 120 chai then 80 auto shows ₹200 today and ₹200 this month, in the same turn', async () => {
  const screen = fakeScreen();
  const saved = [];
  let nextId = 0;
  const add = async (entry) => {
    saved.push(entry);
    nextId += 1;
    return { ...entry, id: nextId };
  };
  await mountToday({ main: screen.main, ledger: { add }, load: async () => [] });

  type(screen, '120 chai');
  assert.equal(today(screen.view.innerHTML), '₹120');
  assert.equal(month(screen.view.innerHTML), '₹120');
  assert.equal(screen.input.value, '');

  const started = performance.now();
  type(screen, '80 auto');
  assert.ok(performance.now() - started < 100);
  assert.equal(today(screen.view.innerHTML), '₹200');
  assert.equal(month(screen.view.innerHTML), '₹200');

  await tick();
  assert.equal(today(screen.view.innerHTML), '₹200');
  assert.deepEqual(saved.map((entry) => [entry.amountPaise, entry.note]), [[12000, 'chai'], [8000, 'auto']]);
  assert.ok(saved.every((entry) => typeof entry.createdAt === 'number'));
  assert.deepEqual(Object.keys(saved[0]).sort(), ['amountPaise', 'createdAt', 'note']);
});

test('the month total counts earlier days of the month; today counts only today', () => {
  const at = new Date(2026, 8, 30, 10, 0);
  const entries = [
    { id: 1, amountPaise: 12000, note: 'chai', timestamp: at.getTime() },
    { id: 2, amountPaise: 50000, note: 'rent share', timestamp: new Date(2026, 8, 2, 9, 0).getTime() },
    { id: 3, amountPaise: 99900, note: 'last month', timestamp: new Date(2026, 7, 31, 23, 0).getTime() },
  ];
  const html = renderTodayView({ status: 'filled', entries, now: at });
  assert.equal(today(html), '₹120');
  assert.equal(month(html), '₹620');
  assert.match(html, /1 spend</);
  assert.doesNotMatch(html, /rent share|last month/);
  assert.ok(isToday(entries[0], at));
  assert.ok(isToday({ ts: at.getTime() }, at), 'reads ts as totals() does');
  assert.ok(!isToday({ amountPaise: 1 }, at));

  const onlyEarlier = renderTodayView({ status: 'filled', entries: entries.slice(1), now: at });
  assert.equal(month(onlyEarlier), '₹500');
  assert.equal(today(onlyEarlier), '₹0');
  assert.match(onlyEarlier, /today-empty/);
  assert.equal(shownStatus({ status: 'filled', entries: entries.slice(1), now: at }), 'empty');
});

test('a saved spend is not counted twice when Try again loads it back', async () => {
  const screen = fakeScreen();
  const stored = [];
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error('disk');
    return stored.map(fromRecord).reverse();
  };
  const add = async (entry) => {
    const record = { ...entry, id: stored.length + 1 };
    stored.push(record);
    return record;
  };
  await mountToday({ main: screen.main, ledger: { add }, load });
  type(screen, '120 chai');
  await tick();
  clickAction(screen.view, 'retry');
  await tick();
  assert.equal(today(screen.view.innerHTML), '₹120');
  assert.equal(month(screen.view.innerHTML), '₹120');
  assert.match(screen.view.innerHTML, /1 spend</);
});

test('a load that reads the committed spend before its save resolves still counts it once', async () => {
  const screen = fakeScreen();
  const stored = [];
  let finishSave;
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error('disk');
    return stored.map(fromRecord).reverse();
  };
  /* The record commits at once, but the save's promise resolves later. */
  const add = (entry) => {
    const record = { ...entry, id: 1 };
    stored.push(record);
    return new Promise((resolve) => { finishSave = () => resolve(record); });
  };
  await mountToday({ main: screen.main, ledger: { add }, load });
  type(screen, '120 chai');
  clickAction(screen.view, 'retry');
  await tick();
  assert.equal(today(screen.view.innerHTML), '₹120', 'counted once while the save is in flight');
  assert.match(screen.view.innerHTML, /1 spend</);

  finishSave();
  await tick();
  assert.equal(today(screen.view.innerHTML), '₹120');
  assert.match(screen.view.innerHTML, /1 spend</);
});

test('a save that fails takes the spend back out, puts the text back and names it', async () => {
  const screen = fakeScreen();
  await mountToday({ main: screen.main, ledger: { add: async () => { throw new Error('quota'); } }, load: async () => [] });
  type(screen, '120 chai');
  assert.equal(today(screen.view.innerHTML), '₹120');
  await tick();
  assert.equal(today(screen.view.innerHTML), '₹0');
  assert.equal(month(screen.view.innerHTML), '₹0');
  assert.equal(screen.input.value, '120 chai');
  assert.equal(screen.hint.textContent, '₹120 chai was not saved. Press Enter to try again.');
  assert.ok(screen.hint.classList.contains('hint-error'));
  assert.equal(screen.status.textContent, screen.hint.textContent);
});

test('a save that fails while the next line is typed keeps that line and names the lost spend', async () => {
  const screen = fakeScreen();
  let failSave;
  const add = () => new Promise((resolve, reject) => { failSave = () => reject(new Error('quota')); });
  await mountToday({ main: screen.main, ledger: { add }, load: async () => [] });
  type(screen, '120 chai');
  screen.input.value = '80 au';
  failSave();
  await tick();
  assert.equal(screen.input.value, '80 au');
  assert.equal(screen.hint.textContent, '₹120 chai was not saved. Type it again to save it.');
  assert.equal(today(screen.view.innerHTML), '₹0');
  assert.equal(saveFailedHint({ amountPaise: 4550, note: '' }, true), '₹45.5 was not saved. Press Enter to try again.');
});

/* A ledger held in memory: what load() reads back is what updateCategory()
   last wrote, so a re-render from the store can be checked. */
function memoryLedger(records) {
  const calls = [];
  const ledger = {
    add: async () => null,
    async updateCategory(id, category) {
      calls.push([id, category]);
      const record = records.find((item) => item.id === id);
      if (!record) throw new Error('no entry ' + id);
      record.category = category;
      return { ...record };
    },
  };
  const load = async () => records.map((record) => ({ ...record }));
  return { ledger, load, calls };
}

const chai = () => ({ id: 7, amountPaise: 12000, note: 'chai', category: 'Food', timestamp: now });

test('each row shows its category as a chip, named for assistive tech', () => {
  const html = renderTodayView({ status: 'filled', entries: [
    { id: 'a', amountPaise: 12000, note: 'chai', category: 'Health', timestamp: now },
    { id: 'b', amountPaise: 4550, note: 'auto', timestamp: now },
  ] });
  assert.deepEqual(chips(html), { a: 'Health', b: 'Transport' }, 'a spend without a category reads as its note maps');
  assert.match(html, /<button type="button" class="category-chip" data-action="open-category" data-entry-id="a" aria-haspopup="listbox" aria-expanded="false" aria-label="Category: Health. Change category">Health<\/button>/);
  assert.match(html, /entry-amount">₹120<\/span><button type="button" class="category-chip"/);
  assert.doesNotMatch(html, /category-picker/, 'the picker is closed until the chip is tapped');
  assert.equal(categoryOf({ note: 'chai', category: '' }), 'Food');
});

test('tapping the chip opens a picker of every category with the current one marked and focused', async () => {
  const screen = fakeScreen();
  const { ledger, load, calls } = memoryLedger([chai()]);
  await mountToday({ main: screen.main, ledger, load });
  tapChip(screen.view, 7);
  const html = screen.view.innerHTML;
  assert.deepEqual(pickerOptions(html), CATEGORIES.map((name) => [name, name === 'Food']));
  assert.match(html, /<ul class="category-picker" id="category-picker-7" role="listbox" aria-label="Pick a category, now Food">/);
  assert.match(html, /aria-expanded="true" aria-controls="category-picker-7"/);
  assert.match(html, /class="category-option category-option-current" role="option" aria-selected="true" tabindex="0"[^>]*>Food<span class="category-option-mark" aria-hidden="true">✓<\/span><\/button>/);
  assert.equal((html.match(/category-option-mark/g) ?? []).length, 1, 'only the current option carries the tick');
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, CATEGORIES.length - 1, 'Tab reaches the current option; arrows the rest');
  assert.doesNotMatch(html, /Save|Confirm/);
  assert.equal(screen.view.focused, '.category-option-current');
  assert.deepEqual(calls, []);
});

test('the picker styles hold no quoted or raw value, only tokens', async () => {
  const css = await readFile(new URL('../../css/controls.css', import.meta.url), 'utf8');
  const body = css.slice(css.indexOf('.category-chip {'), css.indexOf('/* A new spend arrives'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, value] of body.matchAll(/:\s*([^;{}]+);/g)) {
    assert.doesNotMatch(value, /["']|#[0-9a-f]{3,8}\b|\d(?:px|rem|em|pt)\b/i, value);
  }
});

test('the arrow keys, Home and End move focus through the picker', async () => {
  const screen = fakeScreen();
  const { ledger, load } = memoryLedger([chai()]);
  await mountToday({ main: screen.main, ledger, load });
  tapChip(screen.view, 7);
  const option = (name) => '.category-option[data-category="' + name + '"]';
  assert.ok(keyOnOption(screen.view, 'ArrowDown', 'Food'));
  assert.equal(screen.view.focused, option('Transport'));
  keyOnOption(screen.view, 'ArrowUp', 'Food');
  assert.equal(screen.view.focused, option('Other'), 'wraps round');
  keyOnOption(screen.view, 'ArrowDown', 'Other');
  assert.equal(screen.view.focused, option('Food'));
  keyOnOption(screen.view, 'End', 'Food');
  assert.equal(screen.view.focused, option('Other'));
  keyOnOption(screen.view, 'Home', 'Other');
  assert.equal(screen.view.focused, option('Food'));
  assert.equal(keyOnOption(screen.view, 'a', 'Food'), false, 'other keys pass through');
  assert.match(screen.view.innerHTML, /category-picker/);
});

test('one tap on another category saves it, closes the picker and updates the chip at once', async () => {
  const screen = fakeScreen();
  const records = [chai(), { id: 8, amountPaise: 4550, note: 'auto', category: 'Transport', timestamp: now }];
  const { ledger, load, calls } = memoryLedger(records);
  await mountToday({ main: screen.main, ledger, load });

  tapChip(screen.view, 7);
  tapCategory(screen.view, 7, 'Health');
  assert.deepEqual(calls, [[7, 'Health']], 'written through the store update, once');
  assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
  assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Health', 8: 'Transport' });
  assert.equal(screen.view.focused, '.category-chip[data-entry-id="7"]', 'focus goes back to the chip');
  assert.equal(screen.status.textContent, 'Category set to Health');

  await tick();
  assert.equal(records[0].category, 'Health');
  /* Try again re-renders from the store. */
  clickAction(screen.view, 'retry');
  await tick();
  assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Health', 8: 'Transport' });
  assert.deepEqual(chips(renderTodayView({ status: 'filled', entries: await load() })), { 7: 'Health', 8: 'Transport' });
});

test('tapping the current category or the chip again closes the picker and writes nothing', async () => {
  const screen = fakeScreen();
  const { ledger, load, calls } = memoryLedger([chai()]);
  await mountToday({ main: screen.main, ledger, load });
  tapChip(screen.view, 7);
  tapCategory(screen.view, 7, 'Food');
  assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
  tapChip(screen.view, 7);
  tapChip(screen.view, 7);
  assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
  assert.deepEqual(calls, []);
});

test('Escape or a tap elsewhere in the view closes the picker and leaves the category as it was', async () => {
  const screen = fakeScreen();
  const records = [chai()];
  const { ledger, load, calls } = memoryLedger(records);
  await mountToday({ main: screen.main, ledger, load });

  tapChip(screen.view, 7);
  assert.ok(keyOnOption(screen.view, 'Escape', 'Transport'));
  assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
  assert.equal(screen.view.focused, '.category-chip[data-entry-id="7"]');

  tapChip(screen.view, 7);
  tapBlank(screen.view, true);
  assert.match(screen.view.innerHTML, /category-picker/, 'a tap inside the picker keeps it open');
  tapBlank(screen.view, false);
  assert.doesNotMatch(screen.view.innerHTML, /category-picker/);

  await tick();
  assert.deepEqual(calls, []);
  assert.equal(records[0].category, 'Food');
  assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Food' });
});

test('a tap outside the Today view closes the picker, writes nothing and lets go of the document', async () => {
  await withDocument(async (doc) => {
    const screen = fakeScreen();
    const records = [chai()];
    const { ledger, load, calls } = memoryLedger(records);
    await mountToday({ main: screen.main, ledger, load });
    assert.equal(doc.listeners.size, 0, 'nothing listens until the picker opens');

    tapChip(screen.view, 7);
    assert.deepEqual([...doc.listeners.keys()].sort(), ['keydown', 'pointerdown']);
    doc.dispatch('pointerdown', { target: { insideView: true } });
    assert.match(screen.view.innerHTML, /category-picker/, 'a press inside the view is left to the view');

    doc.dispatch('pointerdown', { target: { insideView: false } });
    assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
    assert.equal(doc.listeners.size, 0);
    await tick();
    assert.deepEqual(calls, []);
    assert.equal(records[0].category, 'Food');
    assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Food' });
  });
});

test('Escape with focus outside the Today view closes the picker and lets go of the document', async () => {
  await withDocument(async (doc) => {
    const screen = fakeScreen();
    const { ledger, load, calls } = memoryLedger([chai()]);
    await mountToday({ main: screen.main, ledger, load });
    tapChip(screen.view, 7);
    doc.dispatch('keydown', { key: 'Tab' });
    assert.match(screen.view.innerHTML, /category-picker/);
    doc.dispatch('keydown', { key: 'Escape' });
    assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
    assert.equal(screen.view.focused, '.category-chip[data-entry-id="7"]');
    assert.equal(doc.listeners.size, 0);
    assert.deepEqual(calls, []);
  });
});

test('once the router replaces the screen, an open picker lets go of the document', async () => {
  await withDocument(async (doc) => {
    const screen = fakeScreen();
    let current = true;
    const { ledger, load, calls } = memoryLedger([chai()]);
    await mountToday({ main: screen.main, ledger, load, isCurrent: () => current });
    tapChip(screen.view, 7);
    const html = screen.view.innerHTML;
    current = false;
    doc.dispatch('pointerdown', { target: { insideView: true } });
    assert.equal(doc.listeners.size, 0);
    assert.equal(screen.view.innerHTML, html, 'the old screen is not redrawn');
    assert.deepEqual(calls, []);
  });
});

test('a load that no longer lists the open picker\'s spend closes it and lets go of the document', async () => {
  await withDocument(async (doc) => {
    const screen = fakeScreen();
    let records = [chai(), { id: 8, amountPaise: 4550, note: 'auto', category: 'Transport', timestamp: now }];
    await mountToday({ main: screen.main, ledger: keep, load: async () => records });
    tapChip(screen.view, 7);
    assert.equal(doc.listeners.size, 2);
    records = [records[1]];
    clickAction(screen.view, 'retry');
    await tick();
    assert.doesNotMatch(screen.view.innerHTML, /category-picker/);
    assert.equal(doc.listeners.size, 0);
    tapChip(screen.view, 8);
    assert.match(screen.view.innerHTML, /id="category-picker-8"/, 'another picker still opens');
  });
});

test('a category write that fails puts the old one back and says so', async () => {
  const screen = fakeScreen();
  const ledger = { add: async () => null, updateCategory: async () => { throw new Error('quota'); } };
  await mountToday({ main: screen.main, ledger, load: async () => [chai()] });
  tapChip(screen.view, 7);
  tapCategory(screen.view, 7, 'Bills');
  assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Bills' });
  await tick();
  assert.deepEqual(chips(screen.view.innerHTML), { 7: 'Food' });
  assert.equal(screen.status.textContent, 'The category for ₹120 chai was not saved.');
});

test('a category picked while the spend is still saving is written once the save resolves', async () => {
  const screen = fakeScreen();
  let finishSave;
  const calls = [];
  const ledger = {
    add: (entry) => new Promise((resolve) => { finishSave = () => resolve({ id: 42, ...entry, category: 'Food' }); }),
    updateCategory: async (id, category) => { calls.push([id, category]); },
  };
  await mountToday({ main: screen.main, ledger, load: async () => [] });
  type(screen, '120 chai');
  assert.deepEqual(chips(screen.view.innerHTML), { 'added-1': 'Food' });
  tapChip(screen.view, 'added-1');
  tapCategory(screen.view, 'added-1', 'Entertainment');
  assert.deepEqual(chips(screen.view.innerHTML), { 'added-1': 'Entertainment' });
  assert.deepEqual(calls, [], 'no id to write to yet');
  finishSave();
  await tick();
  assert.deepEqual(calls, [[42, 'Entertainment']]);
});

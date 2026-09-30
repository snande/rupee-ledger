import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { INVALID_HINT, notSavedHint, startQuickEntry, wireQuickEntry } from './quick-entry.js';
import { formatPaise } from './format-amount.js';
import { add } from './ledger.js';

/* Just enough of a document for the form: elements with children, classes,
   attributes and listeners, and an activeElement that focus() moves. */
function fakeDocument() {
  const doc = { activeElement: null };
  doc.createElement = (tagName) => fakeElement(doc, tagName);
  return doc;
}

function fakeElement(doc, tagName) {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  let text = '';
  const el = {
    tagName: tagName.toUpperCase(),
    ownerDocument: doc,
    parent: null,
    children: [],
    value: '',
    hidden: false,
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
    },
    get textContent() {
      return el.children.length > 0 ? el.children.map((child) => child.textContent).join(' ') : text;
    },
    set textContent(value) {
      el.children = [];
      text = String(value);
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    append(...nodes) {
      for (const node of nodes) { node.parent = el; el.children.push(node); }
    },
    prepend(...nodes) {
      for (const node of nodes) node.parent = el;
      el.children.unshift(...nodes);
    },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((child) => child !== el);
      el.parent = null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn));
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    focus() { doc.activeElement = el; },
  };
  return el;
}

/* The quick-entry form, today's list, the Today total and the hint, with a
   ledger whose writes never settle unless the test settles them. */
function fakeScreen({ add: write } = {}) {
  const doc = fakeDocument();
  const form = doc.createElement('form');
  const input = doc.createElement('input');
  input.setAttribute('id', 'quick-entry');
  const list = doc.createElement('ul');
  list.setAttribute('id', 'today-list');
  const total = doc.createElement('span');
  total.textContent = formatPaise(0);
  const hint = doc.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Amount first, then what it was for';
  form.append(input, hint);

  const calls = [];
  const settles = [];
  const ledger = {
    add: write ?? ((entry) => {
      calls.push(entry);
      return new Promise((resolve, reject) => settles.push({ resolve, reject }));
    }),
  };
  const stop = wireQuickEntry({ form, input, list, total, hint, ledger });
  input.focus();
  return { doc, form, input, list, total, hint, calls, settles, stop };
}

/* Type a line and press Enter: the browser fires submit on the form. */
function enter(screen, text) {
  screen.input.value = text;
  let prevented = false;
  screen.form.dispatchEvent({ type: 'submit', preventDefault: () => { prevented = true; } });
  return prevented;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const rowNote = (row) => row.children[0].textContent;
const rowAmount = (row) => row.children[1].textContent;

test('Enter on 120 chai prepends one chai ₹120 row before the ledger write settles', () => {
  const screen = fakeScreen();
  enter(screen, '120 chai');
  assert.equal(screen.list.children.length, 1);
  const [row] = screen.list.children;
  assert.equal(row.tagName, 'LI');
  assert.equal(rowNote(row), 'chai');
  assert.equal(rowAmount(row), '₹120');
  assert.ok(row.classList.contains('entry-row'));
  assert.ok(row.children[1].classList.contains('amount'));
  assert.equal(screen.settles.length, 1, 'the write is still pending');
});

test('the Today total includes the new amount in the same turn', () => {
  const screen = fakeScreen();
  enter(screen, '120 chai');
  assert.equal(screen.total.textContent, '₹120');
  enter(screen, '80 auto');
  assert.equal(screen.total.textContent, '₹200');
});

test('the total starts from what the Today total already shows', () => {
  const doc = fakeDocument();
  const [form, input, list, total, hint] = ['form', 'input', 'ul', 'span', 'p'].map((tag) => doc.createElement(tag));
  wireQuickEntry({ form, input, list, total, hint, ledger: { add: async () => null }, todayPaise: 50000 });
  input.value = '120 chai';
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(total.textContent, '₹620');
});

test('each valid Enter calls the ledger add once with paise, note and a timestamp', () => {
  const screen = fakeScreen();
  const before = Date.now();
  enter(screen, '120 chai');
  assert.equal(screen.calls.length, 1);
  const [entry] = screen.calls;
  assert.deepEqual(Object.keys(entry).sort(), ['amountPaise', 'createdAt', 'note']);
  assert.equal(entry.amountPaise, 12000);
  assert.equal(entry.note, 'chai');
  assert.equal(typeof entry.createdAt, 'number');
  assert.ok(entry.createdAt >= before && entry.createdAt <= Date.now());
});

test('after Enter the box is empty and keeps focus; three Enters make three rows, newest first', () => {
  const screen = fakeScreen();
  for (const line of ['120 chai', '45.50 auto', '₹30 samosa']) {
    enter(screen, line);
    assert.equal(screen.input.value, '');
    assert.equal(screen.doc.activeElement, screen.input);
  }
  assert.equal(screen.list.children.length, 3);
  assert.deepEqual(screen.list.children.map(rowNote), ['samosa', 'auto', 'chai']);
  assert.deepEqual(screen.list.children.map(rowAmount), ['₹30', '₹45.5', '₹120']);
  assert.equal(screen.calls.length, 3);
  assert.equal(screen.total.textContent, '₹195.5');
});

test('submit calls preventDefault, so Enter never reloads the page', () => {
  const screen = fakeScreen();
  assert.equal(enter(screen, '120 chai'), true);
  assert.equal(enter(screen, 'chai'), true);
  assert.equal(enter(screen, '   '), true);
});

test('a line with no amount keeps its text, adds nothing and shows the sindoor hint inline', () => {
  const dialogs = [];
  const saved = {};
  for (const name of ['alert', 'confirm', 'prompt']) {
    saved[name] = globalThis[name];
    globalThis[name] = () => dialogs.push(name);
  }
  try {
    const screen = fakeScreen();
    const prevented = enter(screen, 'chai');
    assert.equal(prevented, true);
    assert.equal(screen.list.children.length, 0);
    assert.equal(screen.calls.length, 0);
    assert.deepEqual(dialogs, []);
    assert.equal(screen.input.value, 'chai');
    assert.equal(screen.doc.activeElement, screen.input);
    assert.equal(screen.hint.textContent, 'Start with an amount, e.g. 120 chai');
    assert.equal(INVALID_HINT, 'Start with an amount, e.g. 120 chai');
    assert.ok(screen.hint.classList.contains('hint-error'));
    assert.equal(screen.hint.hidden, false);
    assert.equal(screen.input.getAttribute('aria-invalid'), 'true');
    assert.equal(screen.total.textContent, '₹0');

    screen.input.value = '120 chai';
    screen.input.dispatchEvent({ type: 'input' });
    assert.ok(!screen.hint.classList.contains('hint-error'));
    assert.equal(screen.hint.textContent, 'Amount first, then what it was for');
    assert.equal(screen.input.getAttribute('aria-invalid'), null);
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
});

test('the error hint is coloured with the DESIGN.md sindoor token', async () => {
  const design = await readFile(new URL('../DESIGN.md', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../css/tokens.css', import.meta.url), 'utf8');
  const css = await readFile(new URL('../css/controls.css', import.meta.url), 'utf8');
  const hex = design.match(/`sindoor` `(#[0-9A-Fa-f]{6})`/)[1];
  assert.match(tokens, new RegExp('--color-sindoor:\\s*' + hex + ';', 'i'));
  assert.match(css, /\n\.hint-error \{[^}]*color: var\(--color-sindoor\);[^}]*\}/);
});

test('a valid Enter clears an earlier error hint', () => {
  const screen = fakeScreen();
  enter(screen, 'chai');
  enter(screen, '120 chai');
  assert.ok(!screen.hint.classList.contains('hint-error'));
  assert.equal(screen.hint.textContent, 'Amount first, then what it was for');
});

test('an empty Enter does nothing but keep focus', () => {
  const screen = fakeScreen();
  enter(screen, '   ');
  assert.equal(screen.list.children.length, 0);
  assert.equal(screen.calls.length, 0);
  assert.ok(!screen.hint.classList.contains('hint-error'));
  assert.equal(screen.doc.activeElement, screen.input);
});

test('a note is text, never markup, and a spend with no note reads No note', () => {
  const screen = fakeScreen();
  enter(screen, '10 <b>tea</b>');
  assert.equal(rowNote(screen.list.children[0]), '<b>tea</b>');
  assert.equal(screen.list.children[0].children[0].children.length, 0);
  enter(screen, '15');
  assert.equal(rowNote(screen.list.children[0]), 'No note');
  assert.ok(screen.list.children[0].children[0].classList.contains('entry-note-empty'));
});

test('a write that resolves leaves the row and total as drawn', async () => {
  const screen = fakeScreen();
  enter(screen, '120 chai');
  screen.settles[0].resolve({ id: 1 });
  await tick();
  assert.equal(screen.list.children.length, 1);
  assert.equal(screen.total.textContent, '₹120');
});

test('a write that fails takes the row and amount back out and names the spend', async () => {
  const screen = fakeScreen();
  enter(screen, '120 chai');
  enter(screen, '80 auto');
  screen.settles[0].reject(new Error('quota'));
  await tick();
  assert.deepEqual(screen.list.children.map(rowNote), ['auto']);
  assert.equal(screen.total.textContent, '₹80');
  assert.equal(screen.hint.textContent, '₹120 chai was not saved. Type it again to save it.');
  assert.ok(screen.hint.classList.contains('hint-error'));
  assert.equal(notSavedHint({ amountPaise: 4550, note: '' }), '₹45.5 was not saved. Type it again to save it.');
});

test('a ledger add that throws synchronously is reported the same way', async () => {
  const screen = fakeScreen({ add: () => { throw new Error('bad'); } });
  enter(screen, '120 chai');
  assert.equal(screen.list.children.length, 1, 'drawn before the write is tried');
  await tick();
  assert.equal(screen.list.children.length, 0);
  assert.equal(screen.total.textContent, '₹0');
});

test('the stop function unwires the form', () => {
  const screen = fakeScreen();
  screen.stop();
  enter(screen, '120 chai');
  assert.equal(screen.list.children.length, 0);
  assert.equal(screen.calls.length, 0);
});

test('wireQuickEntry refuses incomplete markup, and it defaults to the real ledger add', async () => {
  assert.throws(() => wireQuickEntry({}), /incomplete/);
  const source = await readFile(new URL('./quick-entry.js', import.meta.url), 'utf8');
  assert.match(source, /import \* as ledgerModule from '\.\/ledger\.js';/);
  assert.match(source, /ledger = ledgerModule,/);
  assert.equal(typeof add, 'function');
});

test('startQuickEntry wires only marked forms that have a #today-list, never the Today screen form', () => {
  const doc = fakeDocument();
  const list = doc.createElement('ul');
  const total = doc.createElement('span');
  const input = doc.createElement('input');
  const hint = doc.createElement('p');
  const form = doc.createElement('form');
  form.querySelector = (selector) => ({ '#quick-entry': input, '.hint': hint })[selector] ?? null;
  let marked = [form];
  doc.getElementById = (id) => (id === 'today-list' ? list : null);
  doc.querySelector = (selector) => (selector === '[data-today-total]' ? total : null);
  doc.querySelectorAll = (selector) => (selector === 'form[data-quick-entry]' ? marked : []);

  const stops = startQuickEntry(doc);
  assert.equal(stops.length, 1);
  stops[0]();

  marked = [];
  assert.deepEqual(startQuickEntry(doc), []);
  doc.getElementById = () => null;
  marked = [form];
  assert.deepEqual(startQuickEntry(doc), [], 'no #today-list, nothing to fill');
});

test('the module formats through formatPaise, writes through ledger add, and needs no network or library', async () => {
  const source = await readFile(new URL('./quick-entry.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import \{ formatPaise \} from '\.\/format-amount\.js';/);
  assert.match(code, /import \{ parseEntry \} from '\.\/parse-entry\.js';/);
  assert.match(code, /ledger\.add\(entry\)/);
  for (const [, specifier] of code.matchAll(/\bfrom\s*'([^']+)'/g)) {
    assert.ok(specifier.startsWith('./'), specifier + ' is not a local module');
  }
  assert.doesNotMatch(code, /\bimport\s*\(/);
  assert.doesNotMatch(code, /Intl\.NumberFormat|toLocaleString|formatRupees|indexedDB|localStorage/);
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|https?:\/\//);
  assert.doesNotMatch(code, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(code, /\bawait\b/, 'nothing waits before the render');
});

test('index.html loads the module', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="src\/quick-entry\.js"><\/script>/);
});

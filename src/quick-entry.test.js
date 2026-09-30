import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { INVALID_HINT, showHint, spendLabel, wireQuickEntry } from './quick-entry.js';
import { formatPaise } from './format-amount.js';
import { add } from './ledger.js';
import { ENTRY_HINT, mountToday, renderToday } from '../js/screens/today.js';

/* ---------- A small DOM, enough to run the real Today screen ---------- */

/* It parses the markup renderToday() produces, answers simple selectors
   (tag, #id, .class, [attr], [attr="value"] and compounds of them), keeps
   classes in the class attribute, bubbles events and moves activeElement
   on focus(). No library, so `npm test` needs nothing installed. */

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name]);
const encode = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class TextNode {
  constructor(data) {
    this.data = data;
    this.parent = null;
  }

  get textContent() {
    return this.data;
  }
}

class Element {
  constructor(doc, tagName, attrs = new Map()) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.parent = null;
    this.nodes = [];
    this.listeners = new Map();
    this.value = attrs.get('value') ?? '';
    this.offsetWidth = 0;
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }

  get classList() {
    const names = () => (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (list) => this.setAttribute('class', list.join(' '));
    const list = {
      contains: (name) => names().includes(name),
      add: (name) => { if (!list.contains(name)) write([...names(), name]); },
      remove: (name) => write(names().filter((item) => item !== name)),
      toggle: (name, on = !list.contains(name)) => (on ? list.add(name) : list.remove(name)),
    };
    return list;
  }

  get children() { return this.nodes.filter((node) => node instanceof Element); }

  get textContent() { return this.nodes.map((node) => node.textContent).join(''); }
  set textContent(value) {
    this.nodes = [];
    if (String(value) !== '') this.append(new TextNode(String(value)));
  }

  get innerHTML() { return this.nodes.map(serialize).join(''); }
  set innerHTML(html) {
    this.nodes = [];
    parseInto(this, String(html));
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.nodes.push(node);
    }
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector) {
    const matches = matcher(selector);
    return [...this.descendants()].filter(matches);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  closest(selector) {
    const matches = matcher(selector);
    for (let el = this; el instanceof Element; el = el.parent) if (matches(el)) return el;
    return null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (let el = this; el instanceof Element; el = el.parent) {
      for (const fn of el.listeners.get(event.type) ?? []) fn(event);
    }
  }

  focus() { this.ownerDocument.activeElement = this; }
}

function serialize(node) {
  if (node instanceof TextNode) return encode(node.data);
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attrs].map(([name, value]) => (value === '' ? ' ' + name : ' ' + name + '="' + value.replace(/"/g, '&quot;') + '"')).join('');
  return '<' + tag + attrs + '>' + (VOID.has(tag) ? '' : node.innerHTML + '</' + tag + '>');
}

const TOKEN = /<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;

/* Throws on markup it cannot read, such as a stray or mismatched close tag,
   so a broken template fails here rather than passing quietly. */
function parseInto(container, html) {
  const stack = [container];
  let consumed = 0;
  for (const match of html.matchAll(TOKEN)) {
    assert.equal(match.index, consumed, 'unreadable markup at ' + JSON.stringify(html.slice(consumed, consumed + 40)));
    consumed += match[0].length;
    const [, close, open, attrText, text] = match;
    const top = stack[stack.length - 1];
    if (close) {
      assert.equal(top.tagName, close.toUpperCase(), 'mismatched </' + close + '>');
      stack.pop();
    } else if (open) {
      const attrs = new Map();
      for (const [, name, value = ''] of attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs.set(name, decode(value));
      const el = new Element(container.ownerDocument, open.toLowerCase(), attrs);
      top.append(el);
      if (!VOID.has(open.toLowerCase())) stack.push(el);
    } else {
      top.append(new TextNode(decode(text)));
    }
  }
  assert.equal(consumed, html.length, 'unreadable markup at the end');
  assert.equal(stack.length, 1, 'unclosed <' + stack[stack.length - 1].tagName + '>');
}

const PART = /^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i;

function matcher(selector) {
  const match = PART.exec(selector.trim());
  if (!match) throw new Error('unsupported selector ' + selector);
  const [, tag, rest] = match;
  const tests = [];
  if (tag) tests.push((el) => el.tagName === tag.toUpperCase());
  for (const [part] of rest.matchAll(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g)) {
    if (part[0] === '#') tests.push((el) => el.getAttribute('id') === part.slice(1));
    else if (part[0] === '.') tests.push((el) => el.classList.contains(part.slice(1)));
    else {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      tests.push((el) => el.hasAttribute(name) && (value === undefined || el.getAttribute(name) === value));
    }
  }
  return (el) => tests.every((fn) => fn(el));
}

/* ---------- The real Today screen, mounted on that DOM ---------- */

const NOW = Date.now();

/* A ledger whose writes stay pending until the test settles them. */
function pendingLedger() {
  const calls = [];
  const settles = [];
  return {
    calls,
    settles,
    add(entry) {
      calls.push(entry);
      return new Promise((resolve, reject) => settles.push({ resolve, reject }));
    },
  };
}

async function realToday(entries = []) {
  const doc = { activeElement: null };
  const main = new Element(doc, 'main');
  main.setAttribute('id', 'screen');
  main.innerHTML = renderToday();
  const ledger = pendingLedger();
  await mountToday({ main, load: async () => entries, ledger });
  return { doc, main, ledger, input: main.querySelector('#quick-entry') };
}

/* Type a line and press Enter: the browser fires submit on the form. */
function pressEnter(main, text) {
  const input = main.querySelector('#quick-entry');
  input.value = text;
  let prevented = false;
  input.closest('form').dispatchEvent({ type: 'submit', preventDefault: () => { prevented = true; } });
  return prevented;
}

const rows = (main) => main.querySelector('#today-list')?.querySelectorAll('li') ?? [];
const note = (row) => row.querySelector('.entry-note').textContent;
const amount = (row) => row.querySelector('.entry-amount').textContent;
const todayTotal = (main) => main.querySelector('[data-today-total]').textContent;

test('the rendered Today screen carries the quick-entry form, #quick-entry and its hint', async () => {
  const { main, doc, input } = await realToday();
  const form = main.querySelector('form[data-today-form]');
  assert.ok(form, 'the quick-entry form is rendered');
  assert.equal(input.closest('form'), form);
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(form.querySelector('#quick-entry-hint').textContent, ENTRY_HINT);
  assert.equal(doc.activeElement, input, 'the box has focus on open');
});

test('on the real screen, Enter on 120 chai puts chai ₹120 at the top of #today-list before the write settles', async () => {
  const earlier = { id: 1, amountPaise: 50000, note: 'rent share', timestamp: NOW - 1 };
  const { main, ledger } = await realToday([earlier]);
  assert.equal(todayTotal(main), '₹500');
  assert.equal(rows(main).length, 1);

  const prevented = pressEnter(main, '120 chai');

  assert.equal(prevented, true, 'no page reload');
  const list = rows(main);
  assert.equal(list.length, 2, 'one row added');
  assert.equal(note(list[0]), 'chai');
  assert.equal(amount(list[0]), '₹120');
  assert.equal(amount(list[0]), formatPaise(12000));
  assert.equal(note(list[1]), 'rent share');
  assert.equal(todayTotal(main), '₹620', 'the Today total adds to what was already spent');
  assert.equal(ledger.settles.length, 1, 'the write is still pending');
});

test('on the real screen, Enter writes through add once with paise, note and createdAt', async () => {
  const { main, ledger } = await realToday();
  const before = Date.now();
  pressEnter(main, '120 chai');
  assert.equal(ledger.calls.length, 1);
  const [entry] = ledger.calls;
  assert.deepEqual(Object.keys(entry).sort(), ['amountPaise', 'createdAt', 'note']);
  assert.equal(entry.amountPaise, 12000);
  assert.equal(entry.note, 'chai');
  assert.equal(typeof entry.createdAt, 'number');
  assert.ok(entry.createdAt >= before && entry.createdAt <= Date.now());
});

test('on the real screen, the box empties and keeps focus, and three Enters from an empty day make three rows', async () => {
  const { main, doc, input, ledger } = await realToday();
  assert.equal(main.querySelector('#today-list'), null, 'an empty day has no list yet');
  for (const line of ['120 chai', '45.50 auto', '₹30 samosa']) {
    pressEnter(main, line);
    assert.equal(input.value, '');
    assert.equal(doc.activeElement, input);
  }
  assert.deepEqual(rows(main).map(note), ['samosa', 'auto', 'chai']);
  assert.deepEqual(rows(main).map(amount), ['₹30', '₹45.5', '₹120']);
  assert.equal(todayTotal(main), '₹195.5');
  assert.equal(ledger.calls.length, 3);
});

test('on the real screen, a line with no amount keeps its text and shows the sindoor hint, with no dialog', async () => {
  const dialogs = [];
  const saved = {};
  for (const name of ['alert', 'confirm', 'prompt']) {
    saved[name] = globalThis[name];
    globalThis[name] = () => dialogs.push(name);
  }
  try {
    const earlier = { id: 1, amountPaise: 12000, note: 'chai', timestamp: NOW - 1 };
    const { main, doc, input, ledger } = await realToday([earlier]);
    const view = main.querySelector('[data-today-view]').innerHTML;

    assert.equal(pressEnter(main, 'chai'), true);

    assert.equal(main.querySelector('[data-today-view]').innerHTML, view, 'no row added');
    assert.equal(ledger.calls.length, 0);
    assert.deepEqual(dialogs, []);
    assert.equal(input.value, 'chai');
    assert.equal(doc.activeElement, input);
    const hint = main.querySelector('#quick-entry-hint');
    assert.equal(hint.textContent, 'Start with an amount, e.g. 120 chai');
    assert.ok(hint.classList.contains('hint-error'), 'coloured by the .hint-error rule');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(main.querySelector('[data-entry-status]').textContent, INVALID_HINT);
  } finally {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
});

test('on the real screen, a write that fails takes the row back out and names the spend', async () => {
  const { main, input, ledger } = await realToday();
  pressEnter(main, '120 chai');
  ledger.settles[0].reject(new Error('quota'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows(main).length, 0);
  assert.equal(todayTotal(main), '₹0');
  assert.equal(input.value, '120 chai');
  assert.equal(main.querySelector('#quick-entry-hint').textContent, '₹120 chai was not saved. Press Enter to try again.');
});

test('the error hint is coloured with the DESIGN.md sindoor token', async () => {
  const design = await readFile(new URL('../DESIGN.md', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../css/tokens.css', import.meta.url), 'utf8');
  const css = await readFile(new URL('../css/controls.css', import.meta.url), 'utf8');
  const hex = design.match(/`sindoor` `(#[0-9A-Fa-f]{6})`/)[1];
  assert.match(tokens, new RegExp('--color-sindoor:\\s*' + hex + ';', 'i'));
  assert.match(css, /\n\.hint-error \{[^}]*color: var\(--color-sindoor\);[^}]*\}/);
});

/* ---------- wireQuickEntry on its own ---------- */

function bareForm(ledger = pendingLedger()) {
  const doc = { activeElement: null };
  const form = new Element(doc, 'form');
  const input = new Element(doc, 'input');
  const hint = new Element(doc, 'p');
  hint.textContent = 'Amount first';
  form.append(input, hint);
  const order = [];
  const outcomes = [];
  const draw = (entry, text) => {
    order.push('draw');
    const outcome = { entry, text, saved: [], failed: [] };
    outcomes.push(outcome);
    return {
      saved: (stored) => outcome.saved.push(stored),
      failed: (error) => outcome.failed.push(error),
    };
  };
  const counted = { add: (entry) => { order.push('add'); return ledger.add(entry); } };
  wireQuickEntry({ form, input, hint, draw, ledger: counted, now: () => 1234 });
  const enter = (text) => {
    input.value = text;
    let prevented = false;
    form.dispatchEvent({ type: 'submit', preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { doc, form, input, hint, ledger, order, outcomes, enter };
}

test('a valid Enter draws first, then calls add without waiting, then clears and refocuses', () => {
  const form = bareForm();
  assert.equal(form.enter('120 chai'), true);
  assert.deepEqual(form.order, ['draw', 'add']);
  assert.deepEqual(form.outcomes[0].entry, { amountPaise: 12000, note: 'chai', createdAt: 1234 });
  assert.equal(form.outcomes[0].text, '120 chai');
  assert.deepEqual(form.ledger.calls, [{ amountPaise: 12000, note: 'chai', createdAt: 1234 }]);
  assert.equal(form.ledger.calls[0], form.outcomes[0].entry, 'add gets the entry that was drawn');
  assert.equal(form.input.value, '');
  assert.equal(form.doc.activeElement, form.input);
});

test('the settled write is reported to what draw returned', async () => {
  const form = bareForm();
  form.enter('120 chai');
  form.enter('80 auto');
  form.ledger.settles[0].resolve({ id: 7 });
  form.ledger.settles[1].reject(new Error('quota'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(form.outcomes[0].saved, [{ id: 7 }]);
  assert.deepEqual(form.outcomes[0].failed, []);
  assert.equal(form.outcomes[1].failed[0].message, 'quota');
});

test('an add that throws synchronously is still drawn first and reported as failed', async () => {
  const form = bareForm({ add: () => { throw new Error('bad'); } });
  form.enter('120 chai');
  assert.equal(form.input.value, '');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(form.outcomes[0].failed[0].message, 'bad');
});

test('an invalid line sets the sindoor hint; a valid one puts the resting hint back', () => {
  const form = bareForm();
  form.enter('chai');
  assert.deepEqual(form.order, []);
  assert.equal(form.input.value, 'chai');
  assert.equal(form.hint.textContent, INVALID_HINT);
  assert.ok(form.hint.classList.contains('hint-error'));
  form.enter('120 chai');
  assert.equal(form.hint.textContent, 'Amount first');
  assert.ok(!form.hint.classList.contains('hint-error'));
  assert.equal(form.input.getAttribute('aria-invalid'), null);
});

test('an empty Enter only keeps focus', () => {
  const form = bareForm();
  assert.equal(form.enter('   '), true);
  assert.deepEqual(form.order, []);
  assert.equal(form.hint.textContent, 'Amount first');
  assert.equal(form.doc.activeElement, form.input);
});

test('helpers: spendLabel uses formatPaise, showHint marks the box, and incomplete parts are refused', () => {
  assert.equal(spendLabel({ amountPaise: 12000, note: 'chai' }), '₹120 chai');
  assert.equal(spendLabel({ amountPaise: 4550, note: '' }), formatPaise(4550));
  const doc = { activeElement: null };
  const hint = new Element(doc, 'p');
  const input = new Element(doc, 'input');
  showHint(hint, input, 'x', true);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.throws(() => wireQuickEntry({}), /incomplete/);
  assert.throws(() => wireQuickEntry({ form: hint, input, hint }), /incomplete/, 'draw is required');
});

test('the module formats through formatPaise, writes through ledger add, and needs no network or library', async () => {
  const source = await readFile(new URL('./quick-entry.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import \{ parseEntry \} from '\.\/parse-entry\.js';/);
  assert.match(code, /import \{ formatPaise \} from '\.\/format-amount\.js';/);
  assert.match(code, /import \* as ledgerModule from '\.\/ledger\.js';/);
  assert.match(code, /ledger = ledgerModule,/);
  assert.match(code, /ledger\.add\(entry\)/);
  assert.equal(typeof add, 'function');
  for (const [, specifier] of code.matchAll(/\bfrom\s*'([^']+)'/g)) {
    assert.ok(specifier.startsWith('./'), specifier + ' is not a local module');
  }
  assert.doesNotMatch(code, /\bimport\s*\(/);
  assert.doesNotMatch(code, /Intl\.NumberFormat|toLocaleString|formatRupees|indexedDB|localStorage/);
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|https?:\/\//);
  assert.doesNotMatch(code, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(code, /\bawait\b|\basync\b/, 'nothing waits before the render');
});

test('the Today screen submits only through wireQuickEntry, with no second save path or formatter', async () => {
  const today = await readFile(new URL('../js/screens/today.js', import.meta.url), 'utf8');
  const data = await readFile(new URL('../js/data/ledger.js', import.meta.url), 'utf8');
  assert.match(today, /wireQuickEntry\(\{/);
  assert.doesNotMatch(today, /addEventListener\('submit'/);
  assert.doesNotMatch(today, /formatRupees|Intl\.NumberFormat/);
  assert.doesNotMatch(data, /saveEntry/);
});

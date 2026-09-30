import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { QUICK_ENTRY_HINT, wireQuickEntry } from './quick-entry.js';
import { formatPaise } from './format-amount.js';

/* Any alert, confirm or prompt the handler shows is recorded here. The
   originals are put back once this file's tests are done. */
const DIALOGS = ['alert', 'confirm', 'prompt'];
const originals = new Map();
let dialogs = [];

before(() => {
  for (const name of DIALOGS) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globalThis[name] = (text) => { dialogs.push(text); };
  }
});

after(() => {
  for (const name of DIALOGS) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

/* Just enough of an element for the handler: attributes, classes, events. */
function fakeElement() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = new Map();
  return {
    textContent: '',
    value: '',
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
}

/* A box whose focus is tracked like document.activeElement, and a list the
   onEntry render prepends rows to, as a `note ₹amount` pair. */
function fakeBox({ add, onSaving } = {}) {
  dialogs = [];
  const doc = { activeElement: null };
  const form = fakeElement();
  const input = fakeElement();
  input.focus = () => { doc.activeElement = input; };
  const hint = fakeElement();
  const rows = [];
  let total = 0;
  const calls = [];
  wireQuickEntry({
    form,
    input,
    hint,
    add: add ?? ((entry) => { calls.push(entry); return new Promise(() => {}); }),
    onSaving,
    onEntry: (entry) => {
      rows.unshift({ note: entry.note, amount: formatPaise(entry.amountPaise) });
      total += entry.amountPaise;
    },
  });
  input.focus();
  const submit = (text) => {
    input.value = text;
    let prevented = false;
    form.dispatch('submit', { preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { doc, input, hint, rows, calls, submit, total: () => total };
}

test('120 chai prepends a chai ₹120 row and adds to the total before the write settles', () => {
  const box = fakeBox();
  const start = Date.now();
  const prevented = box.submit('120 chai');

  assert.equal(prevented, true, 'no navigation or reload');
  assert.deepEqual(box.rows, [{ note: 'chai', amount: '₹120' }]);
  assert.equal(box.total(), 12000);
  assert.equal(box.calls.length, 1);
  const [written] = box.calls;
  assert.deepEqual({ ...written, createdAt: 0 }, { amountPaise: 12000, note: 'chai', createdAt: 0 });
  assert.ok(Number.isSafeInteger(written.createdAt) && written.createdAt >= start && written.createdAt <= Date.now());
  assert.equal(box.input.value, '');
  assert.equal(box.doc.activeElement, box.input);
});

test('three type-and-Enter submits give three rows, newest first, and three writes', () => {
  const box = fakeBox();
  box.submit('120 chai');
  box.submit('45.50 auto');
  box.submit('₹80 lunch');
  assert.deepEqual(box.rows.map((row) => row.note), ['lunch', 'auto', 'chai']);
  assert.deepEqual(box.rows.map((row) => row.amount), ['₹80', '₹45.5', '₹120']);
  assert.equal(box.total(), 24550);
  assert.equal(box.calls.length, 3);
  assert.equal(box.input.value, '');
  assert.equal(box.doc.activeElement, box.input);
});

test('a line with no amount keeps its text and shows the sindoor hint, writing nothing', async () => {
  const box = fakeBox();
  const prevented = box.submit('chai');
  assert.equal(prevented, true);
  assert.deepEqual(box.rows, []);
  assert.equal(box.calls.length, 0);
  assert.deepEqual(dialogs, []);
  assert.equal(box.input.value, 'chai');
  assert.equal(box.hint.textContent, 'Start with an amount, e.g. 120 chai');
  assert.equal(QUICK_ENTRY_HINT, 'Start with an amount, e.g. 120 chai');
  assert.ok(box.hint.classList.contains('hint-error'));
  assert.equal(box.input.getAttribute('aria-invalid'), 'true');

  const css = await readFile(new URL('../css/controls.css', import.meta.url), 'utf8');
  assert.match(css, /\.hint-error \{\s*color: var\(--color-sindoor\);/);
});

test('an empty Enter lists and writes nothing', () => {
  const box = fakeBox();
  box.submit('   ');
  assert.deepEqual(box.rows, []);
  assert.equal(box.calls.length, 0);
  assert.equal(box.hint.textContent, '');
});

test('the write is handed back unawaited; a failed one is named in the hint by default', async () => {
  let reject;
  const box = fakeBox({ add: () => new Promise((yes, no) => { reject = no; }) });
  box.submit('120 chai');
  assert.equal(box.rows.length, 1, 'shown before the write settles');
  reject(new Error('quota'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(box.hint.classList.contains('hint-error'));
  assert.match(box.hint.textContent, /not saved/);
});

test('the module is vanilla JS: writes through ledger.js add, formats nothing itself, no network', async () => {
  const source = await readFile(new URL('./quick-entry.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./ledger.js', './parse-entry.js']);
  assert.match(source, /import \{ add as ledgerAdd \} from '\.\/ledger\.js';/);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|indexedDB)\b/);
  assert.doesNotMatch(source, /Intl\.NumberFormat|toLocaleString/);
});

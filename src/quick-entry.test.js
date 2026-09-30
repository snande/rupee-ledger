import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { QUICK_ENTRY_HINT, wireQuickEntry } from './quick-entry.js';
import { formatPaise } from './format-amount.js';

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
function fakeBox({ add } = {}) {
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
  const prevented = box.submit('120 chai');

  assert.equal(prevented, true, 'preventDefault was called');
  assert.equal(box.rows.length, 1, 'one row');
  assert.equal(box.rows[0].note, 'chai', 'row note');
  assert.equal(box.rows[0].amount, '₹120', 'row amount');
  assert.equal(box.total(), 12000, 'total in paise');
  assert.equal(box.calls.length, 1, 'add called once');
  const [written] = box.calls;
  assert.equal(written.amountPaise, 12000, 'written amountPaise');
  assert.equal(written.note, 'chai', 'written note');
  assert.equal(typeof written.createdAt, 'number', 'createdAt is a number');
  assert.ok(Number.isSafeInteger(written.createdAt) && written.createdAt > 0, 'createdAt is an epoch timestamp');
  assert.deepEqual(Object.keys(written).sort(), ['amountPaise', 'createdAt', 'note'], 'written fields');
  assert.equal(box.input.value, '', 'box cleared');
  assert.equal(box.doc.activeElement, box.input, 'box keeps focus');
});

test('three type-and-Enter submits give three rows, newest first, and three writes', () => {
  const box = fakeBox();
  box.submit('120 chai');
  box.submit('45.50 auto');
  box.submit('₹80 lunch');
  assert.equal(box.rows.map((row) => row.note).join(','), 'lunch,auto,chai', 'newest row first');
  assert.equal(box.rows[1].amount, formatPaise(4550), 'rows use formatPaise');
  assert.equal(box.total(), 24550, 'total in paise');
  assert.equal(box.calls.length, 3, 'three writes');
  assert.equal(box.input.value, '', 'box cleared');
  assert.equal(box.doc.activeElement, box.input, 'box keeps focus');
});

test('a line with no amount keeps its text and shows the sindoor hint, writing nothing', async () => {
  /* Any alert, confirm or prompt is recorded, and the originals put back. */
  const dialogs = [];
  const originals = ['alert', 'confirm', 'prompt'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name] of originals) globalThis[name] = (text) => { dialogs.push(text); };
  try {
    const box = fakeBox();
    const prevented = box.submit('chai');
    assert.equal(prevented, true, 'preventDefault was called');
    assert.equal(box.rows.length, 0, 'no row');
    assert.equal(box.calls.length, 0, 'add not called');
    assert.equal(dialogs.length, 0, 'no dialog');
    assert.equal(box.input.value, 'chai', 'text kept');
    assert.equal(box.hint.textContent, 'Start with an amount, e.g. 120 chai', 'hint text');
    assert.equal(QUICK_ENTRY_HINT, 'Start with an amount, e.g. 120 chai', 'exported hint text');
    assert.ok(box.hint.classList.contains('hint-error'), 'hint has the hint-error class');
    assert.equal(box.input.getAttribute('aria-invalid'), 'true', 'box marked invalid');
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }

  const css = await readFile(new URL('../css/controls.css', import.meta.url), 'utf8');
  assert.ok(/\.hint-error \{\s*color: var\(--color-sindoor\);/.test(css), '.hint-error is drawn in the sindoor token');
});

test('an empty Enter lists and writes nothing', () => {
  const box = fakeBox();
  box.submit('   ');
  assert.equal(box.rows.length, 0, 'no row');
  assert.equal(box.calls.length, 0, 'add not called');
  assert.equal(box.hint.textContent, '', 'no hint');
});

test('the write is handed back unawaited; a failed one is named in the hint by default', async () => {
  let reject;
  const box = fakeBox({ add: () => new Promise((yes, no) => { reject = no; }) });
  box.submit('120 chai');
  assert.equal(box.rows.length, 1, 'shown before the write settles');
  reject(new Error('quota'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(box.hint.classList.contains('hint-error'), 'failure hint is sindoor');
  assert.ok(box.hint.textContent.includes('not saved'), 'failure hint says not saved');
});

test('the module is vanilla JS: writes through ledger.js add, formats nothing itself, no network', async () => {
  const source = await readFile(new URL('./quick-entry.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.equal(imports.join(','), './ledger.js,./parse-entry.js', 'only parse-entry and ledger are imported');
  assert.ok(source.includes("import { add as ledgerAdd } from './ledger.js';"), 'add comes from ledger.js');
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|indexedDB)\b/.test(source), 'no network or storage calls');
  assert.ok(!/Intl\.NumberFormat|toLocaleString/.test(source), 'no second formatter');
});

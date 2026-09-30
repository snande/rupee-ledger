// Wires a quick-entry form: Enter parses the typed line with `parseEntry`,
// puts the spend at the top of today's list and into the Today total in the
// same turn, then hands it to the ledger's `add` without waiting for the
// write, so the screen never pauses on storage. A line with no leading
// amount keeps its text and shows an inline sindoor hint, never a dialog.
//
// Amounts are shown only through `formatPaise` and written only through
// `add` in ./ledger.js; this module keeps no formatter or store of its own
// and makes no network request.
//
// Loaded from index.html, it wires each `form[data-quick-entry]` on the page
// that has a `#today-list` to fill. The Today screen's own form carries no
// such marker, since js/screens/today.js already saves what is typed there,
// and one Enter must never write a spend twice.

import { parseEntry } from './parse-entry.js';
import { formatPaise } from './format-amount.js';
import * as ledgerModule from './ledger.js';

export const INVALID_HINT = 'Start with an amount, e.g. 120 chai';

/* What the hint says when a write fails, naming the spend so it can be
   typed again; the row and its amount come back out of the screen. */
export function notSavedHint(entry) {
  return formatPaise(entry.amountPaise) + (entry.note ? ' ' + entry.note : '') +
    ' was not saved. Type it again to save it.';
}

/* One `note ₹amount` row, built with textContent so a note is never markup. */
function entryRow(doc, entry) {
  const row = doc.createElement('li');
  row.className = 'entry-row entry-new';
  const note = doc.createElement('span');
  note.className = entry.note ? 'entry-note' : 'entry-note entry-note-empty';
  note.textContent = entry.note || 'No note';
  const amount = doc.createElement('span');
  amount.className = 'amount entry-amount';
  amount.textContent = formatPaise(entry.amountPaise);
  row.append(note, amount);
  return row;
}

/**
 * Listens for submit on `form`. Returns a function that stops listening.
 * @param {{ form: Element, input: HTMLInputElement, list: Element,
 *   total: Element, hint: Element,
 *   ledger?: { add: (entry: { amountPaise: number, note: string,
 *     createdAt: number }) => Promise<unknown> },
 *   now?: () => number, todayPaise?: number }} parts
 *   `list` is `#today-list`, `total` the Today total's amount, `hint` the
 *   line under the box; `todayPaise` is what the Today total already shows.
 */
export function wireQuickEntry({
  form,
  input,
  list,
  total,
  hint,
  ledger = ledgerModule,
  now = Date.now,
  todayPaise = 0,
}) {
  if (!form || !input || !list || !total || !hint) {
    throw new Error('The quick-entry markup is incomplete.');
  }
  const doc = list.ownerDocument;
  const restingHint = hint.textContent;
  let sum = todayPaise;

  const setHint = (text, invalid) => {
    hint.textContent = text;
    hint.classList.toggle('hint-error', invalid);
    if (invalid) {
      hint.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  };

  const showTotal = () => {
    total.textContent = formatPaise(sum);
  };

  /* Nothing here awaits the write: the row and total are already drawn. */
  const persist = (entry, row) => {
    let saving;
    try {
      saving = Promise.resolve(ledger.add(entry));
    } catch (error) {
      saving = Promise.reject(error);
    }
    saving.catch(() => {
      row.remove();
      sum -= entry.amountPaise;
      showTotal();
      setHint(notSavedHint(entry), true);
    });
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const text = input.value;
    if (text.trim() === '') {
      input.focus();
      return;
    }
    const parsed = parseEntry(text);
    if (!parsed) {
      setHint(INVALID_HINT, true);
      input.focus();
      return;
    }
    const entry = { amountPaise: parsed.amountPaise, note: parsed.note, createdAt: now() };
    const row = entryRow(doc, entry);
    list.prepend(row);
    sum += entry.amountPaise;
    showTotal();
    input.value = '';
    setHint(restingHint, false);
    input.focus();
    persist(entry, row);
  };

  const onInput = () => {
    if (hint.classList.contains('hint-error')) setHint(restingHint, false);
  };

  form.addEventListener('submit', onSubmit);
  input.addEventListener('input', onInput);
  return () => {
    form.removeEventListener('submit', onSubmit);
    input.removeEventListener('input', onInput);
  };
}

/* Wires every `form[data-quick-entry]` in `doc` whose parts are all there.
   Returns the stop functions of the forms it wired. */
export function startQuickEntry(doc) {
  const list = doc.getElementById('today-list');
  const total = doc.querySelector('[data-today-total]');
  if (!list || !total) return [];
  const stops = [];
  for (const form of doc.querySelectorAll('form[data-quick-entry]')) {
    const input = form.querySelector('#quick-entry');
    const hint = form.querySelector('.hint');
    if (input && hint) stops.push(wireQuickEntry({ form, input, list, total, hint }));
  }
  return stops;
}

if (typeof document !== 'undefined') startQuickEntry(document);

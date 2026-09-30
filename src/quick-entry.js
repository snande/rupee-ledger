// The quick-entry box's Enter handler. A submit is kept on the page with
// `preventDefault`, then the line goes through `parseEntry`. A line that
// parses is handed to `onEntry` in the same turn, so the screen can put the
// spend at the top of today's list and into the Today total before anything
// is written; the entry then goes to the ledger's `add`, which is not
// awaited, and the box is cleared and keeps focus for the next line. A line
// with no leading amount keeps its text and gets an inline sindoor hint:
// nothing is listed, nothing is written, and no dialog is shown.
//
// Vanilla JS with no framework, no library and no network. Writes go
// through `add` in `./ledger.js`; the caller renders amounts with
// `formatPaise` from `./format-amount.js`.

import { parseEntry } from './parse-entry.js';
import { add as ledgerAdd } from './ledger.js';

export const QUICK_ENTRY_HINT = 'Start with an amount, e.g. 120 chai';

/**
 * Sets the hint under the box. An `invalid` hint takes the `hint-error`
 * class, drawn in the DESIGN.md sindoor token, and marks the box invalid.
 * @param {HTMLElement} hint
 * @param {HTMLInputElement} input
 * @param {string} text
 * @param {boolean} invalid
 */
export function showHint(hint, input, text, invalid) {
  hint.textContent = text;
  hint.classList.toggle('hint-error', invalid);
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * Wires the submit handler on the quick-entry form.
 * @param {object} options
 * @param {HTMLFormElement} options.form
 * @param {HTMLInputElement} options.input
 * @param {HTMLElement} options.hint
 * @param {(entry: { amountPaise: number, note: string, createdAt: number }) => unknown} options.onEntry
 *   Renders the entry synchronously; what it returns is passed to `onSaving`.
 * @param {(entry: { amountPaise: number, note: string, createdAt: number }) => unknown} [options.add]
 *   The ledger write, `add` from `./ledger.js` unless one is given.
 * @param {(saving: Promise<unknown>, shown: unknown, text: string) => void} [options.onSaving]
 *   Given the write's promise, to follow it; by default a failed write is
 *   named in the hint so it is never lost silently.
 * @param {(text: string) => void} [options.onInvalid]  Called after the hint on a line that does not parse.
 * @param {() => number} [options.now]  Epoch milliseconds for `createdAt`.
 */
export function wireQuickEntry({
  form,
  input,
  hint,
  onEntry,
  add = ledgerAdd,
  onSaving = (saving) => saving.catch(() => showHint(hint, input, 'That spend was not saved. Type it again to save it.', true)),
  onInvalid = () => {},
  now = Date.now,
}) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (text.trim() === '') {
      input.focus();
      return;
    }

    const parsed = parseEntry(text);
    if (!parsed) {
      showHint(hint, input, QUICK_ENTRY_HINT, true);
      onInvalid(text);
      input.focus();
      return;
    }

    const entry = { amountPaise: parsed.amountPaise, note: parsed.note, createdAt: now() };
    const shown = onEntry(entry);

    let saving;
    try {
      saving = Promise.resolve(add(entry));
    } catch (error) {
      saving = Promise.reject(error);
    }
    input.value = '';
    input.focus();
    onSaving(saving, shown, text);
  });
}

// The quick-entry box's Enter. The submit handler parses the typed line with
// `parseEntry` and, in the same turn, has the screen draw the spend (a
// `note ₹amount` row at the top of `#today-list` and the Today total with it
// added). It then hands the spend to the ledger's `add` without waiting for
// the write, clears the box and keeps focus there for the next line. A line
// with no leading amount keeps its text and shows an inline sindoor hint,
// never a dialog.
//
// Amounts are named only through `formatPaise` and written only through
// `add` in ./ledger.js; this module keeps no formatter or store of its own
// and makes no network request. js/screens/today.js wires its form here.

import { parseEntry } from './parse-entry.js';
import { formatPaise } from './format-amount.js';
import * as ledgerModule from './ledger.js';

export const INVALID_HINT = 'Start with an amount, e.g. 120 chai';

/* A spend as a person reads it: '₹120 chai', or just '₹45.5' with no note. */
export function spendLabel(entry) {
  return formatPaise(entry.amountPaise) + (entry.note ? ' ' + entry.note : '');
}

/* Sets the line under the box. An invalid one turns sindoor (the
   .hint-error rule in css/controls.css) and marks the box aria-invalid. */
export function showHint(hint, input, text, invalid) {
  hint.textContent = text;
  hint.classList.toggle('hint-error', invalid);
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * Listens for submit on the quick-entry `form`.
 * @param {{ form: Element, input: HTMLInputElement, hint: Element,
 *   draw: (entry: { amountPaise: number, note: string, createdAt: number },
 *     text: string) => ({ saved?: (stored: unknown) => void,
 *     failed?: (error: unknown) => void } | void),
 *   ledger?: { add: (entry: { amountPaise: number, note: string,
 *     createdAt: number }) => unknown },
 *   now?: () => number, restingHint?: string,
 *   onInvalid?: (text: string) => void }} parts
 *   `draw` puts the spend on screen synchronously and may return what to do
 *   once the write settles; `restingHint` is what the hint reads between
 *   entries, by default the text it has when wired.
 */
export function wireQuickEntry({
  form,
  input,
  hint,
  draw,
  ledger = ledgerModule,
  now = Date.now,
  restingHint = hint?.textContent ?? '',
  onInvalid = () => {},
}) {
  if (!form || !input || !hint || typeof draw !== 'function') {
    throw new Error('The quick-entry markup is incomplete.');
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (text.trim() === '') {
      input.focus();
      return;
    }
    const parsed = parseEntry(text);
    if (!parsed) {
      showHint(hint, input, INVALID_HINT, true);
      onInvalid(text);
      input.focus();
      return;
    }

    const entry = { amountPaise: parsed.amountPaise, note: parsed.note, createdAt: now() };
    showHint(hint, input, restingHint, false);
    const outcome = draw(entry, text) || {};

    // Not awaited: the spend is already on screen.
    let saving;
    try {
      saving = Promise.resolve(ledger.add(entry));
    } catch (error) {
      saving = Promise.reject(error);
    }
    saving.then(
      (stored) => outcome.saved?.(stored),
      (error) => outcome.failed?.(error),
    );

    input.value = '';
    input.focus();
  });
}

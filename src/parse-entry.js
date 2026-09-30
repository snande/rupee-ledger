// Parses a one-line quick-entry such as `120 chai` or `₹45.50 auto` into
// an amount in integer paise and a free-text note. Pure: no DOM, no
// storage, no network, so the quick-entry box can call it on every
// keystroke for its live preview.

// An optional `₹`, `Rs` or `Rs.` prefix, then rupees with at most two
// decimal places, then the note. The lookahead rejects an amount that runs
// on into a third decimal digit or a second dot (`45.505`, `12.5.3`)
// instead of silently splitting it into amount and note.
const ENTRY = /^\s*(?:₹|rs\.?)?\s*(\d+)(?:\.(\d{1,2}))?(?![\d.])\s*([\s\S]*)$/i;

/**
 * @param {string} text  One typed line, e.g. `120 chai`.
 * @returns {{ amountPaise: number, note: string } | null}  `null` when the
 *   line has no positive leading amount or has more than two decimals.
 */
export function parseEntry(text) {
  if (typeof text !== 'string') return null;

  const match = ENTRY.exec(text);
  if (!match) return null;

  const [, rupees, fraction = '', rest] = match;
  const amountPaise = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return null;

  const note = rest.trim().replace(/\s+/g, ' ');
  return { amountPaise, note };
}

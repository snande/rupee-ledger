// Formats an integer paise amount as a ₹ string with Indian digit grouping
// (₹1,23,450), showing paise only when there are any (₹45.5). Pure: no DOM,
// no storage, no network, so any screen can call it on every render.

const FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * @param {number} paise  Integer paise, e.g. 4550 for ₹45.50.
 * @returns {string}  e.g. '₹45.5'.
 */
export function formatPaise(paise) {
  return FORMATTER.format(paise / 100);
}

/* One digit-group comma as HTML: a span a stylesheet can set narrow, then a
   <wbr>, the only place a long total may break onto a second line. */
const COMMA_HTML = '<span class="amount-comma">,</span><wbr>';

/**
 * Formats a paise amount as HTML for a total card: the text of formatPaise(),
 * with every digit-group comma marked up as COMMA_HTML, so a total too wide
 * for its card breaks only after a comma (₹1,23, / 615.05), never between two
 * digits. The element's text content stays exactly formatPaise(paise).
 *
 * @param {number} paise  Integer paise, e.g. 12361505 for ₹1,23,615.05.
 * @returns {string}  e.g. '₹1<span class="amount-comma">,</span><wbr>23…'.
 */
export function formatPaiseHtml(paise) {
  return formatPaise(paise).split(',').join(COMMA_HTML);
}

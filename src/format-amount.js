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

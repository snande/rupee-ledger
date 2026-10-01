/*
 * The Compare screen: two month pickers and, under them, each month's total
 * and per-category totals in two side-by-side columns with the difference
 * for each row. renderCompare(state) returns the whole screen for the router
 * to put into <main>; mountCompare() then loads both months from the
 * on-device ledger and loads again whenever either picker changes.
 *
 * State: { status: 'loading' | 'error' | 'filled', first, second,
 *          entries?: [{ id, amountPaise, note, category, timestamp }],
 *          now?: Date }.
 * `first` and `second` are 'YYYY-MM' months. The comparison comes from
 * compareMonths() in src/compare-months.js: amounts are integer paise, each
 * difference is second minus first, and spends with no category are grouped
 * under Uncategorised. Every amount is shown through formatPaise() with ₹.
 * The screen only reads: it stores, deletes and overwrites nothing.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { compareMonths, UNCATEGORISED } from '../../src/compare-months.js';
import { formatPaise } from '../../src/format-amount.js';
import { loadMonthEntries } from '../data/ledger.js';
import { escapeHtml } from './today.js';

export { UNCATEGORISED };

export const STATUSES = ['loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'These months did not open.';

/* How many months back, this month included, the pickers offer. */
export const MONTH_COUNT = 24;

const SKELETON_ROWS = 3;
const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' });

/* { year, month } for a 'YYYY-MM' month, month 1 for January; else null. */
function parseMonth(id) {
  const text = typeof id === 'string' ? id : '';
  const match = /^(\d{4})-(\d{2})/.exec(text);
  if (!match || match[0] !== text) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
}

export function isMonthId(value) {
  return parseMonth(value) !== null;
}

/* The 'YYYY-MM' month holding `date`, on the device's calendar. */
export function monthId(date) {
  return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

/* 'September 2026' for '2026-09'. */
export function monthLabel(id) {
  const parsed = parseMonth(id);
  return parsed ? MONTH_LABEL.format(new Date(parsed.year, parsed.month - 1, 1)) : String(id ?? '');
}

/* This month and the ones before it, newest first. */
export function monthOptions(now = new Date(), count = MONTH_COUNT) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(monthId(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return ids;
}

/* The screen opens on last month against this month. */
export function defaultMonths(now = new Date()) {
  const [second, first] = monthOptions(now, 2);
  return { first, second };
}

/* '+₹1,200' for more spent, '−₹1,200' for less, '₹0' for the same. */
export function formatDifference(paise) {
  if (paise > 0) return '+' + formatPaise(paise);
  if (paise < 0) return '−' + formatPaise(-paise);
  return formatPaise(0);
}

/* A category's paise in one month's map; 0 when absent, own keys only. */
function amountIn(byCategory, category) {
  return Object.hasOwn(byCategory, category) ? byCategory[category] : 0;
}

/* Every category either month has, by name, with Uncategorised last, so the
   same category sits on the same row for both months. */
export function categoryRows(result) {
  return Object.keys(result.diff.byCategory).sort((a, b) =>
    (a === UNCATEGORISED) - (b === UNCATEGORISED) || (a < b ? -1 : a > b ? 1 : 0));
}

function trend(paise) {
  return paise > 0 ? 'compare-up' : paise < 0 ? 'compare-down' : 'compare-same';
}

function row(label, hook, first, second, difference, total) {
  return '<tr class="compare-row' + (total ? ' compare-total' : '') + '" ' + hook + '>' +
    '<th scope="row" class="compare-category">' + escapeHtml(label) + '</th>' +
    '<td class="amount compare-amount">' + formatPaise(first) + '</td>' +
    '<td class="amount compare-amount">' + formatPaise(second) + '</td>' +
    '<td class="amount compare-difference ' + trend(difference) + '">' + formatDifference(difference) + '</td>' +
  '</tr>';
}

function tableView(entries, first, second) {
  const result = compareMonths(entries, first, second);
  const firstLabel = escapeHtml(monthLabel(first));
  const secondLabel = escapeHtml(monthLabel(second));
  const rows = categoryRows(result).map((category) => row(
    category,
    'data-category="' + escapeHtml(category) + '"',
    amountIn(result.a.byCategory, category),
    amountIn(result.b.byCategory, category),
    result.diff.byCategory[category],
    false,
  ));
  const none = rows.length === 0
    ? '<p class="hint compare-none">No spends in either month yet.</p>'
    : '';
  return '<section class="card compare-result" aria-labelledby="compare-caption">' +
    '<table class="compare-table">' +
      '<caption class="visually-hidden" id="compare-caption">Spends in ' + firstLabel + ' and ' + secondLabel + ', by category</caption>' +
      '<thead><tr>' +
        '<th scope="col" class="compare-category">Category</th>' +
        '<th scope="col" class="compare-amount" data-compare-heading="first">' + firstLabel + '</th>' +
        '<th scope="col" class="compare-amount" data-compare-heading="second">' + secondLabel + '</th>' +
        '<th scope="col" class="compare-difference">Difference</th>' +
      '</tr></thead>' +
      '<tbody>' +
        row('Total', 'data-compare-total', result.a.total, result.b.total, result.diff.total, true) +
        rows.join('') +
      '</tbody>' +
    '</table>' +
    none +
  '</section>';
}

function loadingView() {
  let skeleton = '';
  for (let i = 0; i < SKELETON_ROWS; i += 1) {
    skeleton += '<li class="skeleton-row"><span class="skeleton-bar skeleton-note"></span><span class="skeleton-bar skeleton-amount"></span></li>';
  }
  return '<section class="card compare-loading" aria-busy="true" aria-labelledby="compare-loading-label">' +
    '<p class="visually-hidden" id="compare-loading-label" role="status">Opening these months</p>' +
    '<ul class="skeleton-list" aria-hidden="true">' + skeleton + '</ul>' +
  '</section>';
}

function errorView(message) {
  return '<section class="card compare-error" role="alert" aria-labelledby="compare-error-message">' +
    '<p class="compare-error-message" id="compare-error-message">' + escapeHtml(message || ERROR_MESSAGE) + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

/* The part of the screen under the pickers. */
export function renderCompareView(state = {}) {
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  if (status === 'error') return errorView(state.message);
  if (status === 'loading' || !isMonthId(state.first) || !isMonthId(state.second)) return loadingView();
  return tableView(Array.isArray(state.entries) ? state.entries : [], state.first, state.second);
}

function monthField(key, label, selected, now) {
  const ids = monthOptions(now);
  if (!ids.includes(selected)) ids.unshift(selected);
  const options = ids.map((id) => '<option value="' + id + '"' + (id === selected ? ' selected' : '') + '>' +
    escapeHtml(monthLabel(id)) + '</option>').join('');
  return '<p class="field compare-field">' +
    '<label for="compare-' + key + '">' + label + '</label>' +
    '<select id="compare-' + key + '" name="' + key + '" data-compare-' + key + '>' + options + '</select>' +
  '</p>';
}

/* The router calls this with no state, so the screen opens on last month
   against this month, loading; mountCompare loads them in the same task. */
export function renderCompare(state = {}) {
  const now = state.now instanceof Date ? state.now : new Date();
  const defaults = defaultMonths(now);
  const first = isMonthId(state.first) ? state.first : defaults.first;
  const second = isMonthId(state.second) ? state.second : defaults.second;
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  return '<div class="compare" data-status="' + status + '">' +
    '<div class="card compare-pickers">' +
      monthField('first', 'First month', first, now) +
      monthField('second', 'Second month', second, now) +
    '</div>' +
    '<div class="compare-view" data-compare-view>' + renderCompareView({ ...state, status, first, second }) + '</div>' +
    '<p class="visually-hidden" role="status" data-compare-status></p>' +
  '</div>';
}

/*
 * Wires the rendered screen: reads the two pickers, loads both months with
 * `load` (src/ledger.js through js/data/ledger.js by default, so nothing
 * leaves the phone) and draws the comparison. Changing either picker loads
 * and draws again for the newly chosen months; a load that a
 * newer one or a route change has overtaken writes nothing. A failed load
 * shows Try again. Focus goes to the first picker. Returns the first load's
 * promise, which never rejects.
 */
export function mountCompare({
  main,
  isCurrent = () => true,
  load = loadMonthEntries,
  now = new Date(),
}) {
  const root = main.querySelector('.compare');
  const view = main.querySelector('[data-compare-view]');
  const firstSelect = main.querySelector('[data-compare-first]');
  const secondSelect = main.querySelector('[data-compare-second]');
  const announcer = main.querySelector('[data-compare-status]');
  if (!view || !firstSelect || !secondSelect) {
    throw new Error('The Compare screen markup is incomplete.');
  }

  const defaults = defaultMonths(now);
  const picked = (select, fallback) => (isMonthId(select.value) ? select.value : fallback);
  let first = picked(firstSelect, defaults.first);
  let second = picked(secondSelect, defaults.second);
  let status = 'loading';
  let entries = [];
  let attempt = 0;

  const show = () => {
    if (!isCurrent()) return;
    if (root) root.setAttribute('data-status', status);
    view.innerHTML = renderCompareView({ status, entries, first, second });
  };

  const announce = (text) => {
    if (announcer && isCurrent()) announcer.textContent = text;
  };

  function start() {
    const mine = ++attempt;
    status = 'loading';
    show();
    /* One month picked twice is loaded once, so it is not counted twice. */
    const months = first === second ? [first] : [first, second];
    let pending;
    try {
      pending = Promise.all(months.map((month) => load(month)));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (lists) => {
        if (mine !== attempt) return;
        entries = lists.flatMap((list) => (Array.isArray(list) ? list : []));
        status = 'filled';
        show();
        announce('Showing ' + monthLabel(first) + ' against ' + monthLabel(second));
      },
      () => {
        if (mine !== attempt) return;
        entries = [];
        status = 'error';
        show();
      },
    );
  }

  const onChange = () => {
    first = picked(firstSelect, first);
    second = picked(secondSelect, second);
    start();
  };
  firstSelect.addEventListener('change', onChange);
  secondSelect.addEventListener('change', onChange);

  view.addEventListener('click', (event) => {
    const from = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (from && from.closest('[data-action="retry"]')) start();
  });

  if (typeof firstSelect.focus === 'function') firstSelect.focus();
  return start();
}

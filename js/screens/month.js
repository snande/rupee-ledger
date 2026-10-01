/*
 * The Month screen: this month's total over a pie chart of the spend by
 * category, with a legend naming each category and its amount. renderMonth()
 * returns the whole screen for the router to put into <main>; mountMonth()
 * then loads the month's entries from the on-device ledger, the same load
 * the Today screen runs, and draws the view.
 *
 * State: { status: 'loading' | 'error' | 'filled',
 *          entries?: [{ id, amountPaise, note, timestamp, category? }],
 *          now?: Date }.
 * The legend rows come from categoryTotalsForMonth() in
 * src/category-totals.js, and the month total shown is the sum of those same
 * rows, so the legend always adds up exactly to the total. Stored entries
 * carry no category yet, so one is read from the note with categorise().
 * The chart is hand-written SVG: one path per category, or a full circle
 * when one category is the whole month. Slice colours are classes styled
 * from the chart tokens in css/tokens.css.
 * Amounts are integer paise and are only ever shown in rupees with ₹.
 */

import { formatPaise } from '../../src/format-amount.js';
import { categorise } from '../../src/categorise.js';
import { categoryTotalsForMonth } from '../../src/category-totals.js';
import { loadEntries } from '../data/ledger.js';
import { escapeHtml } from './today.js';

export const ERROR_MESSAGE = 'This month’s spends did not open.';
export const EMPTY_MESSAGE = 'No spends this month yet';

/* How many slice colours css/tokens.css defines; more categories reuse them. */
export const SLICE_COLOURS = 7;

/* The pie's drawing box: a circle of radius R centred in a SIZE square. */
const SIZE = 100;
const R = 48;

const MONTH_NAME = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' });

/* The category an entry counts under: its own, or the one its note names. */
function withCategory(entry) {
  const own = typeof entry?.category === 'string' ? entry.category.trim() : '';
  return { ...entry, category: own || categorise(entry?.note) };
}

/**
 * This month's spend by category and its total, from one aggregation.
 * @returns {{ rows: Array<{ category: string, amount: number }>, total: number }}
 *   `amount` and `total` in integer paise; `total` is the sum of the rows.
 */
export function monthSummary(entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries.map(withCategory) : [];
  const rows = categoryTotalsForMonth(list, now.getFullYear(), now.getMonth() + 1);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return { rows, total };
}

/* A point on the circle, `fraction` of the way round clockwise from the top. */
function pointAt(fraction, cx, cy, r) {
  const angle = 2 * Math.PI * fraction - Math.PI / 2;
  const x = Math.round((cx + r * Math.cos(angle)) * 1000) / 1000;
  const y = Math.round((cy + r * Math.sin(angle)) * 1000) / 1000;
  return x + ',' + y;
}

/**
 * The pie's shapes, one per row with a positive amount, clockwise from the
 * top in row order. A row that is the whole pie is a circle, since an arc
 * from a point back to itself draws nothing.
 * @returns {Array<{ shape: 'circle' | 'path', d?: string, index: number }>}
 *   `index` is the row's position, so each slice matches its legend row.
 */
export function pieSlices(rows, cx = SIZE / 2, cy = SIZE / 2, r = R) {
  const parts = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ amount: row.amount, index }))
    .filter((part) => Number.isFinite(part.amount) && part.amount > 0);
  const whole = parts.reduce((sum, part) => sum + part.amount, 0);
  if (parts.length === 1) return [{ shape: 'circle', index: parts[0].index }];

  let done = 0;
  return parts.map((part) => {
    const start = done / whole;
    done += part.amount;
    const end = done / whole;
    const largeArc = end - start > 0.5 ? 1 : 0;
    const d = 'M ' + cx + ',' + cy +
      ' L ' + pointAt(start, cx, cy, r) +
      ' A ' + r + ',' + r + ' 0 ' + largeArc + ' 1 ' + pointAt(end, cx, cy, r) +
      ' Z';
    return { shape: 'path', d, index: part.index };
  });
}

function sliceClass(index) {
  return 'month-slice month-slice-' + ((index % SLICE_COLOURS) + 1);
}

function pieView(rows) {
  const label = 'Spend by category: ' +
    rows.map((row) => row.category + ' ' + formatPaise(row.amount)).join(', ');
  const shapes = pieSlices(rows).map((slice) => (slice.shape === 'circle'
    ? '<circle class="' + sliceClass(slice.index) + '" cx="' + SIZE / 2 + '" cy="' + SIZE / 2 + '" r="' + R + '"></circle>'
    : '<path class="' + sliceClass(slice.index) + '" d="' + slice.d + '"></path>'));
  return '<svg class="month-pie" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" role="img" aria-label="' + escapeHtml(label) + '">' +
    shapes.join('') +
  '</svg>';
}

function legendView(rows) {
  return '<ul class="month-legend" aria-label="Categories">' +
    rows.map((row, index) => '<li class="month-legend-row">' +
      '<span class="month-swatch ' + sliceClass(index) + '" aria-hidden="true"></span>' +
      '<span class="month-legend-name">' + escapeHtml(row.category) + '</span>' +
      '<span class="amount month-legend-amount" data-category-amount>' + formatPaise(row.amount) + '</span>' +
    '</li>').join('') +
  '</ul>';
}

function emptyView() {
  return '<section class="card month-empty" aria-labelledby="month-empty-heading">' +
    '<h2 id="month-empty-heading">' + EMPTY_MESSAGE + '</h2>' +
    '<p>Spends you add on Today show up here, split by category.</p>' +
    '<a class="month-link" href="#/today">Go to Today</a>' +
  '</section>';
}

function loadingView() {
  return '<section class="card month-loading" aria-busy="true" aria-labelledby="month-loading-label">' +
    '<p class="visually-hidden" id="month-loading-label" role="status">Opening this month’s spends</p>' +
    '<span class="skeleton-bar month-skeleton" aria-hidden="true"></span>' +
  '</section>';
}

function errorView() {
  return '<section class="card month-error" role="alert" aria-labelledby="month-error-message">' +
    '<p class="month-error-message" id="month-error-message">' + ERROR_MESSAGE + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

/* The total card: like Today's, a muted label above a mono amount, which is
   only shown once the load has succeeded. */
function totalView(total, status) {
  let value;
  if (status === 'loading') {
    value = '<span class="skeleton-bar total-skeleton" aria-hidden="true"></span>';
  } else if (status === 'error') {
    value = '<span class="amount total-amount total-unknown" data-month-total aria-hidden="true">—</span>' +
      '<span class="visually-hidden">not known</span>';
  } else {
    value = '<span class="amount total-amount" data-month-total>' + formatPaise(total) + '</span>';
  }
  return '<p class="card total-card month-total">' +
    '<span class="total-label">This month</span>' +
    value +
  '</p>';
}

/* The part of the screen that follows the state: the month's name and
   total, then the pie and legend, or the empty prompt, loading or error. */
export function renderMonthView(state = {}) {
  const status = ['loading', 'error', 'filled'].includes(state.status) ? state.status : 'loading';
  const now = state.now instanceof Date ? state.now : new Date();
  const { rows, total } = status === 'filled' ? monthSummary(state.entries, now) : { rows: [], total: 0 };
  const parts = [
    '<h2 class="month-heading">' + escapeHtml(MONTH_NAME.format(now)) + '</h2>',
    totalView(total, status),
  ];
  if (status === 'loading') parts.push(loadingView());
  else if (status === 'error') parts.push(errorView());
  else if (rows.length === 0) parts.push(emptyView());
  else {
    parts.push('<section class="card month-chart" aria-label="Spend by category">' +
      pieView(rows) + legendView(rows) +
    '</section>');
  }
  return parts.join('');
}

/* The router calls this with no state, so the screen opens on the skeleton
   until mountMonth's load settles. */
export function renderMonth(state = { status: 'loading' }) {
  return '<div class="month">' +
    '<div class="month-view" data-month-view>' + renderMonthView(state) + '</div>' +
  '</div>';
}

/*
 * Loads the month's entries and draws them: pending → loading, entries →
 * pie and legend (or the empty prompt), rejected → error with Try again.
 * Focus moves to <main>, as the screen has no input of its own. isCurrent()
 * turns false once the router has replaced this screen, so a late load
 * writes nothing. Returns the first load's promise, which never rejects.
 */
export function mountMonth({
  main,
  query = new URLSearchParams(),
  isCurrent = () => true,
  load = loadEntries,
  now = () => new Date(),
}) {
  const view = main.querySelector('[data-month-view]');
  if (!view) throw new Error('The Month screen markup is incomplete.');

  let attempt = 0;
  const show = (state) => {
    if (isCurrent()) view.innerHTML = renderMonthView({ ...state, now: now() });
  };

  function start() {
    const mine = ++attempt;
    show({ status: 'loading' });
    let pending;
    try {
      pending = Promise.resolve(load(query));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (entries) => {
        if (mine === attempt) show({ status: 'filled', entries });
      },
      () => {
        if (mine === attempt) show({ status: 'error' });
      },
    );
  }

  view.addEventListener('click', (event) => {
    const target = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-action="retry"]')
      : null;
    if (target) start();
  });

  if (typeof main.focus === 'function') main.focus({ preventScroll: true });
  return start();
}

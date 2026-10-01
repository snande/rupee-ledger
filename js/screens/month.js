/*
 * The Month screen: this month's total over a donut chart of where it went,
 * with a legend giving each category's colour, name, amount and share.
 * renderMonth(state) returns the whole screen for the router to put into
 * <main>; mountMonth() then loads the month from the on-device ledger.
 *
 * State: { status: 'loading' | 'error' | 'filled', month?: 'YYYY-MM',
 *          entries?: [{ id, amountPaise, note, category, timestamp }],
 *          now?: Date }.
 * The total and the legend come from one categoryTotalsForMonth() call
 * (src/category-totals.js): amounts are integer paise and the total shown is
 * the sum of the legend amounts, so they always add up exactly. Every amount
 * is shown through formatPaise() with ₹. The chart is hand-written SVG drawn
 * from tokens in css/tokens.css; nothing is fetched. The screen only reads.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { categoryTotalsForMonth, UNCATEGORISED } from '../../src/category-totals.js';
import { formatPaise } from '../../src/format-amount.js';
import { loadMonthEntries } from '../data/ledger.js';
import { isMonthId, monthId, monthLabel } from './compare.js';
import { escapeHtml } from './today.js';

export { UNCATEGORISED };

export const STATUSES = ['loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'This month did not open.';
export const EMPTY_MESSAGE = 'No spends this month yet';

/* How many --chart-N colours css/tokens.css defines; slices past the last
   start the set again. */
export const CHART_COLOURS = 7;

/* The chart's viewBox is 0 0 100 100: a pie of radius 50 at its centre,
   with a hole that turns it into a donut. */
const CENTRE = 50;
const RADIUS = 50;
const HOLE_RADIUS = 30;
const SKELETON_ROWS = 3;

/* { year, month } for a 'YYYY-MM' month, month 1 for January. */
function yearMonth(id) {
  return { year: Number(id.slice(0, 4)), month: Number(id.slice(5, 7)) };
}

/* The month's categories, largest first, and their total: one aggregation,
   so the legend amounts add up to the total shown (===). */
export function monthSummary(entries, id) {
  const { year, month } = yearMonth(id);
  const rows = categoryTotalsForMonth(Array.isArray(entries) ? entries : [], year, month);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return { rows, total };
}

/* The pie's slices: one per category with spend, largest first, each with
   its colour number from 1, cycling through the CHART_COLOURS set. */
export function pieSlices(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.amount > 0)
    .map((row, i) => ({ label: row.category, amount: row.amount, colour: (i % CHART_COLOURS) + 1 }));
}

/* A point on the circle, `angle` radians clockwise from twelve o'clock. */
function point(cx, cy, r, angle) {
  const round = (n) => Math.round(n * 1000) / 1000;
  return [round(cx + r * Math.sin(angle)), round(cy - r * Math.cos(angle))];
}

/* One wedge from `start` to `end` radians, clockwise from twelve o'clock:
   M cx,cy L x1,y1 A r,r 0 largeArc 1 x2,y2 Z. A whole circle cannot be one
   arc (its ends meet), so a 100% slice is drawn as a <circle> instead, and a
   slice so close to whole that its rounded ends meet is drawn as two arcs
   through its middle, since SVG skips an arc whose ends are the same point. */
export function slicePath(cx, cy, r, start, end) {
  const [x1, y1] = point(cx, cy, r, start);
  const [x2, y2] = point(cx, cy, r, end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  let arc = ' A ' + r + ',' + r + ' 0 ' + largeArc + ' 1 ' + x2 + ',' + y2;
  if (x1 === x2 && y1 === y2 && largeArc) {
    const [xm, ym] = point(cx, cy, r, (start + end) / 2);
    arc = ' A ' + r + ',' + r + ' 0 0 1 ' + xm + ',' + ym + ' A ' + r + ',' + r + ' 0 0 1 ' + x2 + ',' + y2;
  }
  return 'M ' + cx + ',' + cy + ' L ' + x1 + ',' + y1 + arc + ' Z';
}

/* The whole number percent of the month's total, for the legend. */
export function share(amount, total) {
  return total > 0 ? Math.round((amount * 100) / total) + '%' : '';
}

function sliceTitle(slice) {
  return '<title>' + escapeHtml(slice.label) + ': ' + formatPaise(slice.amount) + '</title>';
}

/* The donut: a <circle> for a single slice, else one wedge per slice. */
export function pieSvg(slices, label = 'Spends by category') {
  const sum = slices.reduce((total, slice) => total + slice.amount, 0);
  let marks = '';
  if (slices.length === 1) {
    marks = '<circle class="month-slice month-colour-' + slices[0].colour + '" cx="' + CENTRE + '" cy="' + CENTRE +
      '" r="' + RADIUS + '" data-slice="' + escapeHtml(slices[0].label) + '">' + sliceTitle(slices[0]) + '</circle>';
  } else {
    let start = 0;
    for (const slice of slices) {
      const end = start + (2 * Math.PI * slice.amount) / sum;
      marks += '<path class="month-slice month-colour-' + slice.colour + '" d="' +
        slicePath(CENTRE, CENTRE, RADIUS, start, end) + '" data-slice="' + escapeHtml(slice.label) + '">' +
        sliceTitle(slice) + '</path>';
      start = end;
    }
  }
  return '<svg class="month-pie" viewBox="0 0 100 100" role="img" aria-label="' + escapeHtml(label) + '">' +
    marks +
    '<circle class="month-hole" cx="' + CENTRE + '" cy="' + CENTRE + '" r="' + HOLE_RADIUS + '"></circle>' +
  '</svg>';
}

/* A category with no spend has no slice, so its swatch stays plain. */
function legendView(rows, total, slices) {
  const colours = new Map(slices.map((slice) => [slice.label, slice.colour]));
  const items = rows.map((row) => {
    const colour = colours.get(row.category);
    const swatch = colour
      ? '<span class="month-swatch month-colour-' + colour + '" aria-hidden="true"></span>'
      : '<span class="month-swatch" aria-hidden="true"></span>';
    return '<li class="month-legend-row" data-category="' + escapeHtml(row.category) + '">' +
      swatch +
      '<span class="month-legend-name">' + escapeHtml(row.category) + '</span>' +
      '<span class="amount month-legend-amount" data-legend-amount>' + formatPaise(row.amount) + '</span>' +
      '<span class="month-legend-share">' + share(row.amount, total) + '</span>' +
    '</li>';
  });
  return '<ul class="month-legend" aria-label="By category">' + items.join('') + '</ul>';
}

function totalView(id, paise, known) {
  const value = known
    ? '<span class="amount total-amount" data-month-total>' + formatPaise(paise) + '</span>'
    : '<span class="skeleton-bar total-skeleton" aria-hidden="true"></span>';
  return '<p class="card total-card month-total-card"' + (known ? '' : ' aria-busy="true"') + '>' +
    '<span class="total-label">' + escapeHtml(monthLabel(id)) + '</span>' +
    value +
  '</p>';
}

function filledView(entries, id) {
  const { rows, total } = monthSummary(entries, id);
  if (rows.length === 0) {
    return totalView(id, 0, true) +
      '<section class="card month-empty" aria-labelledby="month-empty-heading">' +
        '<h2 id="month-empty-heading">' + EMPTY_MESSAGE + '</h2>' +
        '<p>Spends you add on Today show up here, split by category.</p>' +
        '<a class="month-link" href="#/today">Add a spend</a>' +
      '</section>';
  }
  const slices = pieSlices(rows);
  const chart = slices.length > 0
    ? '<div class="month-chart">' + pieSvg(slices, 'Spends in ' + monthLabel(id) + ' by category') + '</div>'
    : '';
  return totalView(id, total, true) +
    '<section class="card month-breakdown" aria-label="Where it went">' +
      chart +
      legendView(rows, total, slices) +
    '</section>';
}

function loadingView(id) {
  let skeleton = '';
  for (let i = 0; i < SKELETON_ROWS; i += 1) {
    skeleton += '<li class="skeleton-row"><span class="skeleton-bar skeleton-note"></span><span class="skeleton-bar skeleton-amount"></span></li>';
  }
  return totalView(id, 0, false) +
    '<section class="card month-loading" aria-busy="true" aria-labelledby="month-loading-label">' +
      '<p class="visually-hidden" id="month-loading-label" role="status">Opening this month</p>' +
      '<ul class="skeleton-list" aria-hidden="true">' + skeleton + '</ul>' +
    '</section>';
}

function errorView(message) {
  return '<section class="card month-error" role="alert" aria-labelledby="month-error-message">' +
    '<p class="month-error-message" id="month-error-message">' + escapeHtml(message || ERROR_MESSAGE) + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

function normalise(state) {
  const now = state.now instanceof Date ? state.now : new Date();
  return {
    status: STATUSES.includes(state.status) ? state.status : 'loading',
    month: isMonthId(state.month) ? state.month : monthId(now),
  };
}

/* The part of the screen that follows the load. */
export function renderMonthView(state = {}) {
  const { status, month } = normalise(state);
  if (status === 'error') return errorView(state.message);
  if (status === 'loading') return loadingView(month);
  return filledView(state.entries, month);
}

/* The router calls this with no state, so the screen opens on this month,
   loading; mountMonth loads it in the same task. */
export function renderMonth(state = {}) {
  const { status } = normalise(state);
  return '<div class="month" data-status="' + status + '">' +
    '<div class="month-view" data-month-view>' + renderMonthView(state) + '</div>' +
  '</div>';
}

/*
 * Wires the rendered screen: loads this month with `load` (src/ledger.js
 * through js/data/ledger.js by default, so nothing leaves the phone) and
 * draws it. A failed load shows Try again; a load that a route change has
 * overtaken writes nothing. Focus goes to <main>. Returns the load's promise,
 * which never rejects.
 *
 * Nothing is kept between mounts: the router mounts the screen each time its
 * tab opens, and each mount reads the ledger afresh. So spends added
 * elsewhere, by the quick-entry box or by Import backup on the Backup screen
 * (js/screens/backup.js), are in the total the next time the Month tab
 * opens, with no page reload; a re-import that adds nothing leaves it as it
 * was.
 */
export function mountMonth({
  main,
  isCurrent = () => true,
  load = loadMonthEntries,
  now = new Date(),
}) {
  const root = main.querySelector('.month');
  const view = main.querySelector('[data-month-view]');
  if (!view) throw new Error('The Month screen markup is incomplete.');

  const month = monthId(now);
  let attempt = 0;

  const show = (state) => {
    if (!isCurrent()) return;
    if (root) root.setAttribute('data-status', state.status);
    view.innerHTML = renderMonthView({ ...state, month, now });
  };

  function start() {
    const mine = ++attempt;
    show({ status: 'loading' });
    let pending;
    try {
      pending = Promise.resolve(load(month));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (entries) => {
        if (mine === attempt) show({ status: 'filled', entries: Array.isArray(entries) ? entries : [] });
      },
      () => {
        if (mine === attempt) show({ status: 'error' });
      },
    );
  }

  view.addEventListener('click', (event) => {
    const from = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (from && from.closest('[data-action="retry"]')) start();
  });

  if (typeof main.focus === 'function') main.focus({ preventScroll: true });
  return start();
}

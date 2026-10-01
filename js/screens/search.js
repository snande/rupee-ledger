/*
 * The Search screen: a text field and, under it, every spend from every
 * month whose note contains what was typed, each with its date, note and
 * amount, and the total of those matches. renderSearch(state) returns the
 * whole screen for the router to put into <main>; mountSearch() then loads
 * all entries from the on-device ledger and searches them again on every
 * keystroke.
 *
 * State: { status: 'loading' | 'error' | 'filled', query?: string,
 *          entries?: [{ id, amountPaise, note, category, timestamp }] }.
 * Matching and the total come from searchEntries() in src/search.js: a
 * case-insensitive substring of the note, newest first, summed in integer
 * paise. Every amount is shown through formatPaise() with ₹. The screen only
 * reads: it stores, deletes and overwrites nothing, and it makes no network
 * request. Strings are joined with + rather than template literals, so the
 * only currency sign anywhere in this file is ₹.
 */

import { searchEntries } from '../../src/search.js';
import { formatPaise } from '../../src/format-amount.js';
import { loadAllEntries } from '../data/ledger.js';
import { escapeHtml } from './today.js';

export const STATUSES = ['loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'Your spends did not open.';
export const NO_MATCHES = 'No matching entries';
export const TOTAL_LABEL = 'Total of matches';

const SKELETON_ROWS = 3;
const DATE_LABEL = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/* '3 Aug 2026' for a moment in epoch milliseconds; '' when it has none. */
export function dateLabel(timestamp) {
  const date = new Date(timestamp ?? NaN);
  return Number.isNaN(date.getTime()) ? '' : DATE_LABEL.format(date);
}

function isoDate(timestamp) {
  const date = new Date(timestamp);
  return String(date.getFullYear()).padStart(4, '0') + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function matchRow(entry) {
  const label = dateLabel(entry.timestamp);
  const date = label
    ? '<time class="search-date" datetime="' + isoDate(entry.timestamp) + '">' + escapeHtml(label) + '</time>'
    : '<span class="search-date">No date</span>';
  const note = entry.note
    ? '<span class="entry-note">' + escapeHtml(entry.note) + '</span>'
    : '<span class="entry-note entry-note-empty">No note</span>';
  return '<li class="entry-row search-row" data-search-row>' +
    '<span class="search-detail">' + date + note + '</span>' +
    '<span class="amount entry-amount">' + formatPaise(entry.amountPaise) + '</span>' +
  '</li>';
}

function totalView(paise, count) {
  const counted = count === 1 ? '1 match' : count + ' matches';
  return '<p class="card total-card search-total">' +
    '<span class="total-label">' + TOTAL_LABEL + ' <span class="search-count">(' + counted + ')</span></span>' +
    '<span class="amount total-amount" data-search-total>' + formatPaise(paise) + '</span>' +
  '</p>';
}

function resultsView(entries, query) {
  const { matches, total } = searchEntries(entries, query);
  const list = matches.length === 0
    ? '<p class="hint search-none" data-search-none>' + NO_MATCHES + ' for “' + escapeHtml(query.trim()) + '”.</p>'
    : '<ul class="entry-list search-results" data-search-results>' + matches.map(matchRow).join('') + '</ul>';
  return totalView(total, matches.length) +
    '<section class="card search-list" aria-label="Matching spends">' + list + '</section>';
}

function hintView() {
  return '<section class="card search-hint">' +
    '<p class="hint">Type part of a note, like chai, to find those spends in every month and see what they add up to.</p>' +
  '</section>';
}

function loadingView() {
  let skeleton = '';
  for (let i = 0; i < SKELETON_ROWS; i += 1) {
    skeleton += '<li class="skeleton-row"><span class="skeleton-bar skeleton-note"></span><span class="skeleton-bar skeleton-amount"></span></li>';
  }
  return '<section class="card search-loading" aria-busy="true" aria-labelledby="search-loading-label">' +
    '<p class="visually-hidden" id="search-loading-label" role="status">Searching your spends</p>' +
    '<ul class="skeleton-list" aria-hidden="true">' + skeleton + '</ul>' +
  '</section>';
}

function errorView(message) {
  return '<section class="card search-error" role="alert" aria-labelledby="search-error-message">' +
    '<p class="search-error-message" id="search-error-message">' + escapeHtml(message || ERROR_MESSAGE) + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

/* The part of the screen under the field. A blank query shows a hint and
   needs no load. */
export function renderSearchView(state = {}) {
  const query = typeof state.query === 'string' ? state.query : '';
  if (query.trim() === '') return hintView();
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  if (status === 'error') return errorView(state.message);
  if (status === 'loading') return loadingView();
  return resultsView(Array.isArray(state.entries) ? state.entries : [], query);
}

/* The router calls this with no state, so the screen opens with an empty
   field and the hint. */
export function renderSearch(state = {}) {
  const query = typeof state.query === 'string' ? state.query : '';
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  return '<div class="search" data-status="' + status + '">' +
    '<form class="card search-form" role="search" data-search-form>' +
      '<p class="field search-field">' +
        '<label for="search-query">Search spends</label>' +
        '<input type="search" id="search-query" name="query" autocomplete="off" spellcheck="false" ' +
          'placeholder="chai" value="' + escapeHtml(query) + '" data-search-input>' +
      '</p>' +
    '</form>' +
    '<div class="search-view" data-search-view>' + renderSearchView({ ...state, status, query }) + '</div>' +
    '<p class="visually-hidden" role="status" data-search-status></p>' +
  '</div>';
}

/*
 * Wires the rendered screen: on every input it loads all entries with
 * `load` (src/ledger/store.js through js/data/ledger.js by default, so
 * nothing leaves the phone), searches them for the field's text and draws
 * the matches and their total. A load that a newer one or a route change has
 * overtaken writes nothing. A failed load shows Try again. Focus goes to the
 * field. Returns the first search's promise, which never rejects.
 */
export function mountSearch({
  main,
  isCurrent = () => true,
  load = loadAllEntries,
}) {
  const root = main.querySelector('.search');
  const view = main.querySelector('[data-search-view]');
  const input = main.querySelector('[data-search-input]');
  const form = main.querySelector('[data-search-form]');
  const announcer = main.querySelector('[data-search-status]');
  if (!view || !input) {
    throw new Error('The Search screen markup is incomplete.');
  }

  let status = 'loading';
  let entries = [];
  let query = '';
  let attempt = 0;

  const show = () => {
    if (!isCurrent()) return;
    if (root) root.setAttribute('data-status', status);
    view.innerHTML = renderSearchView({ status, entries, query });
  };

  const announce = (text) => {
    if (announcer && isCurrent()) announcer.textContent = text;
  };

  function start() {
    const mine = ++attempt;
    query = typeof input.value === 'string' ? input.value : '';
    if (query.trim() === '') {
      show();
      announce('');
      return Promise.resolve();
    }
    status = 'loading';
    show();
    let pending;
    try {
      pending = Promise.resolve(load());
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (list) => {
        if (mine !== attempt) return;
        entries = Array.isArray(list) ? list : [];
        status = 'filled';
        show();
        const { matches, total } = searchEntries(entries, query);
        announce(matches.length === 0
          ? NO_MATCHES
          : (matches.length === 1 ? '1 match' : matches.length + ' matches') + ', ' + formatPaise(total) + ' in all');
      },
      () => {
        if (mine !== attempt) return;
        entries = [];
        status = 'error';
        show();
      },
    );
  }

  input.addEventListener('input', () => {
    start();
  });
  if (form) {
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      start();
    });
  }

  view.addEventListener('click', (event) => {
    const from = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (from && from.closest('[data-action="retry"]')) start();
  });

  if (typeof input.focus === 'function') input.focus();
  return start();
}

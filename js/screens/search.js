/*
 * The Search screen: a query box over every spend on this phone, from all
 * months, with the matching spends listed under it and their total.
 * renderSearch(state) returns the whole screen for the router to put into
 * <main>; mountSearch() then listens to the box and, on each change, reads
 * every entry from the on-device store, matches them with searchEntries()
 * from src/search.js and redraws the list and the total.
 *
 * State: { status: 'idle' | 'loading' | 'error' | 'done', query?: string,
 *          entries?: Array<object>, message?: string }.
 * 'idle' is a blank query: nothing is matched, so a prompt shows. 'done'
 * lists every match, newest first, each with its date, note and amount, and
 * the total of the matches; a query nothing matches says so over a ₹0 total.
 * Entries are the store's records as listEntries() in src/ledger/store.js
 * returns them: the amount in integer paise as `amountPaise` or `amount`, the
 * date as `createdAt` in epoch milliseconds. Amounts are only ever shown in
 * rupees with ₹, through formatPaise. Nothing here touches the network.
 * Strings are joined with + rather than template literals, as in today.js.
 */

import { formatPaise } from '../../src/format-amount.js';
import { listEntries } from '../../src/ledger/store.js';
import { searchEntries } from '../../src/search.js';
import { escapeHtml } from './today.js';

export const STATUSES = ['idle', 'loading', 'error', 'done'];
export const NO_MATCHES = 'No matching entries';
export const TOTAL_LABEL = 'Total of matches';
export const ERROR_MESSAGE = 'Your spends did not open for search.';
export const SEARCH_HINT = 'Matches any part of a spend’s note, across every month';

const DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/* An entry's amount in integer paise, read the way searchEntries sums it,
   so each row and the total always agree. */
export function paiseOf(entry) {
  if (Number.isSafeInteger(entry?.amountPaise)) return entry.amountPaise;
  if (Number.isSafeInteger(entry?.amount)) return entry.amount;
  return 0;
}

/* An entry's date as '5 Mar 2026' on the device's calendar, or '' when it
   carries no usable one. */
export function entryDate(entry) {
  const value = entry?.createdAt ?? entry?.timestamp ?? entry?.ts;
  const at = value instanceof Date ? value : new Date(typeof value === 'number' || typeof value === 'string' ? value : NaN);
  return Number.isNaN(at.getTime()) ? '' : DATE_FORMAT.format(at);
}

function resultRow(entry) {
  const note = entry.note
    ? '<span class="entry-note">' + escapeHtml(entry.note) + '</span>'
    : '<span class="entry-note entry-note-empty">No note</span>';
  return '<li class="entry-row search-row">' +
    '<span class="search-row-text">' +
      note +
      '<span class="search-date">' + escapeHtml(entryDate(entry)) + '</span>' +
    '</span>' +
    '<span class="amount entry-amount">' + formatPaise(paiseOf(entry)) + '</span>' +
  '</li>';
}

/* The total of the matches: a 12px muted label above a 28px mono amount. */
function totalView(total) {
  return '<p class="card total-card search-total">' +
    '<span class="total-label">' + TOTAL_LABEL + '</span>' +
    '<span class="amount total-amount" data-search-total>' + formatPaise(total) + '</span>' +
  '</p>';
}

function resultsView(matches) {
  const count = matches.length === 1 ? '1 match' : matches.length + ' matches';
  return '<section class="card search-results" aria-labelledby="search-results-label">' +
    '<p class="today-list-heading">' +
      '<span class="today-list-label" id="search-results-label">Matching spends</span>' +
      '<span class="today-list-count">' + count + '</span>' +
    '</p>' +
    '<ul class="entry-list" id="search-list">' + matches.map(resultRow).join('') + '</ul>' +
  '</section>';
}

function noMatchesView(query) {
  return '<section class="card search-empty" aria-labelledby="search-empty-heading">' +
    '<h2 id="search-empty-heading">' + NO_MATCHES + '</h2>' +
    '<p>No spend’s note contains “' + escapeHtml(query.trim()) + '”.</p>' +
  '</section>';
}

function idleView() {
  return '<section class="card search-idle">' +
    '<p>Type a word from a spend, like chai, to see every one and what they add up to.</p>' +
  '</section>';
}

function loadingView() {
  return '<section class="card today-loading" aria-busy="true" aria-labelledby="search-loading-label">' +
    '<p class="visually-hidden" id="search-loading-label" role="status">Searching your spends</p>' +
    '<ul class="skeleton-list" aria-hidden="true">' +
      '<li class="skeleton-row"><span class="skeleton-bar skeleton-note"></span><span class="skeleton-bar skeleton-amount"></span></li>' +
    '</ul>' +
  '</section>';
}

function errorView(message) {
  return '<section class="card today-error" role="alert" aria-labelledby="search-error-message">' +
    '<p class="today-error-message" id="search-error-message">' + escapeHtml(message || ERROR_MESSAGE) + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

function normalise(state) {
  const query = typeof state.query === 'string' ? state.query : '';
  const blank = query.trim() === '';
  const status = blank ? 'idle' : STATUSES.includes(state.status) ? state.status : 'loading';
  const entries = Array.isArray(state.entries) ? state.entries : [];
  return { status, query, entries };
}

/* What the screen shows as a whole: 'empty' when a query matched nothing. */
export function shownStatus(state = {}) {
  const { status, query, entries } = normalise(state);
  if (status !== 'done') return status;
  return searchEntries(entries, query).matches.length > 0 ? 'done' : 'empty';
}

/* The part of the screen under the box. Once a search has run, the total of
   the matches comes first, then the matches or the no-match message. */
export function renderSearchView(state = {}) {
  const { status, query, entries } = normalise(state);
  if (status === 'idle') return idleView();
  if (status === 'loading') return loadingView();
  if (status === 'error') return errorView(state.message);
  const { matches, total } = searchEntries(entries, query);
  return totalView(total) + (matches.length > 0 ? resultsView(matches) : noMatchesView(query));
}

/* The router calls this with no state: an empty box and the prompt. */
export function renderSearch(state = { status: 'idle' }) {
  const query = typeof state.query === 'string' ? state.query : '';
  return '<div class="search" data-status="' + shownStatus(state) + '">' +
    '<form class="search-form" role="search" data-search-form novalidate>' +
      '<label for="search-query">Search spends</label>' +
      '<input id="search-query" name="query" type="search" placeholder="chai" value="' + escapeHtml(query) + '" ' +
        'autocomplete="off" autocapitalize="off" enterkeyhint="search" aria-describedby="search-hint" aria-controls="search-view">' +
      '<p class="hint" id="search-hint">' + SEARCH_HINT + '</p>' +
    '</form>' +
    '<div class="search-view" id="search-view" data-search-view aria-live="polite">' + renderSearchView(state) + '</div>' +
  '</div>';
}

/*
 * Wires the rendered screen: focuses the box and, on each input, reads every
 * entry from the on-device store with `load` (listEntries() from
 * src/ledger/store.js by default) and redraws the matches and their total.
 * A blank box shows the prompt at once without reading. Each search counts
 * as an attempt, and only the newest one draws, so a slow read for an older
 * query never overwrites a newer one. A read that fails shows Try again,
 * which searches the box's current text afresh. isCurrent() turns false once
 * the router has replaced this screen, so a late read draws nothing.
 * Returns a promise for the first search, which never rejects.
 */
export function mountSearch({
  main,
  isCurrent = () => true,
  load = listEntries,
}) {
  const root = main.querySelector('.search');
  const form = main.querySelector('[data-search-form]');
  const view = main.querySelector('[data-search-view]');
  const input = main.querySelector('#search-query');
  if (!view || !input) {
    throw new Error('The Search screen markup is incomplete.');
  }

  let attempt = 0;

  const show = (state) => {
    if (!isCurrent()) return;
    if (root) root.setAttribute('data-status', shownStatus(state));
    view.innerHTML = renderSearchView(state);
  };

  function search() {
    const mine = ++attempt;
    const query = String(input.value ?? '');
    if (query.trim() === '') {
      show({ status: 'idle', query });
      return Promise.resolve();
    }
    let pending;
    try {
      pending = Promise.resolve(load());
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (entries) => {
        if (mine !== attempt) return;
        show({ status: 'done', query, entries: Array.isArray(entries) ? entries : [] });
      },
      () => {
        if (mine !== attempt) return;
        show({ status: 'error', query });
      },
    );
  }

  input.addEventListener('input', () => {
    search();
  });

  /* Enter searches too, and never reloads the page. */
  if (form) {
    form.addEventListener('submit', (event) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      search();
    });
  }

  view.addEventListener('click', (event) => {
    const from = event.target && typeof event.target.closest === 'function' ? event.target : null;
    const target = from ? from.closest('[data-action]') : null;
    if (target && target.getAttribute('data-action') === 'retry') search();
  });

  input.focus();
  return search();
}

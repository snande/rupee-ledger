/*
 * The Today screen: the Today and This month total cards, today's spends
 * under them and a quick-entry box pinned at the bottom. renderToday(state)
 * returns the whole screen for the router to put into <main>; mountToday()
 * then loads the entries from the on-device ledger and keeps the view in step
 * with the load and with every spend typed in.
 *
 * State: { status: 'empty' | 'loading' | 'error' | 'filled',
 *          entries?: [{ id, amountPaise, note, timestamp }], message?: string,
 *          now?: Date }.
 * `entries` is every known entry; the totals are summed from all of them and
 * the list shows the ones dated today, on the device's calendar.
 * Amounts are integer paise and are only ever shown in rupees with ₹.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { parseEntry } from '../../src/parse-entry.js';
import { formatRupees, totals } from '../../src/totals.js';
import { loadEntries, saveEntry } from '../data/ledger.js';

export { formatRupees };

export const STATUSES = ['empty', 'loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'Today’s spends did not open.';
export const ENTRY_HINT = 'Amount first, then what it was for';
export const INVALID_HINT = 'Start with the amount, like 120 chai';
export const SAVE_FAILED_HINT = 'That spend was not saved. Press Enter to try again.';

const SKELETON_ROWS = 3;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* True when the entry is dated on the same local calendar day as `now`. An
   entry without a usable date is not today's, as it counts in no total. */
export function isToday(entry, now = new Date()) {
  const at = new Date(entry?.timestamp ?? entry?.ts ?? NaN);
  if (Number.isNaN(at.getTime())) return false;
  return at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
}

function normalise(state) {
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const now = state.now instanceof Date ? state.now : new Date();
  const listed = entries.filter((entry) => isToday(entry, now));
  return { status, entries, listed, now };
}

/* What the screen shows as a whole: any spends listed for today make it
   'filled', even while a load is still pending or has failed below the list. */
export function shownStatus(state = {}) {
  const { status, listed } = normalise(state);
  return listed.length > 0 ? 'filled' : status === 'filled' ? 'empty' : status;
}

function entryRow(entry, newestId) {
  const isNew = newestId !== undefined && newestId !== null && entry.id === newestId;
  const note = entry.note
    ? '<span class="entry-note">' + escapeHtml(entry.note) + '</span>'
    : '<span class="entry-note entry-note-empty">No note</span>';
  return '<li class="entry-row' + (isNew ? ' entry-new' : '') + '">' +
    note +
    '<span class="amount entry-amount">' + formatRupees(entry.amountPaise) + '</span>' +
    '</li>';
}

/* One total card: a 12px muted label above a 28px mono amount. While the
   first load is pending and nothing is known yet, a skeleton bar stands in
   for the amount rather than a ₹0 that is not true. */
function totalCard(key, label, paise, pending) {
  const value = pending
    ? '<span class="skeleton-bar total-skeleton" aria-hidden="true"></span>'
    : '<span class="amount total-amount" data-' + key + '-total>' + formatRupees(paise) + '</span>';
  return '<p class="card total-card' + (key === 'today' ? ' total-card-today' : '') + '">' +
    '<span class="total-label">' + label + '</span>' +
    value +
  '</p>';
}

/* The Today and This month cards, side by side at the top of the screen and
   shown in every state, summed with totals() from src/totals.js. */
export function totalsView(entries, now = new Date(), pending = false) {
  const sums = totals(entries, now);
  return '<section class="today-totals" aria-label="Totals"' + (pending ? ' aria-busy="true"' : '') + '>' +
    totalCard('today', 'Today', sums.today, pending) +
    totalCard('month', 'This month', sums.month, pending) +
  '</section>';
}

function listView(entries, newestId) {
  const count = entries.length === 1 ? '1 spend' : entries.length + ' spends';
  return '<section class="card today-list" aria-labelledby="today-list-label">' +
    '<p class="today-list-heading">' +
      '<span class="today-list-label" id="today-list-label">Spent today</span>' +
      '<span class="today-list-count">' + count + '</span>' +
    '</p>' +
    '<ul class="entry-list">' + entries.map((entry) => entryRow(entry, newestId)).join('') + '</ul>' +
  '</section>';
}

function emptyView() {
  return '<section class="card today-empty" aria-labelledby="today-empty-heading">' +
    '<h2 id="today-empty-heading">No spends yet today</h2>' +
    '<p>Type what you spent, like <span class="amount">120</span> chai, and press Enter.</p>' +
    '<button type="button" class="button-secondary today-cta" data-action="focus-entry">' +
      'Add your first spend <span aria-hidden="true">↓</span>' +
    '</button>' +
  '</section>';
}

/* Paper-tone placeholder rows; smaller when real rows are already shown. */
function loadingView(compact) {
  const rows = compact ? 1 : SKELETON_ROWS;
  let skeleton = '';
  for (let i = 0; i < rows; i += 1) {
    skeleton += '<li class="skeleton-row"><span class="skeleton-bar skeleton-note"></span><span class="skeleton-bar skeleton-amount"></span></li>';
  }
  return '<section class="card today-loading" aria-busy="true" aria-labelledby="today-loading-label">' +
    '<p class="visually-hidden" id="today-loading-label" role="status">Opening today’s spends</p>' +
    '<ul class="skeleton-list" aria-hidden="true">' + skeleton + '</ul>' +
  '</section>';
}

function errorView(message) {
  return '<section class="card today-error" role="alert" aria-labelledby="today-error-message">' +
    '<p class="today-error-message" id="today-error-message">' + escapeHtml(message || ERROR_MESSAGE) + '</p>' +
    '<p class="hint">Nothing is lost. Your spends stay on this phone. Try again, and if it keeps happening, reload the app.</p>' +
    '<button type="button" class="button-secondary" data-action="retry">Try again</button>' +
  '</section>';
}

/* The part of the screen that follows the state. The total cards come
   first in every state; today's spends already known are listed whatever
   the status; loading and error add their block below, and a screen with no
   spends today that is not loading or failing shows the prompt. */
export function renderTodayView(state = {}) {
  const { status, entries, listed, now } = normalise(state);
  const parts = [totalsView(entries, now, status === 'loading' && entries.length === 0)];
  if (listed.length > 0) parts.push(listView(listed, state.newestId));
  if (status === 'loading') parts.push(loadingView(listed.length > 0));
  else if (status === 'error') parts.push(errorView(state.message));
  else if (listed.length === 0) parts.push(emptyView());
  return parts.join('');
}

/* The router calls this with no state, so the screen opens on the skeleton;
   mountToday starts the load in the same task and replaces it once the
   promise settles. */
export function renderToday(state = { status: 'loading' }) {
  return '<div class="today" data-status="' + shownStatus(state) + '">' +
    '<div class="today-view" data-today-view>' + renderTodayView(state) + '</div>' +
    '<form class="today-entry" data-today-form novalidate>' +
      '<label for="quick-entry">Add a spend</label>' +
      '<div class="today-entry-row">' +
        '<input class="quick-entry" id="quick-entry" name="entry" type="text" placeholder="120 chai" ' +
          'autocomplete="off" autocapitalize="off" enterkeyhint="done" aria-describedby="quick-entry-hint">' +
        '<button type="submit">Add</button>' +
      '</div>' +
      '<p class="hint" id="quick-entry-hint">' + ENTRY_HINT + '</p>' +
      '<p class="visually-hidden" role="status" data-entry-status></p>' +
    '</form>' +
  '</div>';
}

/*
 * Wires the rendered screen: focuses the entry box, loads the entries and
 * maps the promise onto the views (pending → loading, [] → empty, entries →
 * filled, rejected → error with Try again). Enter adds the typed spend at the
 * top and re-renders both totals in the same task, clears the box and keeps
 * focus there, then hands the spend to save(), which writes it to the
 * on-device ledger. This submit handler is the one save path in the app, so
 * it is where the totals hook in. A save that fails takes the spend back out
 * of the list and totals, puts the text back in an empty box and says so.
 * Spends added here stay listed across Try again, above whatever the load
 * brings back, until the load returns their stored copy. isCurrent() turns
 * false once the router has replaced this screen, so a late load writes
 * nothing. Returns the first load's promise, which never rejects.
 */
export function mountToday({
  main,
  query = new URLSearchParams(),
  isCurrent = () => true,
  load = loadEntries,
  save = saveEntry,
}) {
  const root = main.querySelector('.today');
  const view = main.querySelector('[data-today-view]');
  const form = main.querySelector('[data-today-form]');
  const input = main.querySelector('#quick-entry');
  const hint = main.querySelector('#quick-entry-hint');
  const announcer = main.querySelector('[data-entry-status]');
  if (!view || !form || !input || !hint) {
    throw new Error('The Today screen markup is incomplete.');
  }

  let status = 'loading';
  let loaded = [];
  let added = [];
  let newestId = null;
  let attempt = 0;
  let addedCount = 0;

  const show = () => {
    if (!isCurrent()) return;
    const state = { status, entries: added.concat(loaded), newestId };
    if (root) root.setAttribute('data-status', shownStatus(state));
    view.innerHTML = renderTodayView(state);
  };

  const setHint = (text, invalid) => {
    hint.textContent = text;
    hint.classList.toggle('hint-error', invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  const announce = (text) => {
    if (announcer) announcer.textContent = text;
  };

  /* Drops each added spend the load has already brought back from the
     ledger, so no spend is listed or counted twice. True if any went. */
  const settle = () => {
    const stored = new Set(loaded.map((entry) => entry.id));
    const before = added.length;
    added = added.filter((entry) => entry.ledgerId === undefined || !stored.has(entry.ledgerId));
    return added.length !== before;
  };

  function persist(entry, text) {
    let saving;
    try {
      saving = Promise.resolve(save(entry, query));
    } catch (error) {
      saving = Promise.reject(error);
    }
    saving.then(
      (stored) => {
        if (stored && stored.id !== undefined && stored.id !== null) entry.ledgerId = stored.id;
        if (settle()) show();
      },
      () => {
        added = added.filter((item) => item !== entry);
        if (newestId === entry.id) newestId = null;
        show();
        if (!isCurrent()) return;
        if (input.value === '') input.value = text;
        setHint(SAVE_FAILED_HINT, true);
        announce(SAVE_FAILED_HINT);
      },
    );
  }

  /* Restart the shake animation, so each bad Enter shakes once. */
  const shake = () => {
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
  };

  function start() {
    const mine = ++attempt;
    status = 'loading';
    show();
    let pending;
    try {
      pending = Promise.resolve(load(query));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      (entries) => {
        if (mine !== attempt) return;
        loaded = Array.isArray(entries) ? entries : [];
        status = loaded.length > 0 ? 'filled' : 'empty';
        settle();
        show();
      },
      () => {
        if (mine !== attempt) return;
        loaded = [];
        status = 'error';
        show();
      },
    );
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
      setHint(INVALID_HINT, true);
      shake();
      announce(INVALID_HINT);
      input.focus();
      return;
    }
    addedCount += 1;
    const entry = {
      id: 'added-' + addedCount,
      amountPaise: parsed.amountPaise,
      note: parsed.note,
      timestamp: Date.now(),
    };
    added = [entry].concat(added);
    newestId = entry.id;
    input.value = '';
    setHint(ENTRY_HINT, false);
    show();
    announce('Added ' + formatRupees(entry.amountPaise) + (entry.note ? ' ' + entry.note : ''));
    input.focus();
    persist(entry, text);
  });

  /* Live preview under the box: '₹120 · chai' while the line parses. */
  input.addEventListener('input', () => {
    const text = input.value;
    const parsed = text.trim() === '' ? null : parseEntry(text);
    if (parsed) setHint(formatRupees(parsed.amountPaise) + (parsed.note ? ' · ' + parsed.note : ''), false);
    else setHint(ENTRY_HINT, false);
  });

  input.addEventListener('animationend', () => input.classList.remove('shake'));

  view.addEventListener('click', (event) => {
    const target = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-action]')
      : null;
    const action = target ? target.getAttribute('data-action') : null;
    if (action === 'retry') start();
    else if (action === 'focus-entry') input.focus();
  });

  input.focus();
  return start();
}

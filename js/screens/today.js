/*
 * The Today screen: today's spends above a quick-entry box pinned at the
 * bottom. renderToday(state) returns the whole screen for the router to put
 * into <main>; mountToday() then loads the entries and keeps the view in step
 * with the load and with every spend typed in.
 *
 * State: { status: 'empty' | 'loading' | 'error' | 'filled',
 *          entries?: [{ id, amountPaise, note }], message?: string }.
 * Amounts are integer paise and are only ever shown in rupees with ₹.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { parseEntry } from '../../src/parse-entry.js';
import { loadEntries } from '../data/stub.js';

export const STATUSES = ['empty', 'loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'Today’s spends did not open.';
export const ENTRY_HINT = 'Amount first, then what it was for';
export const INVALID_HINT = 'Start with the amount, like 120 chai';

const SKELETON_ROWS = 3;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Indian digit grouping (₹1,23,450), with paise only when there are any. */
export function formatRupees(amountPaise) {
  const paise = Math.max(0, Math.round(Number(amountPaise) || 0));
  const rupees = String(Math.floor(paise / 100));
  const fraction = paise % 100;
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const whole = rest ? rest + ',' + lastThree : lastThree;
  return '₹' + whole + (fraction ? '.' + String(fraction).padStart(2, '0') : '');
}

export function totalPaise(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.amountPaise) || 0), 0);
}

function normalise(state) {
  const status = STATUSES.includes(state.status) ? state.status : 'loading';
  const entries = Array.isArray(state.entries) ? state.entries : [];
  return { status, entries };
}

/* What the screen shows as a whole: any listed spends make it 'filled',
   even while a load is still pending or has failed below the list. */
export function shownStatus(state = {}) {
  const { status, entries } = normalise(state);
  return entries.length > 0 ? 'filled' : status === 'filled' ? 'empty' : status;
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

function listView(entries, newestId) {
  const count = entries.length === 1 ? '1 spend' : entries.length + ' spends';
  return '<section class="card today-list" aria-labelledby="today-total-label">' +
    '<p class="today-total">' +
      '<span class="today-total-label" id="today-total-label">Spent today</span>' +
      '<span class="amount today-total-amount" data-today-total>' + formatRupees(totalPaise(entries)) + '</span>' +
      '<span class="today-total-count">' + count + '</span>' +
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
    (compact ? '' : '<span class="skeleton-bar skeleton-total" aria-hidden="true"></span>') +
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

/* The part of the screen that follows the state. Spends already known are
   listed whatever the status; loading and error add their block below, and
   a screen with no spends that is not loading or failing shows the prompt. */
export function renderTodayView(state = {}) {
  const { status, entries } = normalise(state);
  const parts = [];
  if (entries.length > 0) parts.push(listView(entries, state.newestId));
  if (status === 'loading') parts.push(loadingView(entries.length > 0));
  else if (status === 'error') parts.push(errorView(state.message));
  else if (entries.length === 0) parts.push(emptyView());
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
 * top and re-renders the total in the same task, clears the box and keeps
 * focus there. Spends added here stay listed across Try again, above
 * whatever the load brings back. isCurrent() turns false once the router has
 * replaced this screen, so a late load writes nothing. Returns the first
 * load's promise, which never rejects.
 */
export function mountToday({ main, query = new URLSearchParams(), isCurrent = () => true, load = loadEntries }) {
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
    const entry = { id: 'added-' + addedCount, amountPaise: parsed.amountPaise, note: parsed.note };
    added = [entry].concat(added);
    newestId = entry.id;
    input.value = '';
    setHint(ENTRY_HINT, false);
    show();
    announce('Added ' + formatRupees(entry.amountPaise) + (entry.note ? ' ' + entry.note : ''));
    input.focus();
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

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
 * the list shows the ones dated today, on the device's calendar. The totals
 * are only shown once a load has succeeded: before that the ledger's sums
 * are not known, so the cards show a skeleton while loading and a dash after
 * a failed load, never a ₹0 or a part-sum that may not be true.
 * Amounts are integer paise and are only ever shown in rupees with ₹.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { formatPaise } from '../../src/format-amount.js';
import { parseEntry } from '../../src/parse-entry.js';
import { INVALID_HINT, showHint, spendLabel, wireQuickEntry } from '../../src/quick-entry.js';
import { totals } from '../../src/totals.js';
import { ledgerFor, loadEntries } from '../data/ledger.js';

export { formatPaise, INVALID_HINT };

export const STATUSES = ['empty', 'loading', 'error', 'filled'];
export const ERROR_MESSAGE = 'Today’s spends did not open.';
export const ENTRY_HINT = 'Amount first, then what it was for';

const SKELETON_ROWS = 3;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* What the hint and the announcer say when a spend could not be stored,
   naming the spend so it can be typed again. `restored` is true when its
   text went back into the entry box. */
export function saveFailedHint(entry, restored) {
  return spendLabel(entry) + ' was not saved. ' + (restored ? 'Press Enter to try again.' : 'Type it again to save it.');
}

/* True when the entry is dated on the same local calendar day as `now`. It
   reads the same `timestamp`, falling back to `ts`, that totals() in
   src/totals.js sums by, so the list and the Today total always agree. An
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
    '<span class="amount entry-amount">' + formatPaise(entry.amountPaise) + '</span>' +
    '</li>';
}

/* One total card: a 12px muted label above a 28px mono amount. `known` is
   'yes' once a load has succeeded; 'pending' draws a skeleton bar while the
   first load runs, and 'no' a dash after a failed one. */
function totalCard(key, label, paise, known) {
  let value;
  if (known === 'pending') {
    value = '<span class="skeleton-bar total-skeleton" aria-hidden="true"></span>';
  } else if (known === 'no') {
    value = '<span class="amount total-amount total-unknown" data-' + key + '-total aria-hidden="true">—</span>' +
      '<span class="visually-hidden">not known</span>';
  } else {
    value = '<span class="amount total-amount" data-' + key + '-total>' + formatPaise(paise) + '</span>';
  }
  return '<p class="card total-card' + (key === 'today' ? ' total-card-today' : '') + '">' +
    '<span class="total-label">' + label + '</span>' +
    value +
  '</p>';
}

/* The Today and This month cards, side by side at the top of the screen and
   shown in every state, summed with totals() from src/totals.js. */
export function totalsView(entries, now = new Date(), known = 'yes') {
  const sums = totals(entries, now);
  return '<section class="today-totals" aria-label="Totals"' + (known === 'pending' ? ' aria-busy="true"' : '') + '>' +
    totalCard('today', 'Today', sums.today, known) +
    totalCard('month', 'This month', sums.month, known) +
  '</section>';
}

/* Under the totals, the way to this month's split by category. */
function monthLink() {
  return '<a class="today-month-link" href="#/month">This month by category <span aria-hidden="true">→</span></a>';
}

function listView(entries, newestId) {
  const count = entries.length === 1 ? '1 spend' : entries.length + ' spends';
  return '<section class="card today-list" aria-labelledby="today-list-label">' +
    '<p class="today-list-heading">' +
      '<span class="today-list-label" id="today-list-label">Spent today</span>' +
      '<span class="today-list-count">' + count + '</span>' +
    '</p>' +
    '<ul class="entry-list" id="today-list">' + entries.map((entry) => entryRow(entry, newestId)).join('') + '</ul>' +
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
   first in every state, with sums only once the load has succeeded, then
   the link to the Month screen; today's
   spends already known are listed whatever the status; loading and error add
   their block below, and a screen with no spends today that is not loading
   or failing shows the prompt. */
export function renderTodayView(state = {}) {
  const { status, entries, listed, now } = normalise(state);
  const known = status === 'loading' ? 'pending' : status === 'error' ? 'no' : 'yes';
  const parts = [totalsView(entries, now, known), monthLink()];
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
 * filled, rejected → error with Try again). Enter goes through
 * wireQuickEntry in src/quick-entry.js, the one save path in the app: it
 * parses the line, has draw() below add the spend at the top of
 * #today-list and re-render both totals in the same task, then writes it
 * with the ledger's add() without waiting, clears the box and keeps focus
 * there. A write that fails takes the spend back out of the list and totals,
 * puts its text back in an empty box and names it in the hint. Spends added
 * here stay listed across Try again, above whatever the load brings back,
 * until the load returns their stored copy.
 * `ledger` defaults to src/ledger.js, or on a demo visit to one that stores
 * nothing. isCurrent() turns false once the router has replaced this screen,
 * so a late load writes nothing. Returns the first load's promise, which
 * never rejects.
 */
export function mountToday({
  main,
  query = new URLSearchParams(),
  isCurrent = () => true,
  load = loadEntries,
  ledger = ledgerFor(query),
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

  const setHint = (text, invalid) => showHint(hint, input, text, invalid);

  const announce = (text) => {
    if (announcer) announcer.textContent = text;
  };

  /* True when the load has brought back the stored copy of an added spend:
     by the ledger id once its save has resolved, or while the save is still
     in flight by its time, amount and note, which the save writes as is. So
     a load that reads the committed record before the save's callback runs
     still never counts the spend twice. */
  const storedCopy = (entry) => loaded.some((item) => (entry.ledgerId !== undefined
    ? item.id === entry.ledgerId
    : item.timestamp === entry.timestamp && item.amountPaise === entry.amountPaise && item.note === entry.note));

  /* Drops each added spend the load already lists. True if any went. */
  const settle = () => {
    const before = added.length;
    added = added.filter((entry) => !storedCopy(entry));
    return added.length !== before;
  };

  /* Puts a spend Enter has parsed on screen at once, and says what to do
     when its write settles. */
  function draw({ amountPaise, note, createdAt }, text) {
    addedCount += 1;
    const entry = { id: 'added-' + addedCount, amountPaise, note, timestamp: createdAt };
    added = [entry].concat(added);
    newestId = entry.id;
    show();
    announce('Added ' + spendLabel(entry));
    return {
      saved(stored) {
        if (stored && stored.id !== undefined && stored.id !== null) entry.ledgerId = stored.id;
        if (settle()) show();
      },
      failed() {
        if (!added.includes(entry)) return;
        added = added.filter((item) => item !== entry);
        if (newestId === entry.id) newestId = null;
        show();
        if (!isCurrent()) return;
        const restored = input.value === '';
        if (restored) input.value = text;
        const message = saveFailedHint(entry, restored);
        setHint(message, true);
        announce(message);
      },
    };
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

  wireQuickEntry({
    form,
    input,
    hint,
    draw,
    ledger,
    restingHint: ENTRY_HINT,
    onInvalid: () => {
      shake();
      announce(INVALID_HINT);
    },
  });

  /* Live preview under the box: '₹120 · chai' while the line parses. */
  input.addEventListener('input', () => {
    const text = input.value;
    const parsed = text.trim() === '' ? null : parseEntry(text);
    if (parsed) setHint(formatPaise(parsed.amountPaise) + (parsed.note ? ' · ' + parsed.note : ''), false);
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

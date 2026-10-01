/*
 * The Today screen: the Today and This month total cards, today's spends
 * under them and a quick-entry box pinned at the bottom. renderToday(state)
 * returns the whole screen for the router to put into <main>; mountToday()
 * then loads the entries from the on-device ledger and keeps the view in step
 * with the load and with every spend typed in.
 *
 * State: { status: 'empty' | 'loading' | 'error' | 'filled',
 *          entries?: [{ id, amountPaise, note, category, timestamp }],
 *          message?: string, now?: Date, newestId?, picking? }.
 * Each listed spend carries its category as a chip; `picking` is the id of
 * the spend whose category picker is open, if any.
 * `entries` is every known entry; the totals are summed from all of them and
 * the list shows the ones dated today, on the device's calendar. The totals
 * are only shown once a load has succeeded: before that the ledger's sums
 * are not known, so the cards show a skeleton while loading and a dash after
 * a failed load, never a ₹0 or a part-sum that may not be true.
 * Amounts are integer paise and are only ever shown in rupees with ₹.
 * Strings are joined with + rather than template literals, so the only
 * currency sign anywhere in this file is ₹.
 */

import { CATEGORIES } from '../../src/categorise.js';
import { formatPaise } from '../../src/format-amount.js';
import { parseEntry } from '../../src/parse-entry.js';
import { INVALID_HINT, showHint, spendLabel, wireQuickEntry } from '../../src/quick-entry.js';
import { totals } from '../../src/totals.js';
import { categoryOf, ledgerFor, loadEntries } from '../data/ledger.js';

export { CATEGORIES, categoryOf, formatPaise, INVALID_HINT };

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

/* True when both ids are set and name the same spend. Ids from the ledger
   are numbers and come back from the page's data attributes as strings. */
export function sameId(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

/* The picker under a chip: a listbox with one option per name in
   CATEGORIES, the current one marked with a tick and the one Tab reaches;
   the arrow keys, Home and End move between the rest. A tap on one saves
   it; there is no Save button. */
function pickerView(entry, current) {
  const id = escapeHtml(entry.id);
  const options = CATEGORIES.map((name) => {
    const selected = name === current;
    return '<li role="none">' +
      '<button type="button" class="category-option' + (selected ? ' category-option-current' : '') + '" role="option" ' +
        'aria-selected="' + selected + '" tabindex="' + (selected ? '0' : '-1') + '" ' +
        'data-action="pick-category" data-entry-id="' + id + '" data-category="' + escapeHtml(name) + '">' +
        escapeHtml(name) +
        (selected ? '<span class="category-option-mark" aria-hidden="true">✓</span>' : '') +
      '</button>' +
    '</li>';
  }).join('');
  return '<ul class="category-picker" id="category-picker-' + id + '" role="listbox" ' +
    'aria-label="Pick a category, now ' + escapeHtml(current) + '">' + options + '</ul>';
}

function entryRow(entry, newestId, picking) {
  const isNew = newestId !== undefined && newestId !== null && entry.id === newestId;
  const note = entry.note
    ? '<span class="entry-note">' + escapeHtml(entry.note) + '</span>'
    : '<span class="entry-note entry-note-empty">No note</span>';
  const id = escapeHtml(entry.id);
  const category = categoryOf(entry);
  const open = sameId(entry.id, picking);
  return '<li class="entry-row' + (isNew ? ' entry-new' : '') + '">' +
    note +
    '<span class="amount entry-amount">' + formatPaise(entry.amountPaise) + '</span>' +
    '<button type="button" class="category-chip" data-action="open-category" data-entry-id="' + id + '" ' +
      'aria-haspopup="listbox" aria-expanded="' + open + '"' + (open ? ' aria-controls="category-picker-' + id + '"' : '') + ' ' +
      'aria-label="Category: ' + escapeHtml(category) + '. Change category">' + escapeHtml(category) + '</button>' +
    (open ? pickerView(entry, category) : '') +
    '</li>';
}

/* One total card: a 12px muted label above a 28px mono amount. `known` is
   'yes' once a load has succeeded; 'pending' draws a skeleton bar while the
   first load runs, and 'no' a dash after a failed one. */
function totalCard(key, label, paise, known, extra = '') {
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
    extra +
  '</p>';
}

/* The This month card's way into the Month screen's chart. */
const MONTH_LINK = '<a class="total-link" href="#/month" data-month-link>See this month</a>';

/* The Today and This month cards, side by side at the top of the screen and
   shown in every state, summed with totals() from src/totals.js. */
export function totalsView(entries, now = new Date(), known = 'yes') {
  const sums = totals(entries, now);
  return '<section class="today-totals" aria-label="Totals"' + (known === 'pending' ? ' aria-busy="true"' : '') + '>' +
    totalCard('today', 'Today', sums.today, known) +
    totalCard('month', 'This month', sums.month, known, MONTH_LINK) +
  '</section>';
}

function listView(entries, newestId, picking) {
  const count = entries.length === 1 ? '1 spend' : entries.length + ' spends';
  return '<section class="card today-list" aria-labelledby="today-list-label">' +
    '<p class="today-list-heading">' +
      '<span class="today-list-label" id="today-list-label">Spent today</span>' +
      '<span class="today-list-count">' + count + '</span>' +
    '</p>' +
    '<ul class="entry-list" id="today-list">' + entries.map((entry) => entryRow(entry, newestId, picking)).join('') + '</ul>' +
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
   first in every state, with sums only once the load has succeeded; today's
   spends already known are listed whatever the status; loading and error add
   their block below, and a screen with no spends today that is not loading
   or failing shows the prompt. */
export function renderTodayView(state = {}) {
  const { status, entries, listed, now } = normalise(state);
  const known = status === 'loading' ? 'pending' : status === 'error' ? 'no' : 'yes';
  const parts = [totalsView(entries, now, known)];
  if (listed.length > 0) parts.push(listView(listed, state.newestId, state.picking));
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
 * Each spend's category chip opens a picker of every name in CATEGORIES. One
 * tap on another name sets it on screen at once, closes the picker and
 * writes it with the ledger's updateCategory() without waiting; a write that
 * fails puts the old category back and says so. A spend whose own save is
 * still in flight gets its category written once that save resolves.
 * Escape, or a tap outside the picker, closes it and changes nothing. The
 * picker also goes, with its document listeners, once its spend is no
 * longer listed or the router has replaced the screen.
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
  let picking = null;

  const findEntry = (id) => added.concat(loaded).find((entry) => sameId(entry.id, id));

  /* While the picker is open, Escape anywhere or a tap outside the Today
     view closes it; taps and keys inside the view are handled further down.
     Both handlers let go of the document once the screen is gone. */
  const doc = globalThis.document;
  function onDocumentKey(event) {
    if (!isCurrent() || event.key === 'Escape') closePicker(true);
  }
  function onDocumentPointer(event) {
    if (isCurrent() && typeof view.contains === 'function' && view.contains(event.target)) return;
    closePicker(false);
  }
  function listen(on) {
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const method = on ? 'addEventListener' : 'removeEventListener';
    doc[method]('keydown', onDocumentKey);
    doc[method]('pointerdown', onDocumentPointer);
  }

  /* Forgets the open picker, without drawing. */
  function dropPicker() {
    picking = null;
    listen(false);
  }

  const show = () => {
    if (!isCurrent()) {
      if (picking !== null) dropPicker();
      return;
    }
    if (picking !== null) {
      const open = findEntry(picking);
      if (!open || !isToday(open)) dropPicker();
    }
    const state = { status, entries: added.concat(loaded), newestId, picking };
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

  /* Sets a spend's category on screen: in place on a spend added here,
     whose save may still be in flight, and on a copy of a loaded one. Rows
     are matched by the screen id and the ledger id alike, so a stored copy
     listed before its added row settles changes with it. */
  const setCategory = (entry, category) => {
    const ids = [entry.id, entry.ledgerId];
    const matches = (item) => ids.some((id) => sameId(item.id, id) || sameId(item.ledgerId, id));
    for (const item of added) if (matches(item)) item.category = category;
    loaded = loaded.map((item) => (matches(item) ? { ...item, category } : item));
  };

  /* Writes a picked category to the ledger. A write that fails puts back
     the category the spend had, unless another pick has replaced it since. */
  function writeCategory(entry, ledgerId, category, before) {
    if (!ledger || typeof ledger.updateCategory !== 'function') return;
    let writing;
    try {
      writing = Promise.resolve(ledger.updateCategory(ledgerId, category));
    } catch (error) {
      writing = Promise.reject(error);
    }
    writing.catch(() => {
      const shown = findEntry(entry.id) ?? findEntry(ledgerId);
      if (!shown || categoryOf(shown) !== category) return;
      setCategory({ id: entry.id, ledgerId }, before);
      show();
      if (isCurrent()) announce('The category for ' + spendLabel(entry) + ' was not saved.');
    });
  }

  /* Puts a spend Enter has parsed on screen at once, and says what to do
     when its write settles. */
  function draw({ amountPaise, note, createdAt }, text) {
    addedCount += 1;
    const entry = { id: 'added-' + addedCount, amountPaise, note, category: categoryOf({ note }), timestamp: createdAt };
    added = [entry].concat(added);
    newestId = entry.id;
    show();
    announce('Added ' + spendLabel(entry));
    return {
      saved(stored) {
        if (stored && stored.id !== undefined && stored.id !== null) {
          entry.ledgerId = stored.id;
          /* A category picked while the save was in flight. */
          if (stored.category !== undefined && entry.category !== stored.category) {
            writeCategory(entry, stored.id, entry.category, stored.category);
          }
        }
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

  const escapeSelector = (value) => String(value).replace(/["\\]/g, (char) => '\\' + char);
  const focusIn = (selector) => {
    if (!isCurrent() || typeof view.querySelector !== 'function') return;
    view.querySelector(selector)?.focus();
  };

  function openPicker(id) {
    picking = String(id);
    show();
    if (picking === null) return;
    listen(true);
    focusIn('.category-option-current');
  }

  /* Closes the picker, if open, changing nothing. `refocus` puts focus back
     on its chip, as after Escape or a pick. */
  function closePicker(refocus) {
    if (picking === null) return;
    const id = picking;
    dropPicker();
    show();
    if (refocus) focusIn('.category-chip[data-entry-id="' + escapeSelector(id) + '"]');
  }

  /* One tap on a name: set on screen, picker closed, then written. */
  function pick(id, category) {
    const entry = findEntry(id);
    if (!entry || !CATEGORIES.includes(category) || categoryOf(entry) === category) {
      closePicker(true);
      return;
    }
    const before = categoryOf(entry);
    setCategory(entry, category);
    closePicker(true);
    announce('Category set to ' + category);
    /* A spend added here whose save has not resolved is written by saved(). */
    if (added.includes(entry) && entry.ledgerId === undefined) return;
    writeCategory(entry, entry.ledgerId ?? entry.id, category, before);
  }

  /* Arrow keys, Home and End move focus through the open picker's options. */
  function moveFocus(event) {
    const steps = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
    const step = steps[event.key];
    if (step === undefined) return false;
    const from = event.target && typeof event.target.getAttribute === 'function'
      ? CATEGORIES.indexOf(event.target.getAttribute('data-category'))
      : -1;
    const count = CATEGORIES.length;
    const next = step === 'first' ? 0
      : step === 'last' ? count - 1
        : from === -1 ? 0 : (from + step + count) % count;
    focusIn('.category-option[data-category="' + escapeSelector(CATEGORIES[next]) + '"]');
    return true;
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
    const from = event.target && typeof event.target.closest === 'function' ? event.target : null;
    const target = from ? from.closest('[data-action]') : null;
    const action = target ? target.getAttribute('data-action') : null;
    if (action === 'retry') start();
    else if (action === 'focus-entry') input.focus();
    else if (action === 'open-category') {
      const id = target.getAttribute('data-entry-id');
      if (sameId(picking, id)) closePicker(true);
      else openPicker(id);
    } else if (action === 'pick-category') {
      pick(target.getAttribute('data-entry-id'), target.getAttribute('data-category'));
    } else if (picking !== null && !(from && from.closest('.category-picker'))) {
      closePicker(false);
    }
  });

  view.addEventListener('keydown', (event) => {
    if (picking === null) return;
    let handled = true;
    if (event.key === 'Escape') closePicker(true);
    else handled = moveFocus(event);
    if (handled && typeof event.preventDefault === 'function') event.preventDefault();
  });

  input.focus();
  return start();
}

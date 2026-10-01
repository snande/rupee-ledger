/*
 * The Today screen's data source: the versioned on-device ledger in
 * src/ledger.js, behind the same boundary the stub has. loadEntries()
 * resolves this month's entries, newest first, as { id, amountPaise, note,
 * category, timestamp }: enough for the Today and This month totals and
 * today's list with its category chips. ledgerFor() names the ledger the
 * quick-entry box and the category picker write to.
 *
 * Records are written by src/ledger.js's add(), called straight from
 * src/quick-entry.js, so each carries schemaVersion 1 and its amount in
 * integer paise; no rupee conversion happens here. A record with a version the ledger does not know makes the
 * load reject, and the screen reports that rather than misreading it.
 *
 * A known `state` query, as in '#/today?state=filled', still goes to the stub
 * so each screen state can be shown on demand; those visits store nothing.
 */

import { categorise, CATEGORIES } from '../../src/categorise.js';
import * as ledger from '../../src/ledger.js';
import { listEntries, updateCategory } from '../../src/ledger/store.js';
import { currentQuery, requestedState, loadEntries as loadStubEntries } from './stub.js';

/* True when the query asks for a stub state rather than the real ledger. */
export function isDemo(query = currentQuery()) {
  return requestedState(query) !== null;
}

/* An entry's category: the one it carries, or for one without a known
   category (a record from before categories existed) the one its note maps
   to, as the ledger's own reads do. The one rule for this, shared by the
   load below and the Today screen's chips. */
export function categoryOf(entry) {
  return CATEGORIES.includes(entry?.category) ? entry.category : categorise(entry?.note ?? '');
}

/* A stored record as the screen sees it. */
export function fromRecord(record) {
  const note = record.note ?? '';
  return {
    id: record.id,
    amountPaise: record.amountPaise,
    note,
    category: categoryOf({ category: record.category, note }),
    timestamp: record.createdAt,
  };
}

export async function loadEntries(query = currentQuery(), { list = ledger.listByMonth, now = new Date() } = {}) {
  if (isDemo(query)) return loadStubEntries(query);
  const records = await list(now);
  return records.map(fromRecord).reverse();
}

/* One calendar month's entries for the Compare screen, 'YYYY-MM' as in
   '2026-09', read through src/ledger.js's listByMonth, so they come from
   the on-device store and a record with a version it does not know makes the
   load reject. The category is passed on as stored, not mapped from the
   note, so a spend stored with a blank one counts under Uncategorised. */
export async function loadMonthEntries(month, { list = ledger.listByMonth } = {}) {
  const text = String(month ?? '');
  const match = /^(\d{4})-(\d{2})/.exec(text);
  const index = match && match[0] === text ? Number(match[2]) - 1 : -1;
  if (index < 0 || index > 11) {
    throw new TypeError('Not a month: ' + JSON.stringify(month) + "; expected 'YYYY-MM'.");
  }
  const records = await list(new Date(Number(match[1]), index, 1));
  return records.map((record) => ({
    id: record.id,
    amountPaise: record.amountPaise,
    note: record.note ?? '',
    category: record.category,
    timestamp: record.createdAt,
  }));
}

/* Every stored entry from every month, for the Search screen, read through
   src/ledger/store.js's listEntries, so they come from the on-device store
   and nothing leaves the phone. Records written by src/ledger.js carry
   `amountPaise`; ones written by the store's addEntry carry `amount`, also
   in integer paise. */
export async function loadAllEntries({ list = listEntries } = {}) {
  const records = await list();
  return records.map((record) => ({
    id: record.id,
    amountPaise: Number.isSafeInteger(record.amountPaise) ? record.amountPaise : record.amount,
    note: record.note ?? '',
    category: record.category,
    timestamp: record.createdAt,
  }));
}

/* On a demo visit Enter and the category picker still show the change, but
   nothing is stored. */
const DEMO_LEDGER = Object.freeze({ add: async () => null, updateCategory: async () => null });

/* The real ledger: src/ledger.js's add() for the quick-entry box and the
   store's updateCategory() for the category picker. */
const LEDGER = Object.freeze({ ...ledger, updateCategory });

/* The ledger the Today screen writes to: the real one, or on a demo visit
   one whose add() and updateCategory() store nothing and resolve null. */
export function ledgerFor(query = currentQuery()) {
  return isDemo(query) ? DEMO_LEDGER : LEDGER;
}

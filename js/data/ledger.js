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
import { updateCategory } from '../../src/ledger/store.js';
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

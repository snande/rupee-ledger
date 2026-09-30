/*
 * The Today screen's data source: the versioned on-device ledger in
 * src/ledger.js, behind the same boundary the stub has. loadEntries()
 * resolves this month's entries, newest first, as { id, amountPaise, note,
 * timestamp }: enough for the Today and This month totals and today's list.
 * ledgerFor() names the ledger the quick-entry box writes to.
 *
 * Records are written by src/ledger.js's add(), called straight from
 * src/quick-entry.js, so each carries schemaVersion 1 and its amount in
 * integer paise; no rupee conversion happens here. A record with a version the ledger does not know makes the
 * load reject, and the screen reports that rather than misreading it.
 *
 * A known `state` query, as in '#/today?state=filled', still goes to the stub
 * so each screen state can be shown on demand; those visits store nothing.
 */

import * as ledger from '../../src/ledger.js';
import { currentQuery, requestedState, loadEntries as loadStubEntries } from './stub.js';

/* True when the query asks for a stub state rather than the real ledger. */
export function isDemo(query = currentQuery()) {
  return requestedState(query) !== null;
}

/* A stored record as the screen sees it. */
export function fromRecord(record) {
  return {
    id: record.id,
    amountPaise: record.amountPaise,
    note: record.note ?? '',
    timestamp: record.createdAt,
  };
}

export async function loadEntries(query = currentQuery(), { list = ledger.listByMonth, now = new Date() } = {}) {
  if (isDemo(query)) return loadStubEntries(query);
  const records = await list(now);
  return records.map(fromRecord).reverse();
}

/* On a demo visit Enter still shows the spend, but nothing is stored. */
const DEMO_LEDGER = Object.freeze({ add: async () => null });

/* The ledger the quick-entry box writes to: src/ledger.js itself, or on a
   demo visit one whose add() stores nothing and resolves null. */
export function ledgerFor(query = currentQuery()) {
  return isDemo(query) ? DEMO_LEDGER : ledger;
}

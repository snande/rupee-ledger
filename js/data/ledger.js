/*
 * The Today screen's data source: the on-device ledger in
 * src/ledger/store.js, behind the same boundary the stub had. loadEntries()
 * resolves every stored entry, newest first, as { id, amountPaise, note,
 * timestamp }; saveEntry() writes one entry the screen has just shown.
 *
 * The store keeps `amount` in integer paise and `createdAt` in epoch
 * milliseconds. The screen and the totals in src/totals.js read `amountPaise`
 * and `timestamp` (a bare `amount` there means rupees), so this module is the
 * one place the two shapes meet. The stored record shape is unchanged.
 *
 * A known `state` query, as in '#/today?state=filled', still goes to the stub
 * so each screen state can be shown on demand; those visits store nothing.
 */

import { addEntry, listEntries } from '../../src/ledger/store.js';
import { STUB_STATES, loadEntries as loadStubEntries } from './stub.js';

function currentQuery() {
  const hash = String(globalThis.location?.hash ?? '');
  const at = hash.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : hash.slice(at + 1));
}

/* True when the query asks for a stub state rather than the real ledger. */
export function isDemo(query = currentQuery()) {
  const state = query && typeof query.get === 'function' ? query.get('state') : null;
  return STUB_STATES.includes(state);
}

/* A stored record as the screen sees it. */
export function fromRecord(record) {
  return {
    id: record.id,
    amountPaise: record.amount,
    note: record.note ?? '',
    timestamp: record.createdAt,
  };
}

export async function loadEntries(query = currentQuery(), { list = listEntries } = {}) {
  if (isDemo(query)) return loadStubEntries(query);
  const records = await list();
  return records.map(fromRecord).reverse();
}

/* Resolves with the stored entry, carrying the ledger's id, once the write
   has committed; resolves null on a demo visit, which stores nothing. */
export async function saveEntry(entry, query = currentQuery(), { add = addEntry } = {}) {
  if (isDemo(query)) return null;
  const record = await add({
    amount: entry.amountPaise / 100,
    note: entry.note,
    createdAt: entry.timestamp,
  });
  return fromRecord(record);
}

// Startup for the on-device ledger: open the database, read back every
// stored entry, and ask the browser to keep that storage.
//
// Without persistent storage a browser under storage pressure (common on
// cheap phones) may evict IndexedDB, and with it every entry. So the app
// asks for persistence on each start. A refusal only affects future
// eviction; it never stops the stored entries loading. An IndexedDB that
// will not open is different: nothing can be shown or saved, so that
// failure is surfaced for the UI to report rather than swallowed.
//
// Nothing here touches the network, so startup works fully offline.

import { openLedger, listEntries } from './store.js';

/**
 * Opens the ledger and loads every stored entry, oldest first, while
 * requesting persistent storage in parallel.
 * @returns {Promise<{ entries: Array<{ id: number, amount: number,
 *   note: string, category: string, createdAt: number }>,
 *   persisted: boolean }>}  `persisted` is true only when the browser
 *   granted persistent storage.
 * @throws {Error} whose message contains `ledger storage unavailable` when
 *   IndexedDB cannot be opened.
 */
export async function initLedger() {
  const persisting = requestPersistence();

  try {
    await openLedger();
  } catch (cause) {
    throw new Error(`ledger storage unavailable: ${cause?.message ?? String(cause)}`, { cause });
  }

  const [entries, persisted] = await Promise.all([listEntries(), persisting]);
  return { entries, persisted };
}

// Resolves true only if the browser grants persistent storage. A missing
// API, a refusal or an error all count as not persisted, and none of them
// throw.
async function requestPersistence() {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

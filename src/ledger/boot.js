// Startup for the on-device ledger: open the database, read back every
// stored entry, and ask the browser to keep that storage.
//
// Without persistent storage a browser under storage pressure (common on
// cheap phones) may evict IndexedDB, and with it every entry. So the app
// asks for persistence on each start. A refusal only affects future
// eviction; it never stops the stored entries loading. Some browsers answer
// `persist()` through a permission prompt the user may never act on, so the
// wait for it is bounded: past the deadline the entries load with
// `persisted: false`. An IndexedDB that will not open is different: nothing
// can be shown or saved, so that failure is surfaced for the UI to report
// rather than swallowed.
//
// Nothing here touches the network, so startup works fully offline.

import { openLedger, listEntries } from './store.js';

// How long startup waits for a `persist()` answer before loading anyway.
const PERSIST_TIMEOUT_MS = 1000;

/**
 * Opens the ledger and loads every stored entry, oldest first, while
 * requesting persistent storage in parallel.
 * @param {{ persistTimeoutMs?: number }} [options]  `persistTimeoutMs`
 *   bounds the wait for `navigator.storage.persist()`; defaults to 1000.
 * @returns {Promise<{ entries: Array<{ id: number, amount: number,
 *   note: string, category: string, createdAt: number }>,
 *   persisted: boolean }>}  `persisted` is true only when the browser
 *   granted persistent storage before the deadline.
 * @throws {Error} whose message contains `ledger storage unavailable` when
 *   IndexedDB cannot be opened.
 */
export async function initLedger({ persistTimeoutMs = PERSIST_TIMEOUT_MS } = {}) {
  const persisting = requestPersistence(persistTimeoutMs);

  try {
    await openLedger();
  } catch (cause) {
    throw new Error(`ledger storage unavailable: ${cause?.message ?? String(cause)}`, { cause });
  }

  const [entries, persisted] = await Promise.all([listEntries(), persisting]);
  return { entries, persisted };
}

// Resolves true only if the browser grants persistent storage within
// `timeoutMs`. A missing API, a refusal, an error or no answer in time all
// count as not persisted, and none of them throw.
async function requestPersistence(timeoutMs) {
  let timer;
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs, false);
    });
    return (await Promise.race([storage.persist(), deadline])) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

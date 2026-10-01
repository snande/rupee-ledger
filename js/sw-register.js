/*
 * Offline startup: registers the service worker (sw.js next to index.html,
 * by a URL relative to the page) so
 * the app shell opens with no network, and asks the browser to keep this
 * site's storage so the on-device ledger is not evicted under storage
 * pressure.
 *
 * Both are best effort. A browser without either API, a failed
 * registration or a refused persist() leaves the app working online exactly
 * as before; nothing here throws or rejects.
 */

/**
 * @param {Navigator | undefined} [nav]  defaults to the global navigator.
 * @returns {Promise<{ registered: boolean, persisted: boolean }>}  never
 *   rejects.
 */
export function startOffline(nav = globalThis.navigator) {
  return Promise.all([registerWorker(nav), persistStorage(nav)]).then(([registered, persisted]) => ({
    registered,
    persisted,
  }));
}

async function registerWorker(nav) {
  try {
    const container = nav?.serviceWorker;
    if (!container || typeof container.register !== 'function') return false;
    // Relative to the page, so the app works from any sub-path it is served on.
    await container.register('./sw.js', { scope: './' });
    return true;
  } catch {
    return false;
  }
}

async function persistStorage(nav) {
  try {
    const storage = nav?.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

/*
 * Offline startup: registers the service worker (sw.js next to index.html,
 * by a URL relative to the page) so
 * the app shell opens with no network, and asks the browser to keep this
 * site's storage so the on-device ledger is not evicted under storage
 * pressure.
 *
 * sw.js answers the app's files network-first, so a page opened online is
 * built from the deployed files and the cache only stands in offline. The
 * worker it replaces answered cache-first: an installed phone kept running
 * an old src/backup-import.js that refused every backup with "has a
 * non-numeric amount: undefined". A page loaded by such a worker is still
 * running its old modules when the new worker installs, skips waiting and
 * claims it, so when a new worker takes control of a page that already had
 * one, the page reloads once, onto the new files. A first install (no
 * controller yet) reloads nothing: those files are new.
 * Registration also asks the browser to check for a new sw.js now, rather
 * than only on a later navigation.
 *
 * Both are best effort. A browser without either API, a failed
 * registration or a refused persist() leaves the app working online exactly
 * as before; nothing here throws or rejects.
 */

/**
 * @param {Navigator | undefined} [nav]  defaults to the global navigator.
 * @param {() => void} [reload]  reloads the page; defaults to
 *   location.reload().
 * @returns {Promise<{ registered: boolean, persisted: boolean }>}  never
 *   rejects.
 */
export function startOffline(nav = globalThis.navigator, reload = () => globalThis.location?.reload()) {
  return Promise.all([registerWorker(nav, reload), persistStorage(nav)]).then(([registered, persisted]) => ({
    registered,
    persisted,
  }));
}

async function registerWorker(nav, reload) {
  try {
    const container = nav?.serviceWorker;
    if (!container || typeof container.register !== 'function') return false;
    reloadOnUpdate(container, reload);
    // Relative to the page, so the app works from any sub-path it is served on.
    const registration = await container.register('./sw.js', { scope: './' });
    try {
      // Not awaited: an offline phone fails this check, and that is fine.
      registration?.update?.()?.catch?.(() => {});
    } catch {
      // A failed update check leaves the current worker in charge.
    }
    return true;
  } catch {
    return false;
  }
}

/* Reloads the page once when a new worker takes over from the one it was
   loaded by (see the note above). The flag stops a second controllerchange
   from reloading again. */
function reloadOnUpdate(container, reload) {
  if (!container.controller || typeof container.addEventListener !== 'function') return;
  let reloading = false;
  container.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    try {
      reload();
    } catch {
      // A page that cannot reload keeps running; the next open uses the new files.
    }
  });
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

/*
 * Service worker: keeps the app shell on the device so the app opens and
 * works with no network at all.
 *
 * Registered by js/sw-register.js at startup with
 * navigator.serviceWorker.register('./sw.js', { scope: './' }).
 *
 * - install precaches every static file the app needs (ASSETS) under a
 *   versioned cache name, then takes over without waiting for old tabs.
 *   Each file is fetched with cache: 'reload', past the browser's HTTP
 *   cache, so a new version never precaches a stale copy of an old file.
 * - activate deletes every cache that is not the current version, so a new
 *   deploy (bump VERSION) replaces stale files.
 * - fetch answers same-origin GET requests cache-first, ignoring any query
 *   string; a navigation with no match gets the cached index.html, since the
 *   app routes by hash. Any other request (non-GET, another origin) is left
 *   alone: it is never intercepted or cached. Nothing is cached at request
 *   time.
 *
 * The ledger itself lives in IndexedDB, which this worker never touches.
 * Hand-written on purpose: no build step and nothing imported from a network.
 *
 * ASSETS holds exactly the modules js/app.js loads (following its imports),
 * the stylesheets, the manifest and the icons; test-only helpers stay out.
 * When one is added, removed or renamed, update ASSETS and bump VERSION;
 * sw.test.js fails if ASSETS misses a file or lists one the app does not load.
 *
 * Because fetches are answered cache-first, an installed phone keeps running
 * the files of the cache it has until sw.js itself changes. So a change to
 * ANY file in ASSETS must bump VERSION too, or phones keep the old code (a
 * fix to src/backup-import.js once shipped without a bump and never reached
 * them). ASSETS_DIGEST pins the contents VERSION was set for: sw.test.js
 * recomputes it and fails, printing the new value, when a precached file
 * changes without it. Bump VERSION and paste the new digest together.
 */

const VERSION = 'v11';
// sha-256 of the precached files' contents; see the note above and sw.test.js.
const ASSETS_DIGEST = 'c94b2b35513e76a75c401a61bec1127358bc44cbb3065846d716a46a63947806';
const CACHE = 'rupee-ledger-' + VERSION;
const SHELL = './index.html';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/controls.css',
  './js/app.js',
  './js/router.js',
  './js/sw-register.js',
  './js/data/ledger.js',
  './js/screens/backup.js',
  './js/screens/compare.js',
  './js/screens/month.js',
  './js/screens/not-found.js',
  './js/screens/search.js',
  './js/screens/today.js',
  './src/backup-download.js',
  './src/backup-export.js',
  './src/backup-import.js',
  './src/categorise.js',
  './src/category-totals.js',
  './src/compare-months.js',
  './src/format-amount.js',
  './src/ledger.js',
  './src/ledger/store.js',
  './src/parse-entry.js',
  './src/quick-entry.js',
  './src/search.js',
  './src/totals.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fromCache(request));
});

async function fromCache(request) {
  // Precached files carry no query string, so `app.js?v=2` is still `app.js`.
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const shell = await caches.match(SHELL);
    if (shell) return shell;
  }
  return fetch(request);
}

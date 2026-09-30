/*
 * Service worker: keeps the app shell on the device so the app opens and
 * works with no network at all.
 *
 * Registered by js/sw-register.js at startup with
 * navigator.serviceWorker.register('./sw.js', { scope: './' }).
 *
 * - install precaches every static file the app needs (ASSETS) under a
 *   versioned cache name, then takes over without waiting for old tabs.
 * - activate deletes every cache that is not the current version, so a new
 *   deploy (bump VERSION) replaces stale files.
 * - fetch answers same-origin GET requests cache-first; a navigation with
 *   no exact match gets the cached index.html, since the app routes by hash.
 *   Any other request (non-GET, another origin) is left alone: it is never
 *   intercepted or cached. Nothing is cached at request time.
 *
 * The ledger itself lives in IndexedDB, which this worker never touches.
 * Hand-written on purpose: no build step and nothing imported from a network.
 *
 * When a file is added, removed or renamed, update ASSETS and bump VERSION;
 * sw.test.js fails if ASSETS misses a file or lists one that does not exist.
 */

const VERSION = 'v1';
const CACHE = 'rupee-ledger-' + VERSION;
const SHELL = './index.html';

const ASSETS = [
  './',
  './index.html',
  './css/tokens.css',
  './css/controls.css',
  './js/app.js',
  './js/router.js',
  './js/sw-register.js',
  './js/data/stub.js',
  './js/screens/not-found.js',
  './js/screens/today.js',
  './src/format-amount.js',
  './src/ledger.js',
  './src/ledger/boot.js',
  './src/ledger/store.js',
  './src/parse-entry.js',
  './src/totals.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
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
  const cached = await caches.match(request);
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const shell = await caches.match(SHELL);
    if (shell) return shell;
  }
  return fetch(request);
}

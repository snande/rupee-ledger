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
 * - fetch answers a precached file, or a navigation, network-first: the
 *   network copy is fetched with cache: 'no-cache' (the server revalidates
 *   it, so the HTTP cache never hands back an old file), stored in the
 *   current cache under its URL without the query string, and returned.
 *   When the network fails, answers with an error or redirect, or takes
 *   longer than NETWORK_TIMEOUT_MS, the cached copy is served instead,
 *   ignoring any query string; a navigation with no match gets the cached
 *   index.html, since the app routes by hash. Any other same-origin GET is
 *   served from the cache if it is there and from the network otherwise,
 *   and is never cached. Non-GET and other-origin requests are left alone.
 *
 * Network-first is what puts a fix in front of the user. This worker used
 * to answer cache-first, so an installed phone kept running the files of
 * the cache it had: in test #91 phone B went on refusing every backup with
 * "Backup entry 1 has a non-numeric amount: undefined", a message the
 * deployed src/backup-import.js can no longer produce. Now an app opened
 * online loads the deployed files, and the cache only stands in offline.
 *
 * The ledger itself lives in IndexedDB, which this worker never touches.
 * Hand-written on purpose: no build step and nothing imported from a network.
 *
 * ASSETS holds exactly the modules js/app.js loads (following its imports),
 * the stylesheets, the manifest and the icons; test-only helpers stay out.
 * When one is added, removed or renamed, update ASSETS and bump VERSION;
 * sw.test.js fails if ASSETS misses a file or lists one the app does not load.
 *
 * A change to ANY file in ASSETS must still bump VERSION, so a phone that
 * only ever opens the app offline after the update precaches the new files
 * in one go rather than a mix of old and new. ASSETS_DIGEST pins the
 * contents VERSION was set for: sw.test.js recomputes it and fails,
 * printing the new value, when a precached file changes without it. Bump
 * VERSION and paste the new digest together.
 */

const VERSION = 'v13';
// sha-256 of the precached files' contents; see the note above and sw.test.js.
const ASSETS_DIGEST = '0174161289129556f0754248073c8c91d3ef658e58e8e785f8826c13a3a7f28c';
const CACHE = 'rupee-ledger-' + VERSION;
const SHELL = './index.html';
// How long a fetch may take before the cached copy is served instead.
const NETWORK_TIMEOUT_MS = 3000;

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

// The precached files' URLs, without query strings.
const PRECACHED = new Set(ASSETS.map((asset) => new URL(asset, self.location).href));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(request));
});

async function respond(request) {
  const url = withoutSearch(request.url);
  const navigate = request.mode === 'navigate';
  if (navigate || PRECACHED.has(url)) {
    const fresh = await fromNetwork(request.url);
    if (fresh) {
      if (PRECACHED.has(url)) await store(url, fresh);
      return fresh;
    }
  }
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (navigate) {
    const shell = await caches.match(SHELL);
    if (shell) return shell;
  }
  return fetch(request);
}

// The server's current copy of `href`, or null when the network fails, is
// too slow, or answers with an error or a redirect.
async function fromNetwork(href) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetch(href, { cache: 'no-cache' }), timeout]);
    return response && response.ok && !response.redirected ? response : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Keeps the fresh copy for offline use; a failed write leaves the old one.
async function store(url, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(url, response.clone());
  } catch {
    // The cached copy stays as it was.
  }
}

function withoutSearch(href) {
  const url = new URL(href);
  url.search = '';
  return url.href;
}

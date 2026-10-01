/*
 * Service worker: keeps the app shell on the device so the app opens and
 * works with no network at all, and puts each deploy in front of the user
 * the next time the app is opened online.
 *
 * Registered by js/sw-register.js at startup with
 * navigator.serviceWorker.register('./sw.js', { scope: './' }).
 *
 * The files live in "sets": caches named PREFIX + a number that grows with
 * each set, each holding every file in ASSETS, all from one moment of the
 * server. A set is written with cache.addAll, which stores all of its files
 * or none, so a set that holds the shell holds everything.
 *
 * - install writes the first set, fetching each file with cache: 'reload'
 *   (past the browser's HTTP cache, so no stale copy is stored), then takes
 *   over without waiting for old tabs.
 * - activate deletes every cache that is not a set of this VERSION, and
 *   claims open pages. When it deleted a cache of an earlier VERSION (a
 *   phone upgrading from an older worker), it then reloads every open app
 *   window with WindowClient.navigate, onto the new files. A first install
 *   has no such cache and reloads nothing.
 * - a navigation (opening the app) first tries to write a new set from the
 *   network, with cache: 'no-cache' so the server revalidates every file.
 *   If that finishes within NETWORK_TIMEOUT_MS, the page and all of its
 *   files come from the new set; if the network fails, answers any file
 *   with an error, or is too slow, they all come from the newest set already
 *   on the phone (a refresh still running goes on, for the next open). The
 *   page is pinned to the set it was served from, and every file it then
 *   asks for comes from that same set, so a page never runs a mix of old and
 *   new modules. A navigation to a URL the set lacks gets its index.html,
 *   since the app routes by hash. The two newest sets are kept; older ones
 *   are deleted.
 * - any other same-origin GET is answered from the page's set, ignoring any
 *   query string; one the set lacks goes to the network and is never cached.
 *   Non-GET and other-origin requests are left alone.
 *
 * This replaces `fromCache`, which answered every request cache-first: an
 * installed phone kept running the files of the cache it had until sw.js
 * itself changed, so in test #91 phone B went on refusing every backup with
 * "Backup entry 1 has a non-numeric amount: undefined", a message the
 * deployed src/backup-import.js can no longer produce. A page such a worker
 * loaded keeps its old modules, and its old js/sw-register.js has no hook to
 * reload when this worker takes over, so an installed app resumed from
 * memory went on refusing backups; that is why activate reloads it.
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
 * only opens the app offline after the update installs the new files.
 * ASSETS_DIGEST pins the contents VERSION was set for: sw.test.js
 * recomputes it and fails, printing the new value, when a precached file
 * changes without it. Bump VERSION and paste the new digest together.
 */

const VERSION = 'v13';
// sha-256 of the precached files' contents; see the note above and sw.test.js.
const ASSETS_DIGEST = '241298e9027b7d67d33c9691fa5ed03cc3a697c45b02a959ab1b157b94ed9e3b';
// Every cache this app has ever named starts with this, whatever its VERSION.
const APP_CACHES = 'rupee-ledger-';
const PREFIX = APP_CACHES + VERSION + '-';
const SHELL = './index.html';
// How long opening the app waits for a new set before using the newest one.
const NETWORK_TIMEOUT_MS = 3000;
// Sets kept: the newest, and the one a page opened just before it may use.
const SETS_KEPT = 2;
// Pages remembered with the set they were served from.
const PINS_KEPT = 20;

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

/* clientId -> the set that page was served from. */
const pins = new Map();
/* The refresh in progress, shared by navigations that overlap. */
let refreshing = null;

self.addEventListener('install', (event) => {
  event.waitUntil(
    writeSet('reload')
      .then((set) => {
        if (!set) throw new Error('The app files could not be stored.');
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (names) => {
      const old = names.filter((name) => !name.startsWith(PREFIX));
      await Promise.all(old.map((name) => caches.delete(name)));
      await self.clients.claim();
      if (old.some((name) => name.startsWith(APP_CACHES))) await reloadWindows();
    }),
  );
});

// Reopens every app window this worker now controls, so a page an earlier
// worker loaded runs the deployed files. Best effort: a window that cannot
// be navigated keeps running, and the next open uses the new files.
async function reloadWindows() {
  try {
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(
      windows.map(async (client) => {
        try {
          if (typeof client.navigate === 'function') await client.navigate(client.url);
        } catch {
          // Left as it is; see above.
        }
      }),
    );
  } catch {
    // No windows to reach; nothing to reload.
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    const refresh = refreshSet();
    event.waitUntil(refresh);
    event.respondWith(openPage(event, refresh));
  } else {
    event.respondWith(fromPageSet(event));
  }
});

async function openPage(event, refresh) {
  const set = (await withinTimeout(refresh)) ?? (await newestSet());
  if (set && event.resultingClientId) pin(event.resultingClientId, set);
  return (await fromSet(set, event.request)) ?? (await fromSet(set, SHELL)) ?? fetch(event.request);
}

async function fromPageSet(event) {
  const pinned = pins.get(event.clientId);
  const set = pinned && (await caches.has(pinned)) ? pinned : await newestSet();
  return (await fromSet(set, event.request)) ?? fetch(event.request);
}

// The set's copy of `request`, ignoring any query string, or undefined.
async function fromSet(set, request) {
  if (!set) return undefined;
  const cache = await caches.open(set);
  return cache.match(request, { ignoreSearch: true });
}

function pin(clientId, set) {
  pins.delete(clientId);
  pins.set(clientId, set);
  while (pins.size > PINS_KEPT) pins.delete(pins.keys().next().value);
}

// Resolves to the new set's name, or null; never rejects.
function refreshSet() {
  if (!refreshing) {
    refreshing = writeSet('no-cache')
      .then(async (set) => {
        if (set) await deleteOldSets();
        return set;
      })
      .catch(() => null)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// Writes every file in ASSETS from the network into a new set, all or
// nothing. Resolves to its name, or null (with nothing left behind).
async function writeSet(mode) {
  const stamps = (await setNames()).map(stampOf);
  const name = PREFIX + Math.max(Date.now(), ...stamps.map((stamp) => stamp + 1));
  try {
    const cache = await caches.open(name);
    await cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: mode })));
    return name;
  } catch {
    await caches.delete(name);
    return null;
  }
}

// The newest set that holds every file, or null.
async function newestSet() {
  for (const name of await setNames()) {
    if (await (await caches.open(name)).match(SHELL)) return name;
  }
  return null;
}

// Keeps the SETS_KEPT newest whole sets; deletes every other set.
async function deleteOldSets() {
  const kept = [];
  for (const name of await setNames()) {
    const whole = kept.length < SETS_KEPT && (await (await caches.open(name)).match(SHELL));
    if (whole) kept.push(name);
    else await caches.delete(name);
  }
}

// This VERSION's set names, newest first.
async function setNames() {
  const names = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && Number.isFinite(stampOf(name)));
  return names.sort((a, b) => stampOf(b) - stampOf(a));
}

function stampOf(name) {
  return Number(name.slice(PREFIX.length));
}

// `promise`'s value, or null once NETWORK_TIMEOUT_MS has passed.
async function withinTimeout(promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

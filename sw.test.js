import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('./', import.meta.url);
const SOURCE = readFileSync(new URL('./sw.js', ROOT), 'utf8');

// Served from a sub-path so the tests show every URL resolves relative to
// the worker, not the site root.
const ORIGIN = 'https://ledger.test';
const SCOPE = `${ORIGIN}/app/`;

// Precache size budget for slow phones, icons excluded.
const PRECACHE_LIMIT_BYTES = 200_000;

/*
 * Loads sw.js into a fresh context with just enough of the service worker
 * globals: a Cache Storage keyed by absolute URL and a network that records
 * every request and fails while `offline` is set. The network serves
 * `served:<path>` for a path, or what `server` (or `deploy`) gives for it:
 * a body, or `{ body, status, until }`, where `until` is a promise the
 * answer waits for. `timers` replaces setTimeout and clearTimeout.
 * cache.addAll stores all of its responses or none, as browsers do.
 */
function loadWorker({ caches: existing = {}, offline = false, server = {}, timers = {} } = {}) {
  const handlers = {};
  const network = [];
  const cacheModes = [];
  const stores = new Map(Object.entries(existing).map(([name, entries]) => [name, new Map(entries)]));
  const state = { skipWaiting: 0, claim: 0 };
  const absolute = (input) => new URL(typeof input === 'string' ? input : input.url, `${SCOPE}sw.js`).href;
  const withoutSearch = (url) => {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
  };

  const fetch = async (input, init = {}) => {
    const url = absolute(input);
    network.push(url);
    cacheModes.push(init.cache ?? (typeof input === 'string' ? 'default' : input.cache ?? 'default'));
    if (offline) throw new TypeError('Failed to fetch');
    const answer = server[withoutSearch(url).slice(SCOPE.length)] ?? `served:${withoutSearch(url).slice(SCOPE.length)}`;
    const fields = typeof answer === 'string' ? { body: answer } : answer;
    if (fields.until) await fields.until;
    const status = fields.status ?? 200;
    return { body: fields.body, status, ok: status >= 200 && status < 300 };
  };

  const find = (store, request, ignoreSearch) => {
    const key = ignoreSearch ? withoutSearch(absolute(request)) : absolute(request);
    for (const [url, hit] of store) {
      if ((ignoreSearch ? withoutSearch(url) : url) === key) return hit;
    }
    return undefined;
  };

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(requests) {
          const responses = await Promise.all(requests.map((request) => fetch(request)));
          const bad = responses.findIndex((response) => !response.ok);
          if (bad !== -1) throw new TypeError(`${absolute(requests[bad])} answered ${responses[bad].status}`);
          requests.forEach((request, i) => store.set(absolute(request), responses[i]));
        },
        async put(request, response) {
          store.set(absolute(request), response);
        },
        async match(request, { ignoreSearch = false } = {}) {
          return find(store, request, ignoreSearch);
        },
      };
    },
    async has(name) {
      return stores.has(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request, { ignoreSearch = false } = {}) {
      for (const store of stores.values()) {
        const hit = find(store, request, ignoreSearch);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self = {
    location: new URL(`${SCOPE}sw.js`),
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
    skipWaiting: async () => {
      state.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        state.claim += 1;
      },
    },
  };
  self.caches = caches;

  // Enough of Request for the precache: an absolute url and a cache mode.
  class Request {
    constructor(input, init = {}) {
      this.url = absolute(input);
      this.cache = init.cache ?? 'default';
    }
  }

  const context = vm.createContext({
    self,
    caches,
    fetch,
    Request,
    URL,
    Promise,
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout: timers.clearTimeout ?? clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: 'sw.js' });
  // Copied out through JSON so the arrays belong to this realm, not the context's.
  const constants = JSON.parse(vm.runInContext('JSON.stringify({ VERSION, ASSETS_DIGEST, PREFIX, ASSETS })', context));

  return {
    ...constants,
    handlers,
    network,
    cacheModes,
    state,
    stores,
    /* This VERSION's sets, newest first. */
    sets: () =>
      [...stores.keys()]
        .filter((name) => name.startsWith(constants.PREFIX))
        .sort((x, y) => Number(y.slice(constants.PREFIX.length)) - Number(x.slice(constants.PREFIX.length))),
    setOffline: (value) => {
      offline = value;
    },
    /* Puts new contents for `paths` on the server: `<label>:<path>`. */
    deploy: (label, paths, fields = {}) => {
      for (const path of paths) server[path] = { body: `${label}:${path}`, ...fields };
    },
    setServer: (path, answer) => {
      server[path] = answer;
    },
    /*
     * Fires `type` and resolves once its answer is ready. A fetch resolves
     * with its response without waiting for work it hands to waitUntil;
     * `settled` waits for that too.
     */
    async dispatch(type, fields = {}) {
      let waited;
      let responded;
      const event = {
        ...fields,
        waitUntil: (promise) => {
          waited = promise;
        },
        respondWith: (promise) => {
          responded = promise;
        },
      };
      handlers[type](event);
      if (responded === undefined && waited) await waited;
      return {
        responded: responded === undefined ? undefined : await responded,
        intercepted: responded !== undefined,
        settled: () => waited,
      };
    },
  };
}

/* Timers that fire at once, so a refresh that has not finished is too slow. */
const instantTimers = (delays = []) => ({
  setTimeout: (fn, ms) => {
    delays.push(ms);
    queueMicrotask(fn);
    return 0;
  },
  clearTimeout: () => {},
});

/* A promise and the function that resolves it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/* Opens the app as page `clientId`, then loads `paths` for that page. */
async function openApp(worker, clientId, paths = []) {
  const page = await worker.dispatch('fetch', { request: request('./', { mode: 'navigate' }), resultingClientId: clientId });
  const files = {};
  for (const path of paths) {
    files[path] = (await worker.dispatch('fetch', { request: request(path), clientId })).responded.body;
  }
  return { page: page.responded.body, files, settled: page.settled };
}

function request(path, { method = 'GET', mode = 'cors' } = {}) {
  return { url: new URL(path, SCOPE).href, method, mode };
}

/* Every file under `dir` (relative to the root) that `keep` accepts. */
function filesUnder(dir, keep) {
  const base = new URL(`./${dir}/`, ROOT);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true })
    .map((name) => `${dir}/${String(name).split('\\').join('/')}`)
    .filter((path) => statSync(new URL(`./${path}`, ROOT)).isFile() && keep(path))
    .sort();
}

const exists = (path) => existsSync(new URL(`./${path}`, ROOT));

const STATIC_IMPORT = /^\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/*
 * Every module the page loads: the entry script index.html names, then each
 * relative static import, followed recursively. Test-only helpers such as
 * src/ledger/fake-indexeddb.js are never reached, so they are not required.
 */
function appModules() {
  const html = readFileSync(new URL('./index.html', ROOT), 'utf8');
  const entries = [...html.matchAll(/<script[^>]*\stype="module"[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(entries.length > 0, 'index.html loads no module script');
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(new URL(`./${path}`, ROOT), 'utf8');
    for (const [, from, bare] of source.matchAll(STATIC_IMPORT)) {
      const specifier = from ?? bare;
      if (specifier.startsWith('.')) queue.push(new URL(specifier, new URL(`./${path}`, ROOT)).href.slice(ROOT.href.length));
    }
  }
  return [...seen].sort();
}

function requiredAssets() {
  return [
    'index.html',
    'manifest.webmanifest',
    ...filesUnder('css', (path) => path.endsWith('.css')),
    ...appModules(),
    ...filesUnder('icons', () => true),
  ];
}

const listed = (assets) => assets.filter((asset) => asset !== './').map((asset) => asset.replace(/^\.\//, ''));

test('the cache names carry the version constant', () => {
  const worker = loadWorker();
  assert.match(worker.VERSION, /\S/);
  assert.ok(worker.PREFIX.includes(worker.VERSION), `${worker.PREFIX} does not include ${worker.VERSION}`);
  assert.match(SOURCE, /const VERSION = /);
});

/*
 * sha-256 over every precached file, in ASSETS order: its path, then its
 * bytes. Text files are read with CRLF as LF, so a Windows checkout gets the
 * same digest.
 */
function assetsDigest(assets) {
  const hash = createHash('sha256');
  for (const path of listed(assets)) {
    let bytes = readFileSync(new URL(`./${path}`, ROOT));
    if (!path.startsWith('icons/')) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    hash.update(`${path}\0`);
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('a changed precached file comes with a new VERSION, so installed phones get it', () => {
  const { ASSETS, ASSETS_DIGEST, VERSION } = loadWorker();
  const digest = assetsDigest(ASSETS);
  assert.equal(
    ASSETS_DIGEST,
    digest,
    `A precached file changed but sw.js still pins the old contents for ${VERSION}. A phone that opens the ` +
      `app offline would keep the old file. Bump VERSION in sw.js and set ASSETS_DIGEST = '${digest}'.`,
  );
});

test('install fetches every asset past the HTTP cache, so no stale copy is precached', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  assert.equal(worker.cacheModes.length, worker.ASSETS.length);
  assert.deepEqual(new Set(worker.cacheModes), new Set(['reload']));
});

test('the manifest and icons exist, so they can be precached', () => {
  assert.ok(exists('manifest.webmanifest'), 'manifest.webmanifest is missing; the installed app needs it offline');
  assert.ok(filesUnder('icons', () => true).length > 0, 'icons/ holds no files; the installed app needs them offline');
});

test('ASSETS lists every static file the app needs, each one relative', () => {
  const { ASSETS } = loadWorker();
  for (const asset of ASSETS) {
    assert.ok(asset.startsWith('./'), `${asset} is not relative to the worker`);
  }
  assert.ok(ASSETS.includes('./'), 'the start URL ./ is not precached');
  const names = listed(ASSETS);
  assert.ok(names.includes('manifest.webmanifest'), 'manifest.webmanifest is not precached');
  assert.ok(names.some((name) => name.startsWith('icons/')), 'no icon is precached');
  assert.deepEqual([...new Set(names)].sort(), requiredAssets().sort());
});

test('the Search screen and src/search.js are precached, so search opens offline', () => {
  const names = listed(loadWorker().ASSETS);
  for (const path of ['js/screens/search.js', 'src/search.js']) {
    assert.ok(names.includes(path), `${path} is not precached`);
  }
});

test('the backup export modules are precached, so Export backup works offline', () => {
  const names = listed(loadWorker().ASSETS);
  for (const path of ['src/backup-export.js', 'src/backup-download.js']) {
    assert.ok(names.includes(path), `${path} is not precached`);
  }
});

test('the Backup screen and src/backup-import.js are precached, so Import backup works offline', () => {
  const names = listed(loadWorker().ASSETS);
  for (const path of ['js/screens/backup.js', 'src/backup-import.js']) {
    assert.ok(names.includes(path), `${path} is not precached`);
  }
});

test('every precached file exists, so install cannot fail on a 404', () => {
  for (const path of listed(loadWorker().ASSETS)) {
    assert.ok(exists(path), `sw.js precaches ${path}, which does not exist`);
  }
});

test(`the precache list is under ${PRECACHE_LIMIT_BYTES} bytes, icons excluded`, () => {
  const total = listed(loadWorker().ASSETS)
    .filter((path) => !path.startsWith('icons/') && exists(path))
    .reduce((sum, path) => sum + statSync(new URL(`./${path}`, ROOT)).size, 0);
  assert.ok(total < PRECACHE_LIMIT_BYTES, `precache is ${total} bytes; the limit is under ${PRECACHE_LIMIT_BYTES}`);
});

test('install stores every asset as one set of this version and skips waiting', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  const sets = worker.sets();
  assert.equal(sets.length, 1);
  const cached = [...worker.stores.get(sets[0]).keys()].sort();
  assert.deepEqual(cached, worker.ASSETS.map((asset) => new URL(asset, SCOPE).href).sort());
  assert.equal(worker.state.skipWaiting, 1);
});

test('install fails, and keeps no partial set, when a file cannot be fetched', async () => {
  const worker = loadWorker({ server: { 'src/backup-import.js': { status: 404 } } });
  await assert.rejects(worker.dispatch('install'));
  assert.deepEqual(worker.sets(), []);
  assert.equal(worker.state.skipWaiting, 0);
});

test('activate deletes every cache that is not a set of this version, and claims clients', async () => {
  const worker = loadWorker({
    caches: { 'rupee-ledger-v12': [], 'rupee-ledger-v0': [], 'some-other-cache': [] },
  });
  await worker.dispatch('install');
  await worker.dispatch('activate');
  assert.deepEqual([...worker.stores.keys()], worker.sets());
  assert.equal(worker.sets().length, 1);
  assert.equal(worker.state.claim, 1);
});

/* Test #91: a cache-first worker kept phone B on an old src/backup-import.js
   that refused every backup with "Backup entry 1 has a non-numeric amount:
   undefined", long after the fix was deployed. */
test('opening the app online loads the deployed files, with no VERSION bump, and keeps them for offline', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  await worker.dispatch('activate');
  worker.deploy('v2', ['index.html', 'src/backup-import.js']);
  worker.cacheModes.length = 0;

  const online = await openApp(worker, 'page-1', ['src/backup-import.js', 'js/app.js']);
  assert.equal(online.page, 'served:', 'the start URL ./ is served as it is on the server');
  assert.deepEqual(online.files, { 'src/backup-import.js': 'v2:src/backup-import.js', 'js/app.js': 'served:js/app.js' });
  assert.deepEqual(new Set(worker.cacheModes), new Set(['no-cache']), 'a refresh must revalidate past the HTTP cache');

  worker.setOffline(true);
  const offline = await openApp(worker, 'page-2', ['src/backup-import.js']);
  assert.equal(offline.files['src/backup-import.js'], 'v2:src/backup-import.js');
});

test('a slow refresh loads every file of the page from the older set, never a mix of versions', async () => {
  const delays = [];
  const worker = loadWorker({ timers: instantTimers(delays) });
  await worker.dispatch('install');
  // A deploy changes two modules; one answers at once, the other hangs.
  const hanging = gate();
  worker.deploy('v2', ['js/app.js']);
  worker.deploy('v2', ['src/backup-import.js'], { until: hanging.promise });

  const slow = await openApp(worker, 'page-1', ['js/app.js', 'src/backup-import.js']);
  assert.deepEqual(slow.files, { 'js/app.js': 'served:js/app.js', 'src/backup-import.js': 'served:src/backup-import.js' });
  assert.ok(delays.length > 0 && delays.every((ms) => ms > 0 && ms <= 5000), `unexpected timeouts ${delays}`);

  // The refresh finishes after the page has opened: the page stays on its
  // set, and the next open gets the whole new one.
  hanging.open();
  await slow.settled();
  const later = await worker.dispatch('fetch', { request: request('js/app.js'), clientId: 'page-1' });
  assert.equal(later.responded.body, 'served:js/app.js');
  const next = await openApp(worker, 'page-2', ['js/app.js', 'src/backup-import.js']);
  assert.deepEqual(next.files, { 'js/app.js': 'v2:js/app.js', 'src/backup-import.js': 'v2:src/backup-import.js' });
});

test('a refresh with a file the server refuses keeps the whole older set, and leaves no partial one', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  const before = worker.sets();
  worker.deploy('v2', ['js/app.js']);
  worker.setServer('src/backup-import.js', { status: 500 });

  const opened = await openApp(worker, 'page-1', ['js/app.js', 'src/backup-import.js']);
  assert.deepEqual(opened.files, { 'js/app.js': 'served:js/app.js', 'src/backup-import.js': 'served:src/backup-import.js' });
  assert.deepEqual(worker.sets(), before);
});

test('a page keeps its set while another page opens onto a newer one', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  const first = await openApp(worker, 'page-1');
  worker.deploy('v2', ['js/app.js', 'src/backup-import.js']);
  const second = await openApp(worker, 'page-2', ['js/app.js']);
  assert.equal(second.files['js/app.js'], 'v2:js/app.js');
  await first.settled();

  for (const path of ['js/app.js', 'src/backup-import.js']) {
    const { responded } = await worker.dispatch('fetch', { request: request(path), clientId: 'page-1' });
    assert.equal(responded.body, `served:${path}`, `page-1 got a newer ${path} than the files it opened with`);
  }
  const unknown = await worker.dispatch('fetch', { request: request('js/app.js'), clientId: 'never-seen' });
  assert.equal(unknown.responded.body, 'v2:js/app.js', 'a page with no set gets the newest one');
});

test('the two newest whole sets are kept and older ones deleted', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  for (let i = 1; i <= 4; i += 1) await openApp(worker, `page-${i}`);
  assert.equal(worker.sets().length, 2);
});

test('a cached asset requested with a query string is still served offline', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setOffline(true);
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js?v=2') });
  assert.equal(responded.body, 'served:js/app.js');
});

test('with no network, opening the app renders the cached shell and every file', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setOffline(true);

  const start = await worker.dispatch('fetch', { request: request('./', { mode: 'navigate' }) });
  assert.equal(start.responded.body, 'served:');

  const deep = await worker.dispatch('fetch', { request: request('index.html?from=homescreen', { mode: 'navigate' }) });
  assert.equal(deep.responded.body, 'served:index.html');

  const unknown = await worker.dispatch('fetch', { request: request('some/other/page', { mode: 'navigate' }) });
  assert.equal(unknown.responded.body, 'served:index.html');

  worker.network.length = 0;
  for (const asset of worker.ASSETS) {
    const { responded } = await worker.dispatch('fetch', { request: request(asset) });
    assert.ok(responded, `${asset} is not served offline`);
  }
  assert.deepEqual(worker.network, [], 'a file was fetched instead of served from the set');
});

test('an uncached same-origin GET that is not a navigation goes to the network', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('notes.txt') });
  assert.equal(responded.body, 'served:notes.txt');
  assert.deepEqual(worker.network, [`${SCOPE}notes.txt`]);
  for (const set of worker.sets()) {
    assert.equal(worker.stores.get(set).has(`${SCOPE}notes.txt`), false, 'a runtime response was cached');
  }
});

test('non-GET requests are never intercepted', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const result = await worker.dispatch('fetch', { request: request('index.html', { method }) });
    assert.equal(result.intercepted, false, `${method} was intercepted`);
  }
  assert.deepEqual(worker.network, []);
});

test('cross-origin requests are never intercepted', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  for (const url of ['https://cdn.example.com/lib.js', 'http://ledger.test/app/index.html', 'https://ledger.test:8443/app/']) {
    const result = await worker.dispatch('fetch', { request: { url, method: 'GET', mode: 'navigate' } });
    assert.equal(result.intercepted, false, `${url} was intercepted`);
  }
  assert.deepEqual(worker.network, []);
});

test('sw.js names no other origin, imports nothing and leaves IndexedDB alone', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(SOURCE, /https?:\/\//i);
  assert.doesNotMatch(code, /importScripts|workbox|\bimport\s*\(|^\s*import\s/im);
  assert.doesNotMatch(code, /indexedDB/i);
});

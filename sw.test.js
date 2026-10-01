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
 * every request, fails while `offline` is set and never answers while
 * `hang` is set. `server` maps a path to the body the network serves for
 * it, or to a response's other fields (`{ status: 404 }`); any other path
 * answers `network:<url>`. `timers` replaces setTimeout and clearTimeout.
 */
function loadWorker({ caches: existing = {}, offline = false, hang = false, server = {}, timers = {} } = {}) {
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

  const served = (url) => {
    const path = url.slice(SCOPE.length);
    const answer = server[path] ?? `network:${url}`;
    const fields = typeof answer === 'string' ? { body: answer } : answer;
    const status = fields.status ?? 200;
    return {
      body: `network:${url}`,
      redirected: false,
      ...fields,
      status,
      ok: status >= 200 && status < 300,
      clone() {
        return { ...this };
      },
    };
  };

  const fetch = async (input, init = {}) => {
    const url = absolute(input);
    network.push(url);
    cacheModes.push(init.cache ?? (typeof input === 'string' ? 'default' : input.cache ?? 'default'));
    if (offline) throw new TypeError('Failed to fetch');
    if (hang) return new Promise(() => {});
    return served(url);
  };

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) {
            const response = await fetch(request);
            store.set(absolute(request), { body: `cached:${absolute(request)}`, from: response });
          }
        },
        async put(request, response) {
          store.set(absolute(request), response);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request, { ignoreSearch = false } = {}) {
      const key = ignoreSearch ? withoutSearch(absolute(request)) : absolute(request);
      for (const store of stores.values()) {
        for (const [url, hit] of store) {
          if ((ignoreSearch ? withoutSearch(url) : url) === key) return hit;
        }
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
  const constants = JSON.parse(vm.runInContext('JSON.stringify({ VERSION, ASSETS_DIGEST, CACHE, ASSETS })', context));

  return {
    ...constants,
    handlers,
    network,
    cacheModes,
    state,
    stores,
    setOffline: (value) => {
      offline = value;
    },
    setHang: (value) => {
      hang = value;
    },
    setServer: (path, answer) => {
      server[path] = answer;
    },
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
      if (waited) await waited;
      return { responded: responded === undefined ? undefined : await responded, intercepted: responded !== undefined };
    },
  };
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

test('the cache name carries the version constant', () => {
  const worker = loadWorker();
  assert.match(worker.VERSION, /\S/);
  assert.ok(worker.CACHE.includes(worker.VERSION), `${worker.CACHE} does not include ${worker.VERSION}`);
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

test('install precaches every asset into the versioned cache and skips waiting', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  const cached = [...worker.stores.get(worker.CACHE).keys()].sort();
  assert.deepEqual(cached, worker.ASSETS.map((asset) => new URL(asset, SCOPE).href).sort());
  assert.equal(worker.state.skipWaiting, 1);
});

test('activate deletes every other cache, keeps the current one and claims clients', async () => {
  const worker = loadWorker({
    caches: { 'rupee-ledger-v0': [], 'some-other-cache': [] },
  });
  await worker.dispatch('install');
  await worker.dispatch('activate');
  assert.deepEqual([...worker.stores.keys()], [worker.CACHE]);
  assert.equal(worker.state.claim, 1);
});

test('online, a precached file comes from the network past the HTTP cache and refreshes the cache', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  worker.cacheModes.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js?v=2') });
  assert.equal(responded.body, `network:${SCOPE}js/app.js?v=2`);
  assert.deepEqual(worker.network, [`${SCOPE}js/app.js?v=2`]);
  assert.deepEqual(worker.cacheModes, ['no-cache']);
  assert.equal(worker.stores.get(worker.CACHE).get(`${SCOPE}js/app.js`).body, `network:${SCOPE}js/app.js?v=2`);
});

/* Test #91: a cache-first worker kept phone B on an old src/backup-import.js
   that refused every backup with "Backup entry 1 has a non-numeric amount:
   undefined", long after the fix was deployed. */
test('a file changed on the server reaches an installed phone on its next open, with no VERSION bump', async () => {
  const worker = loadWorker({ server: { 'src/backup-import.js': 'old import' } });
  await worker.dispatch('install');
  await worker.dispatch('activate');
  worker.setServer('src/backup-import.js', 'fixed import');

  const online = await worker.dispatch('fetch', { request: request('src/backup-import.js') });
  assert.equal(online.responded.body, 'fixed import');

  worker.setOffline(true);
  const offline = await worker.dispatch('fetch', { request: request('src/backup-import.js') });
  assert.equal(offline.responded.body, 'fixed import');
});

test('a slow network falls back to the cached copy', async () => {
  const delays = [];
  // Fires every timeout at once, so the test does not wait for it.
  const setTimeout = (fn, ms) => {
    delays.push(ms);
    queueMicrotask(fn);
    return 0;
  };
  const worker = loadWorker({ timers: { setTimeout, clearTimeout: () => {} } });
  await worker.dispatch('install');
  worker.setHang(true);
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js') });
  assert.equal(responded.body, `cached:${SCOPE}js/app.js`);
  const nav = await worker.dispatch('fetch', { request: request('./', { mode: 'navigate' }) });
  assert.equal(nav.responded.body, `cached:${SCOPE}`);
  assert.ok(delays.length > 0 && delays.every((ms) => ms > 0 && ms <= 5000), `unexpected timeouts ${delays}`);
});

test('an error or redirect from the network serves the cached copy and leaves it in place', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setServer('js/app.js', { status: 500 });
  worker.setServer('js/router.js', { redirected: true });
  for (const path of ['js/app.js', 'js/router.js']) {
    const { responded } = await worker.dispatch('fetch', { request: request(path) });
    assert.equal(responded.body, `cached:${SCOPE}${path}`);
    assert.equal(worker.stores.get(worker.CACHE).get(`${SCOPE}${path}`).body, `cached:${SCOPE}${path}`);
  }
  worker.setServer('some/other/page', { status: 404 });
  const unknown = await worker.dispatch('fetch', { request: request('some/other/page', { mode: 'navigate' }) });
  assert.equal(unknown.responded.body, `cached:${SCOPE}index.html`);
});

test('a cached asset requested with a query string is still served offline', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setOffline(true);
  worker.network.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js?v=2') });
  assert.equal(responded.body, `cached:${SCOPE}js/app.js`);
});

test('with no network, opening the app renders the cached shell', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setOffline(true);
  worker.network.length = 0;

  const start = await worker.dispatch('fetch', { request: request('./', { mode: 'navigate' }) });
  assert.equal(start.responded.body, `cached:${SCOPE}`);

  const deep = await worker.dispatch('fetch', { request: request('index.html?from=homescreen', { mode: 'navigate' }) });
  assert.equal(deep.responded.body, `cached:${SCOPE}index.html`);

  const unknown = await worker.dispatch('fetch', { request: request('some/other/page', { mode: 'navigate' }) });
  assert.equal(unknown.responded.body, `cached:${SCOPE}index.html`);

  for (const asset of worker.ASSETS) {
    const { responded } = await worker.dispatch('fetch', { request: request(asset) });
    assert.ok(responded, `${asset} is not served offline`);
    assert.match(responded.body, /^cached:/, `${asset} is not served from the cache offline`);
  }
});

test('an uncached same-origin GET that is not a navigation goes to the network', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('notes.txt') });
  assert.equal(responded.body, `network:${SCOPE}notes.txt`);
  assert.equal(worker.stores.get(worker.CACHE).has(`${SCOPE}notes.txt`), false, 'a runtime response was cached');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
 * every request and fails while `offline` is set.
 */
function loadWorker({ caches: existing = {}, offline = false } = {}) {
  const handlers = {};
  const network = [];
  const stores = new Map(Object.entries(existing).map(([name, entries]) => [name, new Map(entries)]));
  const state = { skipWaiting: 0, claim: 0 };
  const absolute = (input) => new URL(typeof input === 'string' ? input : input.url, `${SCOPE}sw.js`).href;
  const withoutSearch = (url) => {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
  };

  const fetch = async (input) => {
    const url = absolute(input);
    network.push(url);
    if (offline) throw new TypeError('Failed to fetch');
    return { body: `network:${url}`, ok: true };
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

  const context = vm.createContext({ self, caches, fetch, URL, Promise });
  vm.runInContext(SOURCE, context, { filename: 'sw.js' });
  // Copied out through JSON so the arrays belong to this realm, not the context's.
  const constants = JSON.parse(vm.runInContext('JSON.stringify({ VERSION, CACHE, ASSETS })', context));

  return {
    ...constants,
    handlers,
    network,
    state,
    stores,
    setOffline: (value) => {
      offline = value;
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

test('a cached same-origin GET is served from the cache without the network', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.network.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js') });
  assert.equal(responded.body, `cached:${SCOPE}js/app.js`);
  assert.deepEqual(worker.network, []);
});

test('a cached asset requested with a query string is still served offline', async () => {
  const worker = loadWorker();
  await worker.dispatch('install');
  worker.setOffline(true);
  worker.network.length = 0;
  const { responded } = await worker.dispatch('fetch', { request: request('js/app.js?v=2') });
  assert.equal(responded.body, `cached:${SCOPE}js/app.js`);
  assert.deepEqual(worker.network, []);
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
  }
  assert.deepEqual(worker.network, []);
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

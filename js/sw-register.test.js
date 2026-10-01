import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { startOffline } from './sw-register.js';

/* A navigator with only the APIs startOffline uses, recording each call. */
function fakeNavigator({ register = async () => ({}), persist = async () => true } = {}) {
  const calls = { register: [], persist: 0 };
  return {
    calls,
    serviceWorker: {
      register: (...args) => {
        calls.register.push(args);
        return register(...args);
      },
    },
    storage: {
      persist: () => {
        calls.persist += 1;
        return persist();
      },
    },
  };
}

test('registers sw.js with a relative path and scope', async () => {
  const nav = fakeNavigator();
  const result = await startOffline(nav);
  assert.deepEqual(nav.calls.register, [['./sw.js', { scope: './' }]]);
  assert.equal(result.registered, true);
});

test('asks for persistent storage when the API exists', async () => {
  const nav = fakeNavigator();
  const result = await startOffline(nav);
  assert.equal(nav.calls.persist, 1);
  assert.equal(result.persisted, true);
});

test('does nothing and throws nothing without serviceWorker or storage', async () => {
  assert.deepEqual(await startOffline({}), { registered: false, persisted: false });
  assert.deepEqual(await startOffline(undefined), { registered: false, persisted: false });
  assert.deepEqual(await startOffline({ serviceWorker: {}, storage: {} }), { registered: false, persisted: false });
});

test('still persists when there is no service worker support', async () => {
  let asked = 0;
  const result = await startOffline({ storage: { persist: async () => { asked += 1; return true; } } });
  assert.equal(asked, 1);
  assert.deepEqual(result, { registered: false, persisted: true });
});

test('a failed registration or persist neither throws nor rejects', async () => {
  const nav = fakeNavigator({
    register: async () => { throw new Error('insecure context'); },
    persist: async () => { throw new Error('denied'); },
  });
  assert.deepEqual(await startOffline(nav), { registered: false, persisted: false });

  const throwing = {
    serviceWorker: { register() { throw new Error('sync failure'); } },
    storage: { persist() { throw new Error('sync failure'); } },
  };
  assert.deepEqual(await startOffline(throwing), { registered: false, persisted: false });
});

test('a refused persist counts as not persisted', async () => {
  const nav = fakeNavigator({ persist: async () => false });
  assert.deepEqual(await startOffline(nav), { registered: true, persisted: false });
});

test('the entry point starts offline support', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ startOffline \} from '\.\/sw-register\.js';/);
  assert.match(app, /^startOffline\(\);$/m);
});

/* A service worker container that can fire controllerchange, as a page
   already controlled (`controller`) or loaded before any worker. */
function updatingNavigator({ controller = {}, update = async () => {} } = {}) {
  const listeners = [];
  const calls = { update: 0 };
  return {
    calls,
    change: () => listeners.forEach((listener) => listener()),
    serviceWorker: {
      controller,
      register: async () => ({ update: () => { calls.update += 1; return update(); } }),
      addEventListener: (type, listener) => {
        if (type === 'controllerchange') listeners.push(listener);
      },
    },
  };
}

test('reloads once onto the new files when a new worker takes over a controlled page', async () => {
  const nav = updatingNavigator();
  let reloads = 0;
  assert.equal((await startOffline(nav, () => { reloads += 1; })).registered, true);
  assert.equal(reloads, 0);
  nav.change();
  assert.equal(reloads, 1);
  nav.change();
  assert.equal(reloads, 1);
});

test('a first install, with no worker yet, does not reload', async () => {
  const nav = updatingNavigator({ controller: null });
  let reloads = 0;
  await startOffline(nav, () => { reloads += 1; });
  nav.change();
  assert.equal(reloads, 0);
});

test('checks for a new sw.js at startup, and a failed check neither throws nor rejects', async () => {
  const nav = updatingNavigator();
  await startOffline(nav, () => {});
  assert.equal(nav.calls.update, 1);

  const offline = updatingNavigator({ update: async () => { throw new Error('offline'); } });
  assert.equal((await startOffline(offline, () => {})).registered, true);

  const throwing = updatingNavigator({ update: () => { throw new Error('sync failure'); } });
  assert.equal((await startOffline(throwing, () => {})).registered, true);
});

test('a reload that throws is swallowed', async () => {
  const nav = updatingNavigator();
  await startOffline(nav, () => { throw new Error('cannot reload'); });
  assert.doesNotThrow(() => nav.change());
});

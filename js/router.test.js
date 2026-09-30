import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROUTE,
  markActiveTab,
  mounts,
  renderRoute,
  resolveRoute,
  routeName,
  routeQuery,
  routes,
  startRouter,
} from './router.js';
import { mountToday, renderToday } from './screens/today.js';
import { renderNotFound, renderScreenError } from './screens/not-found.js';

/* Screens under test here render without their mount, so no data loads. */
const noMounts = {};

/* Just enough of an element for the router: attributes, innerHTML, focus. */
function fakeElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    innerHTML: '',
    focused: false,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    focus() {
      this.focused = true;
    },
  };
}

function fakeWindow(hash) {
  const listeners = new Map();
  return {
    location: { hash },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    scrollTo() {},
    navigate(nextHash) {
      this.location.hash = nextHash;
      listeners.get('hashchange')?.();
    },
    listening: (type) => listeners.has(type),
  };
}

test('the routes table maps today to the Today screen', () => {
  assert.equal(DEFAULT_ROUTE, 'today');
  assert.equal(routes.today, renderToday);
  assert.equal(mounts.today, mountToday);
});

test('a query after the path keeps the route and is parsed apart', () => {
  assert.equal(routeName('#/today?state=error'), 'today');
  assert.equal(routeQuery('#/today?state=error').get('state'), 'error');
  assert.equal(routeName('#/today/?state=x'), 'today');
  assert.equal(routeQuery('#/today/?state=x').get('state'), 'x');
  assert.equal(routeName('#?state=empty'), DEFAULT_ROUTE);
  assert.equal(routeQuery('#?state=empty').get('state'), 'empty');
  assert.equal(routeName('#/today?'), 'today');
  assert.equal([...routeQuery('#/today?')].length, 0);
  assert.equal([...routeQuery('#/today')].length, 0);
  assert.equal(routeName('#/nope?state=empty'), 'nope');
});

test('an empty hash and #/today both name the Today route', () => {
  for (const hash of ['', '#', '#/', '#/today', '#/today/', undefined]) {
    assert.equal(routeName(hash), 'today', `hash ${JSON.stringify(hash)}`);
    assert.deepEqual(resolveRoute(hash), { name: 'today', render: renderToday });
  }
});

test('unknown hashes resolve to the Not found screen', () => {
  for (const hash of ['#/nope', '#/Today', '#/today/extra', '#/constructor', '#/__proto__']) {
    assert.deepEqual(resolveRoute(hash), { name: null, render: renderNotFound }, hash);
  }
});

test('renderRoute puts the Today screen into main for an empty hash', () => {
  const main = fakeElement();
  const route = renderRoute({ main, hash: '', mountTable: noMounts });
  assert.equal(route.name, 'today');
  assert.equal(route.mounted, false);
  assert.equal(main.innerHTML, renderToday());
  assert.match(main.innerHTML, /Add a spend/);
});

test('renderRoute puts a styled Not found message into main for an unknown hash', () => {
  const main = fakeElement();
  renderRoute({ main, hash: '#/nope', mountTable: noMounts });
  assert.match(main.innerHTML, /<section class="card not-found"/);
  assert.match(main.innerHTML, /Not found/);
  assert.match(main.innerHTML, /href="#\/today"/);
});

test('markActiveTab sets aria-current="page" only on the matching tab', () => {
  const today = fakeElement({ 'data-route': 'today' });
  const month = fakeElement({ 'data-route': 'month', 'aria-current': 'page' });

  markActiveTab([today, month], 'today');
  assert.equal(today.getAttribute('aria-current'), 'page');
  assert.equal(month.getAttribute('aria-current'), null);

  markActiveTab([today, month], null);
  assert.equal(today.getAttribute('aria-current'), null);
  assert.equal(month.getAttribute('aria-current'), null);
});

test('startRouter renders now, re-renders on hashchange, and can stop', () => {
  const win = fakeWindow('#/today');
  const main = fakeElement();
  const tab = fakeElement({ 'data-route': 'today' });

  const stop = startRouter({ win, main, links: [tab], mountTable: noMounts });
  assert.equal(main.innerHTML, renderToday());
  assert.equal(tab.getAttribute('aria-current'), 'page');
  assert.equal(main.focused, false, 'first render does not steal focus');

  win.navigate('#/nope');
  assert.equal(main.innerHTML, renderNotFound());
  assert.equal(tab.getAttribute('aria-current'), null);
  assert.equal(main.focused, true, 'a route change focuses main');

  win.navigate('');
  assert.equal(main.innerHTML, renderToday());
  assert.equal(tab.getAttribute('aria-current'), 'page');

  stop();
  assert.equal(win.listening('hashchange'), false);
});

test('renderRoute runs the route\'s mount with the parsed query', () => {
  const main = fakeElement();
  const calls = [];
  const route = renderRoute({
    main,
    hash: '#/today?state=filled',
    mountTable: { today: (context) => calls.push(context) },
  });
  assert.equal(route.mounted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].main, main);
  assert.equal(calls[0].query.get('state'), 'filled');
  assert.equal(calls[0].isCurrent(), true);
});

test('no mount runs for an unknown route or an inherited key', () => {
  const calls = [];
  const mountTable = { today: () => calls.push('today') };
  for (const hash of ['#/nope', '#/constructor', '#/__proto__', '#/toString']) {
    const route = renderRoute({ main: fakeElement(), hash, mountTable });
    assert.equal(route.mounted, false, hash);
  }
  assert.deepEqual(calls, []);
});

test('isCurrent turns false after a second render into the same main only', () => {
  const main = fakeElement();
  const other = fakeElement();
  const contexts = [];
  const mountTable = { today: (context) => contexts.push(context) };

  renderRoute({ main, hash: '#/today', mountTable });
  renderRoute({ main: other, hash: '#/today', mountTable });
  assert.equal(contexts[0].isCurrent(), true, 'another main does not make it stale');

  renderRoute({ main, hash: '#/today', mountTable });
  assert.equal(contexts[0].isCurrent(), false);
  assert.equal(contexts[2].isCurrent(), true);
});

test('a mount that throws leaves the screen error with Try again', () => {
  const main = fakeElement();
  renderRoute({ main, hash: '#/today', mountTable: { today: () => { throw new Error('boom'); } } });
  assert.equal(main.innerHTML, renderScreenError());
  assert.match(main.innerHTML, /data-action="reload-screen">Try again</);
});

test('a mount that rejects leaves the screen error, unless the screen moved on', async () => {
  const main = fakeElement();
  let reject;
  const mountTable = { today: () => new Promise((_, no) => { reject = no; }) };

  renderRoute({ main, hash: '#/today', mountTable });
  reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.innerHTML, renderScreenError());

  renderRoute({ main, hash: '#/today', mountTable });
  const stale = reject;
  renderRoute({ main, hash: '#/nope', mountTable });
  stale(new Error('stale'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.innerHTML, renderNotFound());
});

test('startRouter forwards its mount table and lets a mount own focus', () => {
  const win = fakeWindow('#/today');
  const main = fakeElement();
  const calls = [];
  startRouter({ win, main, mountTable: { today: ({ query }) => calls.push(query.get('state')) } });
  assert.deepEqual(calls, [null]);

  win.navigate('#/today?state=empty');
  assert.deepEqual(calls, [null, 'empty']);
  assert.equal(main.focused, false, 'the mounted screen places focus, not main');

  win.navigate('#/nope');
  assert.equal(main.focused, true);
});

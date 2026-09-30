import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ROUTE,
  markActiveTab,
  renderRoute,
  resolveRoute,
  routeName,
  routes,
  startRouter,
} from './router.js';
import { renderToday } from './screens/today.js';
import { renderNotFound } from './screens/not-found.js';

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
  const route = renderRoute({ main, hash: '' });
  assert.equal(route.name, 'today');
  assert.equal(main.innerHTML, renderToday());
  assert.match(main.innerHTML, /Add a spend/);
});

test('renderRoute puts a styled Not found message into main for an unknown hash', () => {
  const main = fakeElement();
  renderRoute({ main, hash: '#/nope' });
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

  const stop = startRouter({ win, main, links: [tab] });
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

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
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

/* A main whose Try again button can be clicked, as the router wires it. */
function mainWithReloadButton() {
  const main = fakeElement();
  const button = { listener: null, addEventListener(type, fn) { if (type === 'click') this.listener = fn; } };
  main.querySelector = (selector) => (selector === '[data-action="reload-screen"]' ? button : null);
  return { main, button };
}

test('a mount that throws leaves the screen error, and its Try again runs the mount again', () => {
  const { main, button } = mainWithReloadButton();
  const tab = fakeElement({ 'data-route': 'today' });
  let calls = 0;
  const mountTable = {
    today: () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    },
  };

  renderRoute({ main, links: [tab], hash: '#/today', mountTable });
  assert.equal(calls, 1);
  assert.equal(main.innerHTML, renderScreenError());
  assert.match(main.innerHTML, /class="card screen-error"/);
  assert.match(main.innerHTML, /data-action="reload-screen">Try again</);
  assert.equal(main.focused, true);
  assert.equal(typeof button.listener, 'function');

  button.listener();
  assert.equal(calls, 2);
  assert.equal(main.innerHTML, renderToday());
  assert.equal(tab.getAttribute('aria-current'), 'page');
});

test('a mount that rejects leaves the screen error, unless the screen moved on', async () => {
  const main = fakeElement();
  let reject;
  const mountTable = { today: () => new Promise((_, no) => { reject = no; }) };

  renderRoute({ main, hash: '#/today', mountTable });
  reject(new Error('late'));
  await tick();
  assert.equal(main.innerHTML, renderScreenError());

  renderRoute({ main, hash: '#/today', mountTable });
  const stale = reject;
  renderRoute({ main, hash: '#/nope', mountTable });
  stale(new Error('stale'));
  await tick();
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

/* The parts of the Today screen the real mount looks up in <main>. */
function todayMain() {
  const part = () => {
    const listeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    return {
      innerHTML: '',
      textContent: '',
      value: '',
      focusCount: 0,
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
      dispatch: (type, event = {}) => listeners.get(type)?.(event),
      focus() {
        this.focusCount += 1;
      },
    };
  };
  const parts = {
    '.today': part(),
    '[data-today-view]': part(),
    '[data-today-form]': part(),
    '#quick-entry': part(),
    '#quick-entry-hint': part(),
    '[data-entry-status]': part(),
  };
  const main = fakeElement();
  main.querySelector = (selector) => parts[selector] ?? null;
  return { main, parts };
}

test('opening the app on Today through the router focuses the entry box and loads the forced state', async () => {
  const { main, parts } = todayMain();
  const win = fakeWindow('#/today?state=filled');
  startRouter({ win, main });

  assert.match(main.innerHTML, /<input class="quick-entry" id="quick-entry"/);
  assert.equal(parts['#quick-entry'].focusCount, 1, 'entry box focused on open');
  assert.equal(main.focused, false);
  assert.match(parts['[data-today-view]'].innerHTML, /aria-busy="true"/);

  await tick();
  assert.match(parts['[data-today-view]'].innerHTML, /class="entry-list"/);
  assert.equal(parts['.today'].getAttribute('data-status'), 'filled');

  parts['#quick-entry'].value = '120 chai';
  parts['[data-today-form]'].dispatch('submit', { preventDefault() {} });
  assert.equal(parts['#quick-entry'].value, '');
  assert.match(parts['[data-today-view]'].innerHTML, /data-today-total>₹1,610.5</);
});

test('each forced state reaches its own view through the router and the stub', async () => {
  const seen = {};
  for (const state of ['empty', 'filled', 'loading', 'error']) {
    const { main, parts } = todayMain();
    renderRoute({ main, hash: '#/today?state=' + state });
    await tick();
    seen[state] = parts['[data-today-view]'].innerHTML;
    assert.equal(parts['.today'].getAttribute('data-status'), state, state);
  }
  assert.match(seen.empty, /today-empty/);
  assert.match(seen.filled, /entry-list/);
  assert.match(seen.loading, /aria-busy="true"/);
  assert.match(seen.error, /data-action="retry">Try again</);
  assert.equal(new Set(Object.values(seen)).size, 4);
});

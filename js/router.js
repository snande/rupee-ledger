/*
 * Hash router. Every screen lives at a `#/name` address, so the app stays a
 * set of static files with no server rewrites. The module touches no DOM
 * globals at import time; callers pass in the window, <main> and tab links,
 * which keeps it testable under `node --test`.
 */

import { renderToday, mountToday } from './screens/today.js';
import { renderNotFound } from './screens/not-found.js';

export const DEFAULT_ROUTE = 'today';

/* Route name → function returning the screen's markup. Later tabs (monthly
   view, search, settings) add an entry here and a tab in index.html. */
export const routes = {
  today: renderToday,
};

/* Route name → optional function run after the screen's markup is in
   <main>, for screens that load data or listen for input. It gets
   { main, query, isCurrent }; isCurrent() turns false once another render
   has replaced this one, so a slow load cannot overwrite a newer screen. */
export const mounts = {
  today: mountToday,
};

/* A hash may carry a query after the path, as in '#/today?state=empty'. */
function splitHash(hash) {
  const text = String(hash ?? '').replace(/^#\/?/, '');
  const at = text.indexOf('?');
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

/* '', '#', '#/' and '#/today/' all name a route: strip the '#/' prefix, any
   query and any trailing slash, and fall back to the default route when
   empty. */
export function routeName(hash) {
  const path = splitHash(hash)[0].replace(/\/+$/, '');
  return path === '' ? DEFAULT_ROUTE : path;
}

/* The query after the route path, e.g. state=error in '#/today?state=error'. */
export function routeQuery(hash) {
  return new URLSearchParams(splitHash(hash)[1]);
}

/* Own properties only, so '#/constructor' is not found rather than a crash. */
export function resolveRoute(hash, table = routes) {
  const name = routeName(hash);
  if (Object.prototype.hasOwnProperty.call(table, name) && typeof table[name] === 'function') {
    return { name, render: table[name] };
  }
  return { name: null, render: renderNotFound };
}

export function markActiveTab(links, name) {
  for (const link of links) {
    if (name !== null && link.getAttribute('data-route') === name) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

let renderCount = 0;

export function renderRoute({ main, links = [], hash, table = routes, mountTable = mounts }) {
  const route = resolveRoute(hash, table);
  const current = ++renderCount;
  main.innerHTML = route.render();
  markActiveTab(links, route.name);
  const mount = route.name !== null && Object.prototype.hasOwnProperty.call(mountTable, route.name)
    ? mountTable[route.name]
    : null;
  if (typeof mount === 'function') {
    mount({ main, query: routeQuery(hash), isCurrent: () => current === renderCount });
  }
  return route;
}

/* Render the current hash now and on every hashchange. After a change,
   focus moves to <main> so screen readers announce the new screen. Returns
   a function that stops listening. */
export function startRouter({ win, main, links = [], table = routes }) {
  const update = () => renderRoute({ main, links, hash: win.location.hash, table });
  const onHashChange = () => {
    update();
    if (typeof main.focus === 'function') main.focus({ preventScroll: true });
    if (typeof win.scrollTo === 'function') win.scrollTo(0, 0);
  };
  win.addEventListener('hashchange', onHashChange);
  update();
  return () => win.removeEventListener('hashchange', onHashChange);
}

/*
 * Hash router. Every screen lives at a `#/name` address, so the app stays a
 * set of static files with no server rewrites. The module touches no DOM
 * globals at import time; callers pass in the window, <main> and tab links,
 * which keeps it testable under `node --test`.
 */

import { renderToday } from './screens/today.js';
import { renderNotFound } from './screens/not-found.js';

export const DEFAULT_ROUTE = 'today';

/* Route name → function returning the screen's markup. Later tabs (monthly
   view, search, settings) add an entry here and a tab in index.html. */
export const routes = {
  today: renderToday,
};

/* '', '#', '#/' and '#/today/' all name a route: strip the '#/' prefix and
   any trailing slash, and fall back to the default route when empty. */
export function routeName(hash) {
  const path = String(hash ?? '').replace(/^#\/?/, '').replace(/\/+$/, '');
  return path === '' ? DEFAULT_ROUTE : path;
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

export function renderRoute({ main, links = [], hash, table = routes }) {
  const route = resolveRoute(hash, table);
  main.innerHTML = route.render();
  markActiveTab(links, route.name);
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

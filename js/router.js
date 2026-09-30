/*
 * Hash router. Every screen lives at a `#/name` address, so the app stays a
 * set of static files with no server rewrites. The module touches no DOM
 * globals at import time; callers pass in the window, <main> and tab links,
 * which keeps it testable under `node --test`.
 */

import { renderToday, mountToday } from './screens/today.js';
import { renderNotFound, renderScreenError } from './screens/not-found.js';

export const DEFAULT_ROUTE = 'today';

/* Route name → function returning the screen's markup. Later tabs (monthly
   view, search, settings) add an entry here and a tab in index.html. */
export const routes = {
  today: renderToday,
};

/* Route name → function run once the screen's markup is in <main>, for
   screens that load data or listen for input. It gets
   { main, query, isCurrent }; isCurrent() turns false once another render
   into the same <main> has replaced this one, so a slow load cannot
   overwrite a newer screen. A mount that runs owns focus for its screen. */
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

/* Render count per <main>, so separate routers never mark each other's
   screens stale. */
const renderCounts = new WeakMap();

function ownMount(mountTable, name) {
  if (name === null || !Object.prototype.hasOwnProperty.call(mountTable, name)) return null;
  return typeof mountTable[name] === 'function' ? mountTable[name] : null;
}

/* A mount that throws or rejects leaves a styled error with Try again in
   <main>, never a half-wired screen. Try again renders the route afresh,
   which runs the mount again. */
function runMount(mount, context, retry) {
  const fail = () => {
    if (!context.isCurrent()) return;
    context.main.innerHTML = renderScreenError();
    const button = typeof context.main.querySelector === 'function'
      ? context.main.querySelector('[data-action="reload-screen"]')
      : null;
    if (button) button.addEventListener('click', retry);
    if (typeof context.main.focus === 'function') context.main.focus({ preventScroll: true });
  };
  try {
    const result = mount(context);
    if (result && typeof result.then === 'function') result.then(undefined, fail);
  } catch {
    fail();
  }
}

/* Returns the resolved route plus `mounted`, true when a mount ran and so
   owns focus for the new screen. */
export function renderRoute({ main, links = [], hash, table = routes, mountTable = mounts }) {
  const route = resolveRoute(hash, table);
  const current = (renderCounts.get(main) ?? 0) + 1;
  renderCounts.set(main, current);
  const isCurrent = () => renderCounts.get(main) === current;

  main.innerHTML = route.render();
  markActiveTab(links, route.name);

  const mount = ownMount(mountTable, route.name);
  if (mount) {
    const retry = () => renderRoute({ main, links, hash, table, mountTable });
    runMount(mount, { main, query: routeQuery(hash), isCurrent }, retry);
  }
  return { ...route, mounted: mount !== null };
}

/* Render the current hash now and on every hashchange. After a change to a
   screen with no mount, focus moves to <main> so screen readers announce
   the new screen; a mounted screen places focus itself. Returns a function
   that stops listening. */
export function startRouter({ win, main, links = [], table = routes, mountTable = mounts }) {
  const update = () => renderRoute({ main, links, hash: win.location.hash, table, mountTable });
  const onHashChange = () => {
    const route = update();
    if (!route.mounted && typeof main.focus === 'function') main.focus({ preventScroll: true });
    if (typeof win.scrollTo === 'function') win.scrollTo(0, 0);
  };
  win.addEventListener('hashchange', onHashChange);
  update();
  return () => win.removeEventListener('hashchange', onHashChange);
}

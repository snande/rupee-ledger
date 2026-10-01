/*
 * Demo data source for the Today screen. js/data/ledger.js sends a visit here
 * when its query names a state, so each screen state can be shown on demand.
 * The boundary is one function returning a Promise of entries, each
 * { id, amountPaise, note, category, timestamp }; the sample entries are
 * dated at the moment they load, so they count as today's. Nothing here is stored.
 *
 * The `state` query parameter forces a screen state for demos, e.g.
 * '#/today?state=filled':
 *   filled   resolves the sample entries below
 *   empty    resolves []
 *   loading  never settles
 *   error    rejects
 * Without a known state the stub behaves like a new phone: empty.
 */

export const STUB_STATES = ['empty', 'filled', 'loading', 'error'];
export const DEFAULT_STUB_STATE = 'empty';

const SAMPLE_ENTRIES = [
  { id: 'sample-4', amountPaise: 124500, note: 'Electricity top-up', category: 'Bills' },
  { id: 'sample-3', amountPaise: 18000, note: 'Vegetables from the market', category: 'Shopping' },
  { id: 'sample-2', amountPaise: 4550, note: 'Auto to the station', category: 'Transport' },
  { id: 'sample-1', amountPaise: 2000, note: 'Cutting chai', category: 'Food' },
];

/* The query after the path in the page's hash, as in '#/today?state=error'. */
export function currentQuery() {
  const hash = String(globalThis.location?.hash ?? '');
  const at = hash.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : hash.slice(at + 1));
}

/* The demo state the query names, or null when it names none. */
export function requestedState(query = currentQuery()) {
  const state = query && typeof query.get === 'function' ? query.get('state') : null;
  return STUB_STATES.includes(state) ? state : null;
}

export function stubState(query = currentQuery()) {
  return requestedState(query) ?? DEFAULT_STUB_STATE;
}

export function loadEntries(query = currentQuery()) {
  switch (stubState(query)) {
    case 'filled':
      return Promise.resolve(SAMPLE_ENTRIES.map((entry) => ({ ...entry, timestamp: Date.now() })));
    case 'loading':
      return new Promise(() => {});
    case 'error':
      return Promise.reject(new Error('The stub data source was asked to fail.'));
    default:
      return Promise.resolve([]);
  }
}

/*
 * Stand-in data source for the Today screen until the on-device ledger
 * lands. The ledger replaces this module with its own loadEntries(), so the
 * boundary stays one function returning a Promise of entries, each
 * { id, amountPaise, note }. Nothing here is stored: entries added during a
 * visit live only in the screen.
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
  { id: 'sample-4', amountPaise: 124500, note: 'Electricity top-up' },
  { id: 'sample-3', amountPaise: 18000, note: 'Vegetables from the market' },
  { id: 'sample-2', amountPaise: 4550, note: 'Auto to the station' },
  { id: 'sample-1', amountPaise: 2000, note: 'Cutting chai' },
];

/* The query after the path in the page's hash, as in '#/today?state=error'. */
function currentQuery() {
  const hash = String(globalThis.location?.hash ?? '');
  const at = hash.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : hash.slice(at + 1));
}

export function stubState(query = currentQuery()) {
  const state = query && typeof query.get === 'function' ? query.get('state') : null;
  return STUB_STATES.includes(state) ? state : DEFAULT_STUB_STATE;
}

export function loadEntries(query = currentQuery()) {
  switch (stubState(query)) {
    case 'filled':
      return Promise.resolve(SAMPLE_ENTRIES.map((entry) => ({ ...entry })));
    case 'loading':
      return new Promise(() => {});
    case 'error':
      return Promise.reject(new Error('The stub data source was asked to fail.'));
    default:
      return Promise.resolve([]);
  }
}

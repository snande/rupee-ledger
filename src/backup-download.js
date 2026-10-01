// Downloads the backup file: every entry in the on-device store, written by
// serializeBackup() in src/backup-export.js and saved through a temporary
// <a download> link to a Blob URL. Everything happens on the phone: no
// fetch, no XHR, nothing leaves the device, so it works with no network.
// The store is read before anything else is made, so a read that fails
// rejects without a Blob, a URL or a download: never an empty or part file.
// `list`, `doc`, `url` and `now` are passed in so tests can run it in Node.

import { backupFilename, serializeBackup } from './backup-export.js';
import { listEntries } from './ledger/store.js';

/* Waits one task, so the browser has taken the click before the URL goes. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Builds the backup of every stored entry and starts its download.
 * @param {{ list?: () => Promise<Array<object>>, doc?: Document,
 *   url?: { createObjectURL: Function, revokeObjectURL: Function },
 *   now?: Date }} [options]  `list` defaults to `listEntries()` from
 *   src/ledger/store.js, `doc` and `url` to the page's own, and `now` to
 *   the moment of the call.
 * @returns {Promise<{ filename: string, count: number }>}  once the object
 *   URL has been revoked. Rejects, having downloaded nothing, when the read
 *   fails.
 */
export async function exportBackup({
  list = listEntries,
  doc = globalThis.document,
  url = globalThis.URL,
  now = new Date(),
} = {}) {
  const entries = await list();
  if (!Array.isArray(entries)) throw new TypeError('The ledger read did not return a list of entries.');
  const filename = backupFilename(now);
  const blob = new Blob([serializeBackup(entries, now)], { type: 'application/json' });
  const href = url.createObjectURL(blob);
  try {
    const link = doc.createElement('a');
    link.href = href;
    link.download = filename;
    link.setAttribute('download', filename);
    link.hidden = true;
    const parent = doc.body ?? doc.documentElement;
    parent?.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove?.();
    }
    await nextTask();
  } finally {
    url.revokeObjectURL(href);
  }
  return { filename, count: entries.length };
}

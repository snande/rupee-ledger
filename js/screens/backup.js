/*
 * The Backup screen: an Import backup file picker that restores a backup
 * made by Export backup on the Today screen. renderBackup() returns the
 * whole screen for the router to put into <main>; mountBackup() then waits
 * for a file to be chosen.
 *
 * A chosen file is read on the phone with File.text() (or FileReader where
 * that is missing), checked by parseBackup() and merged by importEntries(),
 * both from src/backup-import.js. Nothing goes over the network, so it works
 * offline. The import only adds: an entry already in the ledger is skipped,
 * so restoring the same file twice adds nothing the second time. A file
 * that is not a valid backup shows parseBackup's own message and writes
 * nothing. The Today and Month screens load from the ledger each time they
 * open, so their totals include the restored spends straight away.
 */

import { parseBackup, importEntries } from '../../src/backup-import.js';
import { addMissingEntries, listEntries } from '../../src/ledger/store.js';

export const IMPORT_LABEL = 'Import backup';
export const IMPORT_HINT = 'Choose a backup file made with Export backup. Spends already on this phone are skipped, never replaced.';
export const READ_ERROR = 'The backup file could not be read.';

/* The on-device ledger the import writes to. */
const STORE = Object.freeze({ addMissingEntries, listEntries });

/* '3 added, 1 skipped'. */
export function addedMessage({ added = 0, skipped = 0 } = {}) {
  return added + ' added, ' + skipped + ' skipped';
}

/* The text of a chosen file, read on the phone: File.text() where the
   browser has it, FileReader otherwise. */
export function readFileText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error(READ_ERROR));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(READ_ERROR));
    reader.readAsText(file);
  });
}

export function renderBackup() {
  return '<div class="backup">' +
    '<section class="card backup-import" aria-labelledby="backup-import-heading">' +
      '<h2 id="backup-import-heading">' + IMPORT_LABEL + '</h2>' +
      '<p class="field backup-field">' +
        '<label for="backup-file">Backup file</label>' +
        '<input type="file" id="backup-file" accept=".json,application/json" ' +
          'aria-describedby="backup-hint" data-import-file>' +
      '</p>' +
      '<p class="hint" id="backup-hint">' + IMPORT_HINT + '</p>' +
      '<p class="hint backup-status" role="status" data-import-status hidden></p>' +
    '</section>' +
  '</div>';
}

/*
 * Wires the rendered screen: each file chosen is read, parsed and merged
 * into `store` (the on-device ledger by default), and the line under the
 * picker says how many entries were added and skipped, or why the file was
 * refused. A result that arrives after the route has changed writes nothing.
 * The picker is cleared after each import so the same file can be chosen
 * again. Returns { importing }: importing() resolves once the latest
 * import has settled, so a test can wait for it.
 */
export function mountBackup({
  main,
  isCurrent = () => true,
  store = STORE,
  read = readFileText,
}) {
  const input = main.querySelector('[data-import-file]');
  const status = main.querySelector('[data-import-status]');
  if (!input || !status) {
    throw new Error('The Backup screen markup is incomplete.');
  }

  const show = (text, failed) => {
    if (!isCurrent()) return;
    status.textContent = text;
    if (failed) status.classList?.add('hint-error');
    else status.classList?.remove('hint-error');
    status.setAttribute('role', failed ? 'alert' : 'status');
    if (text) status.removeAttribute('hidden');
    else status.setAttribute('hidden', '');
  };

  let attempt = 0;
  let latest = Promise.resolve();

  async function run(file) {
    const mine = ++attempt;
    input.disabled = true;
    show('Importing your backup', false);
    try {
      const { entries } = parseBackup(await read(file));
      const result = await importEntries(store, entries);
      if (mine === attempt) show(addedMessage(result), false);
    } catch (error) {
      if (mine === attempt) show(error?.message || READ_ERROR, true);
    } finally {
      if (mine === attempt) {
        input.disabled = false;
        input.value = '';
      }
    }
  }

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    latest = run(file);
  });

  if (typeof input.focus === 'function') input.focus();
  return { importing: () => latest };
}

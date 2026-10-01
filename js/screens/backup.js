/*
 * The Backup screen: an Import backup file picker that restores a backup
 * made by Export backup on the Today screen. renderBackup() returns the
 * whole screen for the router to put into <main>; mountBackup() then waits
 * for a file to be chosen.
 *
 * A chosen file is read on the phone with File.text() (or FileReader where
 * that is missing), checked by parseBackup() and counted by previewImport(),
 * all from src/backup-import.js. Before anything is written the screen
 * previews the merge: how many spends the file holds, the dates they span,
 * how many are new and how many are already on this phone. Only the Import
 * button then merges them with importEntries(); Cancel writes nothing. A
 * file with nothing new needs no choice: it reports 0 added straight away.
 * Nothing goes over the network, so it works offline. The import only adds:
 * an entry already in the ledger is skipped, so restoring the same file
 * twice adds nothing the second time. A file that is not a valid backup
 * shows parseBackup's own message and writes nothing. The Today and Month screens load from the ledger each time they
 * open, so their totals include the restored spends straight away.
 */

import { parseBackup, importEntries, previewImport } from '../../src/backup-import.js';
import { addMissingEntries, listEntries } from '../../src/ledger/store.js';

export const IMPORT_LABEL = 'Import backup';
export const IMPORT_HINT = 'Choose a backup file made with Export backup. Spends already on this phone are skipped, never replaced.';
export const READ_ERROR = 'The backup file could not be read.';
export const CANCELLED = 'Import cancelled. Nothing was added.';

/* '12 Sep 2026', as the Search screen writes dates. */
const DATE_LABEL = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/* The on-device ledger the import writes to. */
const STORE = Object.freeze({ addMissingEntries, listEntries });

/* '3 added, 1 skipped'. */
export function addedMessage({ added = 0, skipped = 0 } = {}) {
  return added + ' added, ' + skipped + ' skipped';
}

/* '1 spend', '4 spends'. */
export function spendCount(count) {
  return count + (count === 1 ? ' spend' : ' spends');
}

/* What an import will do, shown before it runs:
   '4 spends from 12 Sep 2026 to 30 Sep 2026: 3 to add, 1 already on this
   phone.' `entries` are as parseBackup returns them. */
export function previewMessage({ added = 0, skipped = 0 } = {}, entries = []) {
  const times = entries.map((entry) => new Date(entry.createdAt).getTime()).filter(Number.isFinite);
  let span = '';
  if (times.length > 0) {
    const first = DATE_LABEL.format(Math.min(...times));
    const last = DATE_LABEL.format(Math.max(...times));
    span = first === last ? ' on ' + first : ' from ' + first + ' to ' + last;
  }
  return spendCount(entries.length) + span + ': ' + added + ' to add, ' + skipped + ' already on this phone.';
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
      '<div class="backup-confirm" data-import-confirm hidden>' +
        '<div class="button-row">' +
          '<button type="button" data-import-accept>Import</button>' +
          '<button type="button" class="button-secondary" data-import-cancel>Cancel</button>' +
        '</div>' +
      '</div>' +
    '</section>' +
  '</div>';
}

/*
 * Wires the rendered screen: each file chosen is read and parsed, and the
 * line under the picker previews what importing it would do (or says why
 * the file was refused). Import merges the previewed entries into `store`
 * (the on-device ledger by default) and the line then says how many were
 * added and skipped; Cancel writes nothing. A file with nothing new reports
 * '0 added' with no choice to make. A result that arrives after the route
 * has changed writes nothing. The picker is cleared after each file so the
 * same one can be chosen again, and choosing another file replaces a
 * preview still waiting. Returns { importing }: importing() resolves once
 * the latest read, preview or import has settled, so a test can wait for it.
 */
export function mountBackup({
  main,
  isCurrent = () => true,
  store = STORE,
  read = readFileText,
}) {
  const input = main.querySelector('[data-import-file]');
  const status = main.querySelector('[data-import-status]');
  const confirm = main.querySelector('[data-import-confirm]');
  const accept = main.querySelector('[data-import-accept]');
  const cancel = main.querySelector('[data-import-cancel]');
  if (!input || !status || !confirm || !accept || !cancel) {
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

  /* The parsed entries waiting for Import or Cancel, or null. */
  let pending = null;
  const ask = (entries, added) => {
    if (!isCurrent()) return;
    pending = entries;
    accept.textContent = 'Import ' + spendCount(added);
    confirm.removeAttribute('hidden');
    if (typeof accept.focus === 'function') accept.focus();
  };
  const unask = () => {
    pending = null;
    confirm.setAttribute('hidden', '');
  };
  unask();

  let attempt = 0;
  let latest = Promise.resolve();

  /* Runs one step of the flow; only the latest step may touch the screen. */
  async function step(busyText, work) {
    const mine = ++attempt;
    const current = () => mine === attempt;
    unask();
    input.disabled = true;
    show(busyText, false);
    try {
      await work(current);
    } catch (error) {
      if (current()) show(error?.message || READ_ERROR, true);
    } finally {
      if (current()) {
        input.disabled = false;
        input.value = '';
      }
    }
  }

  const preview = (file) => step('Reading your backup', async (current) => {
    const { entries } = parseBackup(await read(file));
    const counts = await previewImport(store, entries);
    if (!current()) return;
    if (counts.added === 0) {
      show(addedMessage(counts), false);
      return;
    }
    show(previewMessage(counts, entries), false);
    ask(entries, counts.added);
  });

  const commit = (entries) => step('Importing your backup', async (current) => {
    const result = await importEntries(store, entries);
    if (current()) show(addedMessage(result), false);
  });

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    latest = preview(file);
  });

  accept.addEventListener('click', () => {
    if (!pending) return;
    latest = commit(pending);
  });

  cancel.addEventListener('click', () => {
    if (!pending) return;
    attempt += 1;
    unask();
    show(CANCELLED, false);
    if (typeof input.focus === 'function') input.focus();
  });

  if (typeof input.focus === 'function') input.focus();
  return { importing: () => latest };
}

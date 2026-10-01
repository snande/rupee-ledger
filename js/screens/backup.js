/*
 * The Backup screen, at '#/backup': a file picker that restores a backup
 * made with Export backup on the Today screen, and a line saying how many
 * spends it added and how many it skipped as already on this phone.
 * renderBackup() returns the whole screen for the router to put into <main>;
 * mountBackup() then wires the picker.
 *
 * Choosing a file reads its text on the phone with File.text(), or a
 * FileReader where that is missing, then hands it to parseBackup() and the
 * parsed entries to importEntries(), both in src/backup-import.js. Nothing
 * is fetched and nothing is uploaded, so the import works offline. A file
 * that parseBackup() refuses shows its message and writes nothing; an
 * import never deletes or overwrites a stored spend, so importing the same
 * file again adds 0. The Today and Month screens load from the ledger each
 * time they open, so their totals include the imported spends at once.
 * Strings are joined with + rather than template literals, as on the other
 * screens.
 */

import { parseBackup, importEntries } from '../../src/backup-import.js';
import * as store from '../../src/ledger/store.js';
import { escapeHtml } from './today.js';

export const IMPORT_LABEL = 'Import backup';
export const READ_ERROR = 'The backup file could not be read. Nothing was added.';
export const IMPORT_ERROR = 'The backup was not imported: your spends could not be saved. Nothing was added.';

/* '3 added, 1 skipped': what an import did, as the screen reports it. */
export function importSummary({ added, skipped }) {
  return added + ' added, ' + skipped + ' skipped';
}

/* The text of a picked file, read on the phone: File.text() where the
   browser has it, otherwise a FileReader. Never the network. */
export function readFileText(file) {
  if (file && typeof file.text === 'function') return Promise.resolve(file.text());
  const Reader = globalThis.FileReader;
  if (typeof Reader !== 'function') return Promise.reject(new Error('This browser cannot read files.'));
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

export function renderBackup() {
  return '<div class="backup">' +
    '<section class="card backup-import" aria-labelledby="backup-title">' +
      '<h2 class="backup-title" id="backup-title">Restore a backup</h2>' +
      '<p class="hint backup-hint">Pick a backup file made with Export backup. Spends already on this phone are skipped, ' +
        'and nothing is deleted. The file is read on this phone and never uploaded.</p>' +
      '<p class="field backup-field">' +
        '<label for="backup-file">' + escapeHtml(IMPORT_LABEL) + '</label>' +
        '<input type="file" id="backup-file" name="backup" accept=".json,application/json" data-backup-file>' +
      '</p>' +
      '<p class="backup-result" role="status" data-backup-result hidden></p>' +
      '<p class="hint hint-error backup-error" role="alert" data-backup-error hidden></p>' +
    '</section>' +
    '<a class="button-link button-secondary backup-back" href="#/today">Back to Today</a>' +
  '</div>';
}

/*
 * Wires the rendered screen. Each file chosen is read with `read`, parsed
 * with `parse` and, only when that succeeds, added with `run`: by default
 * readFileText(), parseBackup() and importEntries() on src/ledger/store.js.
 * The picker is off while an import runs and is cleared after each one, so
 * choosing the same file again imports it again. Once the router has
 * replaced the screen (isCurrent() is false) nothing more is drawn. Focus
 * goes to the picker. The change handler returns its import's promise,
 * which never rejects.
 */
export function mountBackup({
  main,
  isCurrent = () => true,
  read = readFileText,
  parse = parseBackup,
  run = (entries) => importEntries(store, entries),
}) {
  const input = main.querySelector('[data-backup-file]');
  const result = main.querySelector('[data-backup-result]');
  const error = main.querySelector('[data-backup-error]');
  if (!input || !result || !error) {
    throw new Error('The Backup screen markup is incomplete.');
  }

  const showLine = (line, text) => {
    if (!isCurrent()) return;
    line.textContent = text;
    if (text) line.removeAttribute('hidden');
    else line.setAttribute('hidden', '');
  };

  let importing = false;

  function importFile(file) {
    importing = true;
    input.disabled = true;
    showLine(result, '');
    showLine(error, '');
    let reading;
    try {
      reading = Promise.resolve(read(file));
    } catch (failure) {
      reading = Promise.reject(failure);
    }
    return reading
      .then(
        (text) => {
          let parsed;
          try {
            parsed = parse(text);
          } catch (failure) {
            /* A file parseBackup() refuses: its message, and no write. */
            showLine(error, failure && failure.message ? failure.message : READ_ERROR);
            return undefined;
          }
          return Promise.resolve()
            .then(() => run(parsed.entries))
            .then(
              (counts) => showLine(result, importSummary(counts)),
              () => showLine(error, IMPORT_ERROR),
            );
        },
        () => showLine(error, READ_ERROR),
      )
      .finally(() => {
        importing = false;
        input.disabled = false;
        input.value = '';
      });
  }

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file || importing) return Promise.resolve();
    return importFile(file);
  });

  if (typeof input.focus === 'function') input.focus();
}

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { exportBackup } from './backup-download.js';
import { backupFilename, buildBackup } from './backup-export.js';
import { add, closeLedger } from './ledger.js';
import { addEntry, listEntries } from './ledger/store.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from './ledger/fake-indexeddb.js';

const NOW = new Date(2026, 9, 1, 21, 30);

/* A page with just enough of document and URL for a download, recording
   every step in order. */
function fakePage() {
  const log = [];
  const blobs = new Map();
  const links = [];
  const body = {
    appendChild(node) {
      log.push(['append', node]);
      node.parentNode = body;
    },
  };
  const doc = {
    body,
    createElement(tag) {
      const attrs = new Map();
      const link = {
        tag,
        href: '',
        download: '',
        setAttribute: (name, value) => attrs.set(name, String(value)),
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
        click() {
          log.push(['click', link.href, link.getAttribute('download')]);
        },
        remove() {
          log.push(['remove', link]);
        },
      };
      links.push(link);
      log.push(['create', tag]);
      return link;
    },
  };
  let count = 0;
  const url = {
    createObjectURL(blob) {
      count += 1;
      const href = 'blob:ledger/' + count;
      blobs.set(href, blob);
      log.push(['createObjectURL', href]);
      return href;
    },
    revokeObjectURL(href) {
      log.push(['revokeObjectURL', href]);
    },
  };
  return { doc, url, log, blobs, links };
}

let fake;
let savedFetch;
let savedXHR;
let network;

beforeEach(async () => {
  await closeLedger();
  fake = createFakeIndexedDB();
  globalThis.indexedDB = fake;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
  network = [];
  savedFetch = globalThis.fetch;
  savedXHR = globalThis.XMLHttpRequest;
  globalThis.fetch = (...args) => {
    network.push(['fetch', ...args]);
    throw new Error('no network');
  };
  globalThis.XMLHttpRequest = function XMLHttpRequest() {
    network.push(['xhr']);
    throw new Error('no network');
  };
});

afterEach(async () => {
  await closeLedger();
  globalThis.fetch = savedFetch;
  globalThis.XMLHttpRequest = savedXHR;
});

test('it downloads every stored entry as dated JSON, then revokes the URL', async () => {
  await add({ amountPaise: 12000, note: 'chai', createdAt: new Date(2026, 8, 30, 9).getTime() });
  await add({ amountPaise: 45050, note: 'auto to station', createdAt: new Date(2026, 9, 1, 8).getTime() });
  await addEntry({ amount: 99, note: 'old record', createdAt: new Date(2025, 0, 5).getTime() });
  const stored = await listEntries();
  assert.equal(stored.length, 3);

  const page = fakePage();
  const result = await exportBackup({ doc: page.doc, url: page.url, now: NOW });

  assert.deepEqual(result, { filename: backupFilename(NOW), count: 3 });
  assert.equal(result.filename, 'rupee-ledger-backup-2026-10-01.json');

  const [href] = [...page.blobs.keys()];
  const blob = page.blobs.get(href);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'application/json');
  assert.deepEqual(JSON.parse(await blob.text()), buildBackup(stored, NOW));

  assert.equal(page.links.length, 1);
  const [link] = page.links;
  assert.equal(link.tag, 'a');
  assert.equal(link.href, href);
  assert.equal(link.download, backupFilename(NOW));
  assert.equal(link.getAttribute('download'), backupFilename(NOW));

  const steps = page.log.map(([step]) => step);
  assert.deepEqual(steps, ['createObjectURL', 'create', 'append', 'click', 'remove', 'revokeObjectURL']);
  assert.deepEqual(page.log[3], ['click', href, backupFilename(NOW)]);
  assert.deepEqual(page.log[5], ['revokeObjectURL', href]);
  assert.deepEqual(network, []);
});

test('an empty ledger still downloads a valid backup with no entries', async () => {
  const page = fakePage();
  const result = await exportBackup({ doc: page.doc, url: page.url, now: NOW });
  assert.equal(result.count, 0);
  const blob = [...page.blobs.values()][0];
  assert.deepEqual(JSON.parse(await blob.text()), buildBackup([], NOW));
  assert.deepEqual(network, []);
});

test('the file is named for the day of the export', async () => {
  const page = fakePage();
  const before = new Date();
  const { filename } = await exportBackup({ doc: page.doc, url: page.url });
  const after = new Date();
  assert.ok([backupFilename(before), backupFilename(after)].includes(filename), filename);
  assert.equal(page.links[0].download, filename);
});

test('a ledger read that fails rejects and downloads nothing', async () => {
  const page = fakePage();
  const failure = new Error('The ledger read was aborted.');
  await assert.rejects(exportBackup({ list: async () => { throw failure; }, doc: page.doc, url: page.url, now: NOW }), failure);
  assert.deepEqual(page.log, []);
  assert.equal(page.blobs.size, 0);
  assert.deepEqual(network, []);
});

test('a ledger that cannot be opened rejects and downloads nothing', async () => {
  await closeLedger();
  globalThis.indexedDB = undefined;
  const page = fakePage();
  await assert.rejects(exportBackup({ doc: page.doc, url: page.url, now: NOW }), /IndexedDB is not available/);
  assert.deepEqual(page.log, []);
  assert.deepEqual(network, []);
});

test('the URL is revoked even when the click throws', async () => {
  const page = fakePage();
  const create = page.doc.createElement;
  page.doc.createElement = (tag) => {
    const link = create(tag);
    link.click = () => {
      throw new Error('blocked');
    };
    return link;
  };
  await assert.rejects(exportBackup({ list: async () => [], doc: page.doc, url: page.url, now: NOW }), /blocked/);
  assert.equal(page.log.at(-1)[0], 'revokeObjectURL');
});

test('the export code makes no network request', async () => {
  const source = (await readFile(new URL('./backup-download.js', import.meta.url), 'utf8'))
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|https?:\/\//);
});

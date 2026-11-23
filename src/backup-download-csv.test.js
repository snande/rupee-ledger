import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CSV_MIME, csvFilename, exportCsv } from './backup-download.js';
import { add, closeLedger } from './ledger.js';
import { listEntries } from './ledger/store.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from './ledger/fake-indexeddb.js';

const NOW = new Date(2026, 10, 5, 19, 45);

/* A page with just enough of document and URL for a download, recording
   every step in order. */
function fakePage() {
  const log = [];
  const blobs = new Map();
  const links = [];
  const body = {
    appendChild(node) {
      log.push(['append', node]);
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

test('CSV_MIME is the standard CSV media type', () => {
  assert.equal(CSV_MIME, 'text/csv');
});

test('csvFilename() names the file for the local year and zero-padded month', () => {
  assert.equal(csvFilename(new Date(2026, 10, 5)), 'rupee-ledger-2026-11.csv');
  assert.equal(csvFilename(new Date(2026, 0, 31, 23, 59)), 'rupee-ledger-2026-01.csv');
  assert.equal(csvFilename(new Date(2027, 11, 1, 0, 0)), 'rupee-ledger-2027-12.csv');
});

test('exportCsv() clicks one link named for the month, with a CSV Blob, then revokes the URL', async () => {
  await add({ amountPaise: 12000, note: 'chai', createdAt: new Date(2026, 10, 4, 9).getTime() });
  const page = fakePage();
  const result = await exportCsv({ doc: page.doc, url: page.url, now: NOW });

  assert.deepEqual(result, { filename: 'rupee-ledger-2026-11.csv', count: 1 });
  assert.equal(page.links.length, 1);
  const [link] = page.links;
  assert.equal(link.tag, 'a');
  assert.equal(link.download, 'rupee-ledger-2026-11.csv');
  assert.equal(link.getAttribute('download'), 'rupee-ledger-2026-11.csv');

  assert.equal(page.blobs.size, 1);
  const [[href, blob]] = [...page.blobs];
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, CSV_MIME);
  assert.equal(link.href, href);

  const steps = page.log.map(([step]) => step);
  assert.deepEqual(steps, ['createObjectURL', 'create', 'append', 'click', 'remove', 'revokeObjectURL']);
  assert.equal(steps.filter((step) => step === 'click').length, 1);
  assert.deepEqual(page.log[3], ['click', href, 'rupee-ledger-2026-11.csv']);
  assert.deepEqual(page.log[5], ['revokeObjectURL', href]);
  assert.deepEqual(network, []);
});

test('the default file is the CSV header line', async () => {
  const page = fakePage();
  await exportCsv({ list: async () => [], doc: page.doc, url: page.url, now: NOW });
  const blob = [...page.blobs.values()][0];
  assert.equal(await blob.text(), 'Date,Amount (₹),Category,Note');
});

test('toCsv() receives the stored entries and the export moment, and writes the file', async () => {
  await add({ amountPaise: 2500, note: 'bus', createdAt: new Date(2026, 10, 1, 7).getTime() });
  const stored = await listEntries();
  const calls = [];
  const page = fakePage();
  await exportCsv({
    doc: page.doc,
    url: page.url,
    now: NOW,
    toCsv: (entries, now) => {
      calls.push([entries, now]);
      return 'Date,Amount (₹),Category,Note\r\n2026-11-01,25.00,,bus\r\n';
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], stored);
  assert.equal(calls[0][1], NOW);
  const blob = [...page.blobs.values()][0];
  assert.equal(await blob.text(), 'Date,Amount (₹),Category,Note\r\n2026-11-01,25.00,,bus\r\n');
});

test('exportCsv() opens no write transaction and leaves stored spends unchanged', async () => {
  await add({ amountPaise: 45050, note: 'auto', createdAt: new Date(2026, 10, 2, 8).getTime() });
  const before = await listEntries();
  const txBefore = fake.transactions.length;

  const page = fakePage();
  await exportCsv({ doc: page.doc, url: page.url, now: NOW });

  const opened = fake.transactions.slice(txBefore);
  assert.ok(opened.length > 0, 'the export reads the store');
  assert.deepEqual(opened.map((tx) => tx.mode).filter((mode) => mode !== 'readonly'), []);
  assert.deepEqual(await listEntries(), before);
  assert.deepEqual(network, []);
});

test('a ledger read that fails rejects with no Blob and no download', async () => {
  const page = fakePage();
  const failure = new Error('The ledger read was aborted.');
  let built = 0;
  await assert.rejects(
    exportCsv({
      list: async () => {
        throw failure;
      },
      doc: page.doc,
      url: page.url,
      now: NOW,
      toCsv: () => {
        built += 1;
        return '';
      },
    }),
    failure,
  );
  assert.equal(built, 0);
  assert.deepEqual(page.log, []);
  assert.equal(page.blobs.size, 0);
  assert.equal(page.links.length, 0);
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
  await assert.rejects(exportCsv({ list: async () => [], doc: page.doc, url: page.url, now: NOW }), /blocked/);
  assert.equal(page.log.at(-1)[0], 'revokeObjectURL');
});

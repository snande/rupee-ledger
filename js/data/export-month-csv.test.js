// exportMonthCsv() against a fake IndexedDB and a fake page: the file is
// monthCsv()'s rows for the spends the This month card sums, named for the
// month, and a read that fails downloads nothing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { exportMonthCsv } from './export-month-csv.js';
import { loadEntries } from './ledger.js';
import { add, closeLedger } from '../../src/ledger.js';
import { CSV_BOM, MONTH_CSV_HEADER } from '../../src/csv-export.js';
import { compareCsv, seedSpends, NOW as SEED_NOW } from '../../scripts/check-csv-exact.mjs';
import { totals } from '../../src/totals.js';
import { createFakeIndexedDB, FakeIDBKeyRange } from '../../src/ledger/fake-indexeddb.js';

const NOW = new Date(2026, 10, 5, 19, 45);

/* Just enough of document and URL for one download, keeping each Blob. */
function fakePage() {
  const blobs = [];
  const names = [];
  const doc = {
    body: { appendChild() {} },
    createElement() {
      const link = {
        href: '',
        download: '',
        setAttribute() {},
        click: () => names.push(link.download),
        remove() {},
      };
      return link;
    },
  };
  const url = {
    createObjectURL(blob) {
      blobs.push(blob);
      return 'blob:ledger/' + blobs.length;
    },
    revokeObjectURL() {},
  };
  return { doc, url, blobs, names };
}

const csvOf = async (page) => page.blobs[0].text();

/* The saved file's exact text, keeping a leading BOM (Blob.text() drops it). */
const rawCsvOf = async (page) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(await page.blobs[0].arrayBuffer());

/* The first three bytes of the saved file. */
const leadingBytes = async (page) => [...new Uint8Array(await page.blobs[0].arrayBuffer()).slice(0, 3)];

/* The Amount (₹) column of a CSV, summed in paise. */
function amountColumnPaise(text) {
  return text.split('\r\n').slice(1).reduce((sum, row) => sum + Math.round(Number(row.split(',')[1]) * 100), 0);
}

beforeEach(async () => {
  await closeLedger();
  globalThis.indexedDB = createFakeIndexedDB();
  globalThis.IDBKeyRange = FakeIDBKeyRange;
});

afterEach(async () => {
  await closeLedger();
});

test('the file holds this month’s spends as rows and sums to the This month card', async () => {
  await add({ amountPaise: 12000, note: 'chai', createdAt: new Date(2026, 10, 4, 9).getTime() });
  await add({ amountPaise: 4550, note: 'auto', createdAt: new Date(2026, 10, 5, 8).getTime() });
  await add({ amountPaise: 99900, note: 'rent share', createdAt: new Date(2026, 9, 30, 20).getTime() });

  const page = fakePage();
  const result = await exportMonthCsv({ doc: page.doc, url: page.url, now: NOW });

  assert.deepEqual(result, { filename: 'rupee-ledger-2026-11.csv', count: 2 });
  assert.deepEqual(page.names, ['rupee-ledger-2026-11.csv']);
  const text = await csvOf(page);
  const lines = text.split('\r\n');
  assert.equal(lines[0], MONTH_CSV_HEADER);
  assert.deepEqual(lines.slice(1).map((line) => line.split(',')[3]), ['chai', 'auto']);
  assert.ok(lines.slice(1).every((line) => line.startsWith('2026-11-')));

  const card = totals(await loadEntries({ now: NOW }), NOW).month;
  assert.equal(card, 16550);
  assert.equal(amountColumnPaise(text), card);
});

test('a month with no spends downloads the header alone and counts 0', async () => {
  await add({ amountPaise: 5000, note: 'lunch', createdAt: new Date(2026, 9, 12, 13).getTime() });
  const page = fakePage();
  const result = await exportMonthCsv({ doc: page.doc, url: page.url, now: NOW });
  assert.deepEqual(result, { filename: 'rupee-ledger-2026-11.csv', count: 0 });
  assert.equal(await csvOf(page), MONTH_CSV_HEADER);
});

test('the load is asked for the export moment’s month', async () => {
  const asked = [];
  const page = fakePage();
  await exportMonthCsv({
    load: async ({ now }) => {
      asked.push(now);
      return [{ amountPaise: 2500, note: 'bus', category: 'Travel', timestamp: new Date(2026, 10, 1, 7).getTime() }];
    },
    doc: page.doc,
    url: page.url,
    now: NOW,
  });
  assert.deepEqual(asked, [NOW]);
  assert.equal(await csvOf(page), MONTH_CSV_HEADER + '\r\n2026-11-01,25,Travel,bus');
});

test('a read that fails rejects and downloads nothing', async () => {
  const page = fakePage();
  const failure = new Error('The ledger read was aborted.');
  await assert.rejects(
    exportMonthCsv({
      load: async () => {
        throw failure;
      },
      doc: page.doc,
      url: page.url,
      now: NOW,
    }),
    failure,
  );
  assert.equal(page.blobs.length, 0);
  assert.deepEqual(page.names, []);
});

test('a month with spends saves the UTF-8 BOM, then the header and the unchanged rows', async () => {
  const page = fakePage();
  await exportMonthCsv({
    load: async () => [
      { amountPaise: 2500, note: 'bus', category: 'Travel', timestamp: new Date(2026, 10, 1, 7).getTime() },
    ],
    doc: page.doc,
    url: page.url,
    now: NOW,
  });
  assert.deepEqual(await leadingBytes(page), [0xef, 0xbb, 0xbf]);
  const text = await rawCsvOf(page);
  assert.ok(text.startsWith('﻿Date,Amount (₹),Category,Note'));
  assert.equal(text, '﻿' + 'Date,Amount (₹),Category,Note' + '\r\n2026-11-01,25,Travel,bus');
});

test('a month with no spends saves the BOM and the header alone, counting 0', async () => {
  await add({ amountPaise: 5000, note: 'lunch', createdAt: new Date(2026, 9, 12, 13).getTime() });
  const page = fakePage();
  const result = await exportMonthCsv({ doc: page.doc, url: page.url, now: NOW });
  assert.deepEqual(result, { filename: 'rupee-ledger-2026-11.csv', count: 0 });
  assert.deepEqual(await leadingBytes(page), [0xef, 0xbb, 0xbf]);
  assert.equal(await rawCsvOf(page), CSV_BOM + MONTH_CSV_HEADER);
});

test('the exported text, BOM included, passes the CSV_EXACT check', async () => {
  const records = seedSpends(SEED_NOW);
  const page = fakePage();
  const result = await exportMonthCsv({
    load: async () => records.map(({ expected, ...entry }) => entry),
    doc: page.doc,
    url: page.url,
    now: SEED_NOW,
  });
  const text = await rawCsvOf(page);
  assert.ok(text.startsWith(CSV_BOM));
  assert.equal(result.count, records.filter((record) => record.expected).length);
  const { mismatches, missing, extra } = compareCsv(text, records);
  assert.deepEqual({ mismatches, missing, extra }, { mismatches: 0, missing: 0, extra: 0 });
});

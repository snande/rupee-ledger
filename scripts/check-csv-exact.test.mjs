import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { monthCsv } from '../src/csv-export.js';
import {
  cellToPaise,
  compareCsv,
  NOW,
  parseCsv,
  runCheck,
  seedSpends,
} from './check-csv-exact.mjs';

const SCRIPT = fileURLToPath(new URL('./check-csv-exact.mjs', import.meta.url));

/* The seeded entries as the ledger stores them, without the `expected` flag. */
function entries(now = NOW) {
  return seedSpends(now).map(({ expected, ...entry }) => entry);
}

/* monthCsv's output with `edit` applied to the data row whose Note is `note`. */
function tampered(note, edit) {
  return (list, now) => {
    const rows = parseCsv(monthCsv(list, now));
    const quote = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
    return rows
      .map((cells, index) => (index > 0 && cells[3] === note ? edit([...cells]) : cells))
      .map((cells) => cells.map(quote).join(','))
      .join('\r\n');
  };
}

function quietRun(build) {
  const lines = [];
  const code = runCheck({ build, log: (line) => lines.push(line), warn: () => {} });
  return { code, line: lines.at(-1) };
}

test('the seed covers paise, 00:00 on the 1st, now, and the prior month’s last minute', () => {
  const seed = seedSpends(NOW);
  const byId = Object.fromEntries(seed.map((record) => [record.id, record]));
  assert.equal(byId.paise.amountPaise, 4550);
  assert.equal(byId.first.timestamp, new Date(2026, 10, 1, 0, 0).getTime());
  assert.equal(byId.now.timestamp, NOW.getTime());
  assert.equal(byId['prior-month'].timestamp, new Date(2026, 9, 31, 23, 59).getTime());
  assert.equal(byId['prior-month'].expected, false);
  assert.equal(new Set(seed.map((record) => record.note)).size, seed.length);
});

test('monthCsv matches the seeded spends exactly and leaves the prior-month spend out', () => {
  const csv = monthCsv(entries(), NOW);
  assert.deepEqual(compareCsv(csv, seedSpends(NOW)), {
    mismatches: 0, missing: 0, extra: 0, details: [],
  });
  assert.ok(!csv.includes('last day of last month'));
});

test('the check prints CSV_EXACT with all zeros and exits 0 on the real monthCsv', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^CSV_EXACT mismatches=0 missing=0 extra=0$/m);
});

test('a row whose amount differs from its record is a mismatch and fails the check', () => {
  const build = tampered('chai, samosa', (cells) => { cells[1] = '45.05'; return cells; });
  assert.deepEqual(quietRun(build), { code: 1, line: 'CSV_EXACT mismatches=1 missing=0 extra=0' });
});

test('an amount off by one paisa or rounded to whole rupees is a mismatch', () => {
  for (const amount of ['45.51', '46', '45.50000001', '₹45.50', '']) {
    const build = tampered('chai, samosa', (cells) => { cells[1] = amount; return cells; });
    assert.equal(quietRun(build).code, 1, `Amount ${JSON.stringify(amount)} passed`);
  }
});

test('a row whose date differs from its record is a mismatch and fails the check', () => {
  const build = tampered('auto at midnight on the 1st', (cells) => { cells[0] = '2026-10-31'; return cells; });
  assert.deepEqual(quietRun(build), { code: 1, line: 'CSV_EXACT mismatches=1 missing=0 extra=0' });
});

test('a dropped row is missing and a prior-month row is extra', () => {
  const dropNow = (list, now) => monthCsv(list.filter((entry) => entry.id !== 'now'), now);
  assert.deepEqual(quietRun(dropNow), { code: 1, line: 'CSV_EXACT mismatches=0 missing=1 extra=0' });

  const keepPrior = (list, now) => monthCsv(list, now) + '\r\n2026-10-31,999,Shopping,last day of last month';
  assert.deepEqual(quietRun(keepPrior), { code: 1, line: 'CSV_EXACT mismatches=0 missing=0 extra=1' });
});

test('a repeated row is extra', () => {
  const twice = (list, now) => {
    const csv = monthCsv(list, now);
    return `${csv}\r\n${csv.split('\r\n')[1]}`;
  };
  assert.deepEqual(quietRun(twice), { code: 1, line: 'CSV_EXACT mismatches=0 missing=0 extra=1' });
});

test('cellToPaise reads rupee cells as exact integer paise', () => {
  assert.equal(cellToPaise('45.5'), 4550);
  assert.equal(cellToPaise('45.05'), 4505);
  assert.equal(cellToPaise('0.01'), 1);
  assert.equal(cellToPaise('123450.07'), 12345007);
  assert.equal(cellToPaise('120'), 12000);
  assert.equal(cellToPaise('45.555'), null);
  assert.equal(cellToPaise('1e3'), null);
  assert.equal(cellToPaise(''), null);
});

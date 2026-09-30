import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const manifestText = read('manifest.webmanifest').toString('utf8');
const manifest = JSON.parse(manifestText);
const indexHtml = read('index.html').toString('utf8');
const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));

function pngSize(path) {
  const bytes = read(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is not a PNG`);
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR', `${path} has no IHDR`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

function linkHref(rel) {
  const tag = head.match(new RegExp(`<link[^>]*\\brel="${rel}"[^>]*>`));
  return tag?.[0].match(/\bhref="([^"]*)"/)?.[1];
}

test('manifest carries the install fields and runs standalone from any subpath', () => {
  for (const field of ['name', 'short_name', 'start_url', 'scope', 'background_color', 'theme_color']) {
    assert.equal(typeof manifest[field], 'string', `manifest has no ${field}`);
  }
  assert.equal(manifest.name, 'Rupee Ledger');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(Array.isArray(manifest.icons));
});

test('every manifest icon is a PNG under icons/ of the size it claims', () => {
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^icons\/[\w-]+\.png$/);
    assert.equal(icon.type, 'image/png');
    assert.equal(pngSize(icon.src), icon.sizes);
  }
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('index.html head links the manifest, theme colour and touch icon by relative path', () => {
  assert.equal(linkHref('manifest'), 'manifest.webmanifest');
  assert.match(head, /<meta name="theme-color" content="#[0-9A-Fa-f]{6}">/);
  const touchIcon = linkHref('apple-touch-icon');
  assert.match(touchIcon, /^icons\/[\w-]+\.png$/);
  assert.equal(pngSize(touchIcon), '180x180');
});

test('the manifest and icon generator reference no other origin', () => {
  assert.doesNotMatch(manifestText, /https?:\/\//i);
  assert.doesNotMatch(read('scripts/make_icons.py').toString('utf8'), /https?:\/\//i);
});

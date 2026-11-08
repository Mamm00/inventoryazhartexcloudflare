// tests/site.test.js — jsdom + tools/make_landing.py output: landing page
// EN/AR parity, 404 bounce, structure, doc parity with D1-derived numbers,
// sign-in table compared row-for-row against SEED_USERS (via the manifest,
// which is generated from them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'seed_manifest.json'), 'utf-8'));

// Must match PARITY in tools/make_landing.py (one element per key per block).
const PARITY_KEYS = [
  'title', 'tagline', 'intro', 'numbers_h', 'signins_h', 'open_h', 'security_h', 'security_body', 'deploy_h', 'deploy_body',
];

const landing = new JSDOM(readFileSync(path.join(ROOT, 'app', 'landing.html'), 'utf-8')).window.document;

test('landing page: EN/AR parity — both blocks carry the identical key set', () => {
  const en = [...landing.querySelectorAll('#lang-en [data-k]')].map((el) => el.dataset.k);
  const ar = [...landing.querySelectorAll('#lang-ar [data-k]')].map((el) => el.dataset.k);
  assert.deepEqual([...en].sort(), [...ar].sort(), 'EN and AR blocks must be key-identical');
  assert.deepEqual([...en].sort(), [...PARITY_KEYS].sort(), 'parity key set matches the generator');
  for (const el of landing.querySelectorAll('[data-k]')) {
    assert.ok(el.textContent.trim().length > 0, `key ${el.dataset.k} must render text`);
  }
});

test('landing page structure: headings, numbers table, shed map, sign-ins', () => {
  assert.ok(landing.querySelector('h1'), 'landing has an h1');
  assert.ok(landing.querySelector('#numbers-table'), 'numbers table present');
  assert.ok(landing.querySelector('#shed-table'), 'shed map present');
  assert.ok(landing.querySelector('#signins-table'), 'sign-in table present');
  assert.ok(landing.querySelector('a[href="/index.html"]'), 'link into the app');
});

test('landing sign-in table matches the seeded accounts row-for-row', () => {
  const rows = [...landing.querySelectorAll('#signins-table tbody tr')];
  assert.equal(rows.length, manifest.sign_ins.length, 'one row per seeded account');
  rows.forEach((tr, i) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent);
    const seed = manifest.sign_ins[i];
    assert.equal(cells[0], seed.username, `row ${i}: username`);
    assert.equal(cells[1], seed.password, `row ${i}: password`);
    assert.ok(cells[2].includes(seed.who_en), `row ${i}: who (EN)`);
    assert.ok(cells[2].includes(seed.who_ar), `row ${i}: who (AR)`);
    assert.ok(cells[3].includes(seed.scope_en), `row ${i}: scope (EN)`);
    assert.ok(cells[3].includes(seed.scope_ar), `row ${i}: scope (AR)`);
  });
});

test('landing numbers are exactly the seed_manifest values', () => {
  const rows = [...landing.querySelectorAll('#numbers-table tbody tr')];
  const table = Object.fromEntries(rows.map((tr) => {
    const [k, v] = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    return [k, v];
  }));
  assert.equal(Number(table['warehouses']), manifest.counts.warehouses);
  assert.equal(Number(table['fabrics']), manifest.counts.fabrics);
  assert.equal(Number(table['colors']), manifest.counts.colors);
  assert.equal(Number(table['mappings']), manifest.counts.mappings);
  assert.equal(Number(table['inventory rows']), manifest.counts.inventory_rows);
  assert.equal(Number(table['movements']), manifest.counts.movements);
  assert.equal(Number(table['records']), manifest.counts.records);
  assert.equal(Number(table['rolls — shed cards total']), manifest.rolls.company_active);
  assert.equal(Number(table['rolls — raw inventory total']), manifest.rolls.raw_total);
  assert.equal(Number(table['rolls on deactivated mappings']), manifest.rolls.inactive_rolls);
  assert.equal(Number(table['wh-625 utilisation %']), manifest.wh625.util_pct);
});

test('404 bounce redirects unknown paths back to a hash route', () => {
  const html = readFileSync(path.join(ROOT, 'app', '404.html'), 'utf-8');
  assert.ok(html.includes('window.location.replace'), '404 page redirects');
  assert.ok(html.includes('#/'), 'the redirect targets a hash route');
  const doc = new JSDOM(html).window.document;
  assert.ok(doc.querySelector('a[href="#/stock"]'), 'fallback link present');
});

test('README numbers block matches seed_manifest.json (doc parity)', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
  const m = readme.match(/<!-- SEED-MANIFEST:BEGIN -->([\s\S]*?)<!-- SEED-MANIFEST:END -->/);
  assert.ok(m, 'README carries the SEED-MANIFEST block');
  const block = m[1];
  const checks = [
    ['Warehouses', manifest.counts.warehouses],
    ['Fabrics', manifest.counts.fabrics],
    ['Mapping rows', manifest.counts.mappings],
    ['Inventory rows', manifest.counts.inventory_rows],
    ['Movements (stock_events)', manifest.counts.movements],
    ['Keeper colour codes', manifest.counts.keeper_codes],
    ['Records (countRecords)', manifest.counts.records],
    ['Rolls — Mostafa sheds', manifest.rolls.mostafa_active],
    ['Rolls — colleague sheds', manifest.rolls.keeper2_active],
    ['Rolls — shed cards total', manifest.rolls.company_active],
    ['Rolls — raw inventory total', manifest.rolls.raw_total],
  ];
  for (const [label, value] of checks) {
    const row = block.split('\n').find((line) => line.startsWith(`| ${label} |`) || line.startsWith(`| ${label} (`));
    assert.ok(row, `README block must contain "${label}"`);
    assert.ok(row.includes(`| ${value} |`) || row.endsWith(`| ${value} |`), `README "${label}" must read ${value}`);
  }
  // Colour-grade breakdown is quoted from the manifest too.
  assert.ok(block.includes(`A ${manifest.color_grades.A}`), 'grade A count quoted');
  assert.ok(block.includes(`D ${manifest.color_grades.D}`), 'grade D count quoted');
  assert.ok(block.includes(`${manifest.wh625.util_pct}%`), 'wh-625 utilisation quoted');
});

test('README honesty note: Cloudflare-only writable mode, read-only snapshot, assistive AI, server-side RBAC', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf-8').toLowerCase();
  assert.ok(readme.includes('server-side rbac'));
  assert.ok(readme.includes('never trusted'));
  assert.ok(readme.includes('requires cloudflare and https'));
  assert.ok(readme.includes('read-only'));
  assert.ok(readme.includes('assistive'));
});

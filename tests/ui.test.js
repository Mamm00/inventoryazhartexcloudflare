// tests/ui.test.js — jsdom with mocked fetch. All 12 routes × 3 accounts ×
// EN+AR: no error banner, no unresolved key, no raw {placeholder}, sidebar
// links equal viewsFor(user). Accordion survives an AR flip. No innerHTML for
// user data. Print output goes through the server print-sheet endpoint, not
// window.print().

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { viewsFor } from '../shared/permissions.js';
import { I18N_RAW, t } from '../shared/i18n.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'seed_manifest.json'), 'utf-8'));

const ACCOUNTS = {
  admin: {
    id: 'u-admin', username: 'admin', role: 'Admin', warehouseIds: [],
    displayNameAr: 'المسؤول', displayNameEn: 'Admin',
  },
  keeper1: {
    id: 'u-keeper1', username: 'keeper1', role: 'WarehouseKeeper',
    warehouseIds: ['wh-alwa', 'wh-leon', 'wh-azouz', 'wh-zibda', 'wh-showroom'],
    displayNameAr: 'مصطفى', displayNameEn: 'Mostafa',
  },
  keeper2: {
    id: 'u-keeper2', username: 'keeper2', role: 'WarehouseKeeper',
    warehouseIds: ['wh-625', 'wh-magdy', 'wh-wahman', 'wh-lycra', 'wh-kashry'],
    displayNameAr: 'المسؤول الثاني', displayNameEn: 'Second keeper',
  },
};

const ALL_VIEWS = ['readme', 'stock', 'inventory', 'movements', 'colors', 'cross', 'dashboard', 'reports', 'masters', 'audit', 'settings', 'profile'];
const KEY_SET = new Set(Object.keys(I18N_RAW));
const PLACEHOLDER = /[{][a-zA-Z_][a-zA-Z0-9_]*[}]/;

const shed = (id, keeper) => ({
  id, name_ar: `مخزن ${id}`, name_en: `Shed ${id}`, keeper_user_id: keeper,
  allowed_grades: 'A,B', grade_label_ar: 'كل الدرجات', capacity_rolls: 1000,
  fabric_types: 2, colors: 5, rolls: 120, meters: 6000, value: 5000, low_stock: 1,
  utilization_pct: 12.0, utilization_band: 'green', last_activity: '2026-11-01T10:00:00Z',
});

const fabricSum = (wid, i) => ({
  warehouse_id: wid, fabric_id: `fab-00${i}`, name_ar: `قماش ${i}`, name_en: `Fabric ${i}`,
  meters_per_roll: 50, unit_cost_per_roll: 400, colors: 3, rolls: 60,
  meters: 3000, value: 24000, low: 1, out: 0,
});

const invRow = (wid, i) => ({
  mapping_id: `map-${wid}-${i}`, warehouse_id: wid, fabric_id: `fab-00${i}`, color_id: `col-x-${i}`,
  fab_name_ar: `قماش ${i}`, fab_name_en: `Fabric ${i}`,
  col_name_ar: `لون ${i}`, col_name_en: `Colour ${i}`,
  hex: '#4455aa', family: 'blue', grade: 'A',
  meters_per_roll: 50, unit_cost_per_roll: 400,
  opening_rolls: 10, rolls_in: 2, rolls_out: 1, closing_rolls: 11,
  meters: 550, value: 4400, status: 'ok', status_key: 'status.ok',
  min_rolls: 2, max_rolls: 40, lead_time_days: 5, reorder: 0,
  mapping_active: true, valid: true,
});

function mockRoutes(scopeIds) {
  const sheds = scopeIds.map((id) => shed(id, id === 'wh-625' ? 'u-keeper2' : 'u-keeper1'));
  return {
    '/api/auth/me': { user: null, scope: scopeIds },
    '/api/stock': {
      sheds,
      totals: {
        rolls: sheds.reduce((a, s) => a + s.rolls, 0),
        meters: sheds.reduce((a, s) => a + s.meters, 0),
        value: sheds.reduce((a, s) => a + s.value, 0),
        low_stock: sheds.reduce((a, s) => a + s.low_stock, 0),
        fabric_types: 2, shed_count: sheds.length,
      },
      scope: scopeIds,
    },
    '/api/inventory': {
      tree: sheds.map((s) => ({ warehouse: { id: s.id, name_ar: s.name_ar, name_en: s.name_en }, fabrics: [fabricSum(s.id, 1), fabricSum(s.id, 2)] })),
      rows: [invRow(sheds[0].id, 1), invRow(sheds[0].id, 2)],
      scope: scopeIds,
    },
    '/api/movements': {
      events: [{
        effective_date: '2026-11-01', kind: 'in', wh_name_ar: 'مخزن ١', wh_name_en: 'Shed 1',
        fab_name_ar: 'قماش ١', fab_name_en: 'Fabric 1', col_name_ar: 'لون ١', col_name_en: 'Colour 1',
        hex: '#4455aa', rolls_delta: 3, actor_username: 'keeper1', ref_id: 'trf-001',
      }],
      scope: scopeIds,
    },
    '/api/colors': {
      colors: [{
        id: 'col-x-1', name_ar: 'أزرق ملكي', name_en: 'Royal Blue', hex: '#1f4fa3',
        family: 'blue', grade: 'A', active: 1, sheds: [scopeIds[0]], usage_count: 1,
      }],
      codes: [{
        id: 'kcode-01', keeper_user_id: 'u-keeper1', color_id: 'col-x-1',
        custom_code: 'M-BLU-007', custom_name: 'أزرق المعرض', notes: 'رف A3',
        last_updated: '2026-10-20', col_name_ar: 'أزرق ملكي', col_name_en: 'Royal Blue', hex: '#1f4fa3',
      }],
    },
    '/api/cross': {
      sheds: scopeIds[0] === 'wh-alwa' ? [shed('wh-625', 'u-keeper2')] : [],
      owner: scopeIds[0] === 'wh-alwa' ? { id: 'u-keeper2', username: 'keeper2', display_name_ar: 'الأمين الثاني', display_name_en: 'Second keeper' } : null,
      readOnly: true, scope: scopeIds,
    },
    '/api/dashboard': {
      kpis: { rolls: 120, meters: 6000, value: 5000, low: 1 },
      byShed: sheds.map((s) => ({ id: s.id, name_ar: s.name_ar, name_en: s.name_en, rolls: s.rolls })),
      mix: [{ fabric_id: 'fab-001', name_ar: 'قماش ١', name_en: 'Fabric 1', rolls: 60 }],
      grades: [{ grade: 'A', rolls: 80 }, { grade: 'B', rolls: 40 }],
      trend: [{ bucket: '2026-W43', closing: 110 }, { bucket: '2026-W44', closing: 120 }],
      topMovers: [{
        warehouse_id: scopeIds[0], fabric_id: 'fab-001', color_id: 'col-x-1',
        wh_name_ar: 'مخزن ١', wh_name_en: 'Shed 1', fab_name_ar: 'قماش ١', fab_name_en: 'Fabric 1',
        col_name_ar: 'لون ١', col_name_en: 'Colour 1', hex: '#4455aa', moves: 2, rolled: 5,
      }],
      reorder: [{
        warehouse_id: scopeIds[0], fabric_id: 'fab-001', color_id: 'col-x-1', min_rolls: 20,
        closing_rolls: 5, wh_name_ar: 'مخزن ١', wh_name_en: 'Shed 1',
        fab_name_ar: 'قماش ١', fab_name_en: 'Fabric 1', col_name_ar: 'لون ١', col_name_en: 'Colour 1',
        hex: '#4455aa', reorder_qty: 15,
      }],
      scope: scopeIds,
    },
    '/api/masters/warehouses': {
      rows: sheds.map((s) => ({
        id: s.id, name_ar: s.name_ar, name_en: s.name_en, keeper_user_id: s.keeper_user_id,
        allowed_grades: 'A,B', grade_label_ar: 'كل الدرجات', capacity_rolls: 1000, active: 1, summary: s,
      })),
    },
    '/api/masters/fabrics': {
      rows: [{ id: 'fab-001', name_ar: 'قماش ١', name_en: 'Fabric 1', meters_per_roll: 50, unit_cost_per_roll: 400, active: 1 }],
    },
    '/api/masters/colors': {
      rows: [{ id: 'col-x-1', name_ar: 'أزرق ملكي', name_en: 'Royal Blue', hex: '#1f4fa3', family: 'blue', grade: 'A', active: 1, usage_count: 1 }],
    },
    '/api/masters/mapping': {
      rows: [{
        id: 'map-1', warehouse_id: scopeIds[0], fabric_id: 'fab-001', color_id: 'col-x-1',
        min_rolls: 2, max_rolls: 40, lead_time_days: 5, active: 1,
        wh_name_ar: 'مخزن ١', wh_name_en: 'Shed 1', fab_name_ar: 'قماش ١', fab_name_en: 'Fabric 1',
        col_name_ar: 'لون ١', col_name_en: 'Colour 1', hex: '#4455aa',
      }],
    },
    '/api/audit': {
      rows: [{
        id: 'a1', actor_user_id: 'u-keeper1', action: 'movement.create', entity: 'movement',
        entity_id: 'e1', before_json: '{"rolls":1}', after_json: '{"rolls":2}',
        warehouse_id: scopeIds[0], ip: '127.0.0.1', result: 'OK', created_at: '2026-11-01T10:00:00Z',
      }],
      limit: 200, offset: 0,
    },
    '/api/settings': {
      settings: [{ key: 'guide_version', value: '1.2.0' }],
      users: [{ id: 'u-admin', username: 'admin', role: 'Admin', warehouse_ids: '[]', active: 1 }],
      records: manifest.counts.records,
    },
    '/api/profile': {
      user: { id: 'u-keeper1', username: 'keeper1', role: 'WarehouseKeeper', displayNameAr: 'مصطفى', displayNameEn: 'Mostafa' },
      sheds: [{ id: scopeIds[0], name_ar: 'مخزن ١', name_en: 'Shed 1', allowed_grades: 'A,B', grade_label_ar: 'كل الدرجات' }],
      codes: [],
      readOnly: true,
    },
    '/api/readme': {
      version: '1.2.0', storageMode: 'cloudflare-d1', recordCount: manifest.counts.records,
      roleMatrix: {
        actions: ['inventory.write', 'movement.create', 'color.add', 'color.delete', 'fabric.edit', 'keepercode.write', 'settings.write'],
        perms: { 'inventory.write': ['WarehouseKeeper'], 'settings.write': ['Admin'] },
        roles: ['Admin', 'WarehouseKeeper'],
      },
      views: viewsFor(ACCOUNTS.admin),
      shedMap: sheds,
      shedMapTotal: sheds.reduce((a, s) => a + s.rolls, 0),
      scopeIsAll: scopeIds.length === 10,
      steps: ['rd.step1', 'rd.step2', 'rd.step3', 'rd.step4', 'rd.step5', 'rd.step6', 'rd.step7', 'rd.step8'],
    },
  };
}

let App;
let dom;
const openCalls = [];

before(async () => {
  const html = readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf-8');
  dom = new JSDOM(html, { url: 'https://fabric-roll-stock.pages.dev/', pretendToBeVisual: true });
  dom.window.__TEST__ = true;
  dom.window.open = (url) => { openCalls.push(url); return null; };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.location = dom.window.location;

  let routes = mockRoutes(ACCOUNTS.admin.warehouseIds.concat(['wh-625', 'wh-magdy', 'wh-wahman', 'wh-lycra', 'wh-kashry']));
  globalThis.fetch = async (url) => {
    const pathname = String(url).split('?')[0];
    const hit = routes[pathname];
    if (!hit) return new Response(JSON.stringify({ error: 'NO_MOCK', pathname }), { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  globalThis.__setRoutes = (r) => { routes = r; };

  App = await import('../app/app.js');
});

function textNodes(el, out = []) {
  for (const child of el.childNodes) {
    if (child.nodeType === 3) out.push(child.nodeValue);
    else textNodes(child, out);
  }
  return out;
}

function assertClean(renderLabel) {
  const doc = globalThis.document;
  assert.equal(doc.querySelector('#error-banner'), null, `${renderLabel}: error banner shown`);
  for (const text of textNodes(doc.body)) {
    const trimmed = text.trim();
    assert.ok(!PLACEHOLDER.test(trimmed), `${renderLabel}: raw placeholder in "${trimmed}"`);
    assert.ok(!KEY_SET.has(trimmed), `${renderLabel}: unresolved i18n key "${trimmed}"`);
  }
}

function assertSidebar(user, renderLabel) {
  const links = [...globalThis.document.querySelectorAll('#nav a[data-view]')].map((a) => a.dataset.view);
  assert.deepEqual(links, viewsFor(user), `${renderLabel}: sidebar links must equal viewsFor(user)`);
}

test('all 12 routes × 3 accounts × EN+AR render clean', async () => {
  for (const [name, user] of Object.entries(ACCOUNTS)) {
    globalThis.__setRoutes(mockRoutes(
      name === 'admin'
        ? manifest.sheds.map((s) => s.id)
        : user.warehouseIds
    ));
    App.setUser(user);
    for (const lang of ['ar', 'en']) {
      App.UI.lang = lang;
      globalThis.document.documentElement.lang = lang;
      globalThis.document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      for (const view of ALL_VIEWS) {
        dom.window.location.hash = `#/${view}`;
        await App.route();
        const label = `${name}/${view}/${lang}`;
        assertClean(label);
        assertSidebar(user, label);
      }
    }
  }
});

test('keeper #/settings lands on read-only My Profile', async () => {
  globalThis.__setRoutes(mockRoutes(ACCOUNTS.keeper1.warehouseIds));
  App.setUser(ACCOUNTS.keeper1);
  App.UI.lang = 'ar';
  dom.window.location.hash = '#/settings';
  await App.route();
  const h1 = globalThis.document.querySelector('h1');
  assert.equal(h1.textContent, t('prof.title', null, 'ar'), 'keeper lands on My Profile');
  assertClean('keeper settings→profile');
});

test('accordion state survives a language flip and a re-render', async () => {
  globalThis.__setRoutes(mockRoutes(ACCOUNTS.keeper1.warehouseIds));
  App.setUser(ACCOUNTS.keeper1);
  App.UI.lang = 'ar';
  App.UI.openWh = new Set(['wh-alwa']);
  App.UI.openFabrics = new Set(['wh-alwa:fab-001']);
  dom.window.location.hash = '#/inventory';
  await App.route();
  const openBefore = App.UI.openFabrics;
  assert.ok(globalThis.document.querySelector('table.data'), 'rows render while open');

  await App.setLang('en'); // flips language AND re-renders
  assert.equal(App.UI.openFabrics, openBefore, 'same Set instance survives the flip');
  assert.ok(App.UI.openFabrics.has('wh-alwa:fab-001'), 'open fabric key survives');
  assert.ok(globalThis.document.querySelector('table.data'), 'rows still render after the flip');
  assertClean('inventory after AR→EN flip');

  await App.setLang('ar');
  assert.ok(globalThis.document.querySelector('table.data'), 'rows still render after EN→AR flip');
  assertClean('inventory after EN→AR flip');
});

test('print goes through the server print-sheet endpoint, never window.print()', async () => {
  globalThis.__setRoutes(mockRoutes(manifest.sheds.map((s) => s.id)));
  App.setUser(ACCOUNTS.admin);
  App.UI.lang = 'ar';
  dom.window.location.hash = '#/stock';
  await App.route();
  openCalls.length = 0;
  const printBtn = [...globalThis.document.querySelectorAll('button')]
    .find((b) => b.textContent === t('app.print', null, 'ar'));
  assert.ok(printBtn, 'stock screen has a Print button');
  printBtn.click();
  assert.equal(openCalls.length, 1);
  assert.ok(openCalls[0].startsWith('/api/reports'), 'print targets the server sheet endpoint');
  assert.ok(openCalls[0].includes('format=print'), 'print uses the server print-sheet format');
  assert.equal(App.UI.lastServerSheet, openCalls[0]);
});

test('CSV download calls a server endpoint', async () => {
  globalThis.__setRoutes(mockRoutes(manifest.sheds.map((s) => s.id)));
  App.setUser(ACCOUNTS.admin);
  dom.window.location.hash = '#/reports';
  await App.route();
  openCalls.length = 0;
  const csvBtn = [...globalThis.document.querySelectorAll('button')]
    .find((b) => b.textContent === t('csv.download', null, 'ar'));
  assert.ok(csvBtn);
  csvBtn.click();
  assert.ok(openCalls[0].startsWith('/api/reports') && openCalls[0].includes('format=csv'));
});

test('language toggle sets dir=rtl for Arabic and keeps the choice after reload', async () => {
  App.setUser(ACCOUNTS.keeper1);
  await App.setLang('ar');
  assert.equal(globalThis.document.documentElement.dir, 'rtl');
  assert.equal(globalThis.localStorage.getItem('frs_lang'), 'ar', 'refresh keeps the chosen language');
  await App.setLang('en');
  assert.equal(globalThis.document.documentElement.dir, 'ltr');
  assert.equal(globalThis.localStorage.getItem('frs_lang'), 'en');
});

test('movement form refuses optimistic updates on 409 and shows the server message', async () => {
  globalThis.__setRoutes({
    ...mockRoutes(ACCOUNTS.keeper1.warehouseIds),
    '/api/movements': async () => new Response(JSON.stringify({
      ok: false, error: 'NEGATIVE_STOCK', message: 'Closing would be -3; shortfall 3 roll(s)',
      after: -3, shortfall: 3,
    }), { status: 409 }),
  });
  // Route-level fetch mock: support function handlers too.
  globalThis.__setRoutes(mockRoutes(ACCOUNTS.keeper1.warehouseIds));
  const routesFn = mockRoutes(ACCOUNTS.keeper1.warehouseIds);
  globalThis.fetch = async (url, opts) => {
    const pathname = String(url).split('?')[0];
    if (pathname === '/api/movements' && opts && opts.method === 'POST') {
      return new Response(JSON.stringify({
        ok: false, error: 'NEGATIVE_STOCK', message: 'Closing would be -3; shortfall 3 roll(s)',
        after: -3, shortfall: 3,
      }), { status: 409, headers: { 'content-type': 'application/json' } });
    }
    const hit = routesFn[pathname];
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  App.setUser(ACCOUNTS.keeper1);
  App.UI.lang = 'ar';
  dom.window.location.hash = '#/movements';
  await App.route();
  const form = globalThis.document.querySelector('form.grid');
  assert.ok(form, 'movement form renders');
  form.dispatchEvent(new globalThis.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  const toastEl = globalThis.document.querySelector('#toast-area .toast.error');
  assert.ok(toastEl, 'a toast reports the refusal');
  assert.ok(!toastEl.textContent.includes('{'), 'toast args are interpolated');
  assert.ok(toastEl.textContent.includes('3') || toastEl.textContent.includes('٣'), 'the shortfall is shown');
});

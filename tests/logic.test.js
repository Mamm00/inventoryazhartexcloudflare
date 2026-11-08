// tests/logic.test.js — an independent SQL engine recomputes stock from
// stock_events and compares it to stock_current and the API; per-shed truth
// table from the plan; every number compared to seed_manifest.json with a
// message naming the number to fix. Permissions per scope, CSV specs/escaping/
// formula injection, JSON round-trip, dates, duplicate and invalid rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openLocalD1 } from './_local-d1.js';
import { can, viewsFor, resolveScope, otherKeeperScope, PERMS } from '../shared/permissions.js';
import {
  closingRolls, totalMeters, totalValue, statusOf, reorderQty, utilization,
  fmtNum, fmtMeters, fmtMoney, fmtPct, formatDate, checkNonNegative, computeClosingFromEvents,
} from '../shared/stock-math.js';
import { csvField, csvRow } from '../shared/server/http.js';
import { countRecords, getWarehouseSummary, getStockFromEvents, colorUsageIndex } from '../shared/server/db.js';
import { applyMutation, applyTransfer } from '../shared/ledger-core.js';
import { USERS } from './_harness.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'seed_manifest.json'), 'utf-8'));
const db = openLocalD1();

test('seed counts match seed_manifest.json', async () => {
  const one = async (sql) => db.prepare(sql).first();
  const counts = {
    warehouses: (await one('SELECT COUNT(*) n FROM warehouses')).n,
    fabrics: (await one('SELECT COUNT(*) n FROM fabrics')).n,
    colors: (await one('SELECT COUNT(*) n FROM colors')).n,
    mappings: (await one('SELECT COUNT(*) n FROM mappings')).n,
    inventory_rows: (await one('SELECT COUNT(*) n FROM stock_current')).n,
    movements: (await one('SELECT COUNT(*) n FROM stock_events')).n,
    keeper_codes: (await one('SELECT COUNT(*) n FROM keeper_color_codes')).n,
    users: (await one('SELECT COUNT(*) n FROM users')).n,
  };
  for (const [k, v] of Object.entries(counts)) {
    assert.equal(v, manifest.counts[k], `counts.${k} drifted: manifest says ${manifest.counts[k]}, D1 says ${v}`);
  }
  const records = await countRecords(db);
  assert.equal(records, manifest.counts.records, `counts.records drifted: manifest says ${manifest.counts.records}, D1 says ${records}`);
});

test('colour grade counts and families match the manifest', async () => {
  for (const g of ['A', 'B', 'C', 'D']) {
    const r = await db.prepare(`SELECT COUNT(*) n FROM colors WHERE grade=?`).bind(g).first();
    assert.equal(r.n, manifest.color_grades[g], `color_grades.${g} drifted`);
  }
  const fam = await db.prepare(`SELECT COUNT(DISTINCT family) n FROM colors`).first();
  assert.equal(fam.n, manifest.families, 'families drifted');
});

test('independent SQL engine: opening + Σ event deltas == closing for every row', async () => {
  const drift = await db.prepare(`
    SELECT COUNT(*) n FROM stock_current s
    WHERE s.opening_rolls +
      COALESCE((SELECT SUM(rolls_delta) FROM stock_events e
        WHERE e.warehouse_id=s.warehouse_id AND e.fabric_id=s.fabric_id AND e.color_id=s.color_id), 0)
      <> s.closing_rolls
  `).first();
  assert.equal(drift.n, 0, `${drift.n} stock_current row(s) disagree with the stock_events recompute`);
});

test('rolls truth table: per-shed active rolls equal the manifest', async () => {
  for (const shed of manifest.sheds) {
    const r = await db.prepare(`
      SELECT COALESCE(SUM(s.closing_rolls),0) n FROM stock_current s
      JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
      WHERE s.warehouse_id=? AND m.active=1
    `).bind(shed.id).first();
    assert.equal(r.n, shed.active_rolls, `sheds[${shed.id}].active_rolls drifted: manifest ${shed.active_rolls}, D1 ${r.n}`);
    const s = await getWarehouseSummary(db, shed.id);
    assert.equal(s.rolls, shed.active_rolls, `getWarehouseSummary(${shed.id}).rolls drifted`);
    assert.equal(s.colors, shed.colors_active, `sheds[${shed.id}].colors_active drifted`);
    assert.equal(s.fabric_types, shed.fabrics, `sheds[${shed.id}].fabrics drifted`);
  }
});

test('keeper totals, company total, raw total and the deactivated gap', async () => {
  assert.equal(manifest.rolls.mostafa_active, 51333, 'rolls.mostafa_active drifted');
  assert.equal(manifest.rolls.keeper2_active, 17234, 'rolls.keeper2_active drifted');
  assert.equal(manifest.rolls.company_active, 68567, 'rolls.company_active drifted');
  assert.equal(
    manifest.rolls.mostafa_active + manifest.rolls.keeper2_active,
    manifest.rolls.company_active,
    'keeper totals must sum to the company total'
  );
  // The invalid flag: raw − cards == rolls on deactivated mappings.
  assert.equal(
    manifest.rolls.raw_total - manifest.rolls.company_active,
    manifest.rolls.rolls_on_deactivated ?? manifest.rolls.inactive_rolls,
    'raw_total − company_active must equal inactive_rolls'
  );
  const raw = (await db.prepare('SELECT COALESCE(SUM(closing_rolls),0) n FROM stock_current').first()).n;
  assert.equal(raw, manifest.rolls.raw_total, `rolls.raw_total drifted: manifest ${manifest.rolls.raw_total}, D1 ${raw}`);
});

test('wh-625 scale test numbers', async () => {
  const w = manifest.wh625;
  const fabrics = await db.prepare(`SELECT COUNT(DISTINCT fabric_id) n FROM mappings WHERE warehouse_id='wh-625'`).first();
  const mapped = await db.prepare(`SELECT COUNT(*) n FROM mappings WHERE warehouse_id='wh-625'`).first();
  const active = await db.prepare(`SELECT COUNT(*) n FROM mappings WHERE warehouse_id='wh-625' AND active=1`).first();
  assert.equal(fabrics.n, w.fabrics, 'wh625.fabrics drifted');
  assert.equal(mapped.n, w.mapped_colors, 'wh625.mapped_colors drifted');
  assert.equal(active.n, w.active_colors, 'wh625.active_colors drifted');
  const util = Math.round(w.active_rolls / w.capacity * 1000) / 10;
  assert.equal(util, w.util_pct, 'wh625.util_pct drifted');
  assert.equal(util, 175.2, 'wh-625 utilisation must read 175.2%');
});

test('stock-math formulas', () => {
  assert.equal(closingRolls(10, 5, 3), 12);
  assert.equal(totalMeters(12, 45.5), 546);
  assert.equal(totalValue(12, 100.5), 1206);
  assert.equal(statusOf(0, 5, 20), 'out');
  assert.equal(statusOf(5, 5, 20), 'low');
  assert.equal(statusOf(20, 5, 20), 'over');
  assert.equal(statusOf(10, 5, 20), 'ok');
  assert.equal(reorderQty(3, 10), 7);
  assert.equal(reorderQty(12, 10), 0);
  assert.equal(reorderQty(8, 10.2), 3, 'reorder rounds UP to a whole roll');
  assert.deepEqual(utilization(45, 100), { pct: 45, band: 'green' });
  assert.deepEqual(utilization(60, 100), { pct: 60, band: 'amber' });
  assert.deepEqual(utilization(90, 100), { pct: 90, band: 'red' });
  assert.deepEqual(utilization(175, 100).band, 'red', 'overcapacity stays red and is allowed');
  const chk = checkNonNegative(4, -6);
  assert.equal(chk.ok, false);
  assert.equal(chk.shortfall, 2);
  assert.equal(computeClosingFromEvents(10, [{ rolls_delta: 5 }, { rolls_delta: -2 }]), 13);
});

test('formatters: Intl with manual fallback, dates yyyy-mm-dd, Arabic months', () => {
  assert.equal(fmtNum(68567, 'en'), '68,567');
  assert.ok(fmtMeters(1234.5, 'en').endsWith(' m'));
  assert.ok(fmtMeters(1234.5, 'ar').endsWith(' م'));
  assert.ok(fmtMoney(2500, 'en').includes('EGP'));
  assert.ok(fmtMoney(2500, 'ar').includes('ج.م'));
  assert.equal(fmtPct(175.166, 'en'), '175.2%');
  assert.equal(formatDate('2026-11-08', 'en'), '8 Nov 2026');
  assert.equal(formatDate('2026-11-08', 'ar'), '٨ نوفمبر ٢٠٢٦');
});

test('permissions per scope', () => {
  assert.equal(can(USERS.admin, 'settings.write', 'wh-625'), true);
  assert.equal(can(USERS.keeper1, 'inventory.write', 'wh-alwa'), true);
  assert.equal(can(USERS.keeper1, 'inventory.write', 'wh-625'), false, 'keeper1 cannot write colleague sheds');
  assert.equal(can(USERS.keeper1, 'color.delete', 'wh-alwa'), false, 'colour delete is Admin-only');
  assert.equal(can(USERS.keeper1, 'color.add', 'wh-alwa'), true);
  assert.equal(can(USERS.keeper1, 'settings.write', null), false, 'keepers never see Settings');
  assert.equal(can(USERS.keeper1, 'movement.create', 'wh-showroom'), true);
  assert.equal(can(USERS.keeper1, 'transfer.receive', 'wh-625'), true, 'destination-only action is unscoped');
  const legacy = { id: 'u-old', role: 'SalesManager', warehouseIds: ['wh-alwa'] };
  assert.equal(can(legacy, 'inventory.write', 'wh-alwa'), false, 'SalesManager restores read-only');
  assert.equal(can(legacy, 'movement.create', 'wh-alwa'), false);
  assert.ok(viewsFor(USERS.admin).includes('settings'));
  assert.ok(!viewsFor(USERS.keeper1).includes('settings'), 'keeper sidebar has no Settings');
  assert.ok(viewsFor(USERS.keeper1).includes('profile'));
  assert.equal(resolveScope(USERS.admin, ['a', 'b']).length, 2);
  assert.deepEqual(resolveScope(USERS.keeper1, ['wh-alwa', 'wh-625']), ['wh-alwa']);
  const other = otherKeeperScope(USERS.keeper1, [{ id: 'wh-alwa' }, { id: 'wh-625' }]);
  assert.deepEqual(other, ['wh-625']);
});

test('PERMS is the single source of truth for the role matrix', () => {
  assert.deepEqual(Object.keys(PERMS).sort(), [
    'color.add', 'color.delete', 'fabric.edit', 'inventory.write',
    'keepercode.write', 'movement.create', 'settings.write',
  ]);
});

test('CSV escaping and formula injection', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('=cmd|calc'), "'=cmd|calc", 'formula injection neutralised');
  assert.equal(csvField('+1234'), "'+1234");
  assert.equal(csvField('-danger'), "'-danger");
  assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvRow(['a', 'b']), 'a,b');
  const ar = csvField('أزرق ملكي');
  assert.equal(ar, 'أزرق ملكي', 'Arabic passes through untouched');
});

test('JSON round-trip of a report payload', () => {
  const payload = { title: 'تقرير', rows: [['wh-alwa', 13456]], nested: { ar: 'الزبدة' } };
  const back = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(back, payload);
});

test('duplicate mapping is refused by the D1 unique constraint', async () => {
  const existing = await db.prepare(
    `SELECT warehouse_id, fabric_id, color_id FROM mappings LIMIT 1`
  ).first();
  await assert.rejects(
    db.prepare(
      `INSERT INTO mappings (id, warehouse_id, fabric_id, color_id, min_rolls, max_rolls, lead_time_days, active)
       VALUES ('map-dup-test', ?, ?, ?, 0, 0, 0, 1)`
    ).bind(existing.warehouse_id, existing.fabric_id, existing.color_id).run(),
    /UNIQUE|constraint/i
  );
});

test('invalid combination: applyMutation refuses unmapped rows (422) and clip-free negative stock', async () => {
  const env = { DB: db, AUDIT_QUEUE: { sent: [], async send(m) { this.sent.push(m); } } };
  const actor = { id: 'u-keeper1' };
  const unmapped = await applyMutation(env, {
    kind: 'in', warehouseId: 'wh-alwa', fabricId: 'fab-001', color_id: undefined,
    colorId: 'col-black-09', rollsDelta: 1, actor,
  });
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.error, 'UNMAPPED');

  // Find a real low-stock row to prove the shortfall message is not clipped.
  const row = await db.prepare(`
    SELECT s.warehouse_id, s.fabric_id, s.color_id, s.closing_rolls FROM stock_current s
    JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
    WHERE m.active=1 ORDER BY s.closing_rolls LIMIT 1
  `).first();
  const res = await applyMutation(env, {
    kind: 'out', warehouseId: row.warehouse_id, fabricId: row.fabric_id, colorId: row.color_id,
    rollsDelta: -(row.closing_rolls + 5), actor,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NEGATIVE_STOCK');
  assert.equal(res.shortfall, 5, 'the shortfall is named, never clipped');
  assert.equal(res.after, -5);
});

test('getStockFromEvents equals the hot path everywhere (spot 25 combos)', async () => {
  const combos = (await db.prepare(
    `SELECT warehouse_id, fabric_id, color_id, closing_rolls FROM stock_current ORDER BY warehouse_id LIMIT 25`
  ).all()).results;
  for (const c of combos) {
    const fromEvents = await getStockFromEvents(db, c.warehouse_id, c.fabric_id, c.color_id);
    assert.equal(fromEvents, c.closing_rolls,
      `getStock drifted for ${c.warehouse_id}/${c.fabric_id}/${c.color_id}`);
  }
});

test('transfer keeps the company total unchanged', async () => {
  const env = { DB: db, AUDIT_QUEUE: { sent: [], async send(m) { this.sent.push(m); } } };
  const shared = await db.prepare(`
    SELECT m1.warehouse_id AS w1, m2.warehouse_id AS w2, m1.fabric_id, m1.color_id
    FROM mappings m1 JOIN mappings m2
      ON m1.fabric_id=m2.fabric_id AND m1.color_id=m2.color_id AND m1.warehouse_id < m2.warehouse_id
    WHERE m1.active=1 AND m2.active=1 LIMIT 1
  `).first();
  const sumBefore = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  const res = await applyTransfer(env, {
    fromWarehouseId: shared.w1, toWarehouseId: shared.w2,
    fabricId: shared.fabric_id, colorId: shared.color_id,
    rolls: 2, actor: { id: 'u-admin' },
  });
  assert.equal(res.ok, true);
  const sumAfter = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  assert.equal(sumAfter, sumBefore, 'company total unchanged by a transfer');
});

test('colorUsageIndex counts unique (colour, shed) pairs over ALL mappings, inactive included', async () => {
  const usage = await colorUsageIndex(db);
  const totalPairs = [...usage.values()].reduce((a, v) => a + v.length, 0);
  const distinct = (await db.prepare(
    'SELECT COUNT(*) n FROM (SELECT DISTINCT color_id, warehouse_id FROM mappings)'
  ).first()).n;
  assert.equal(totalPairs, distinct, 'usage index = unique (colour, shed) pairs');
  const mapped = (await db.prepare('SELECT COUNT(*) n FROM mappings').first()).n;
  assert.ok(totalPairs <= mapped, 'pairs cannot exceed mapping rows');
  // Inactive rows count too: find one and confirm its pair is present.
  const inactive = await db.prepare(`
    SELECT warehouse_id, color_id FROM mappings WHERE active=0 LIMIT 1
  `).first();
  assert.ok(usage.get(inactive.color_id)?.includes(inactive.warehouse_id),
    'usage pairs must cover inactive mapping rows too');
});

test('stockAsOf restricts to rows dated ≤ the given date', async () => {
  const row = await db.prepare(`
    SELECT warehouse_id, fabric_id, color_id FROM stock_events ORDER BY effective_date DESC LIMIT 1
  `).first();
  const { stockAsOf } = await import('../shared/server/db.js');
  const s = await db.prepare(`SELECT * FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`)
    .bind(row.warehouse_id, row.fabric_id, row.color_id).first();
  // All seeded events postdate 2026-01-01, so as-of then is exactly the opening.
  const at1 = await stockAsOf(db, row.warehouse_id, row.fabric_id, row.color_id, '2026-01-01');
  assert.equal(at1, s.opening_rolls, 'as-of before all events equals the opening balance');
  const at2 = await stockAsOf(db, row.warehouse_id, row.fabric_id, row.color_id, '2027-01-01');
  assert.equal(at2, s.closing_rolls, 'as-of far future equals closing');
});

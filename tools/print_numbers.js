#!/usr/bin/env node
// tools/print_numbers.js — opens the local D1 (migrations + seed) and prints
// every headline number via SQL. Rule 4: no number is invented; each is a
// query result. Run by tools/check.sh and quoted by docs via seed_manifest.json.

import { openLocalD1 } from '../tests/_local-d1.js';
import { countRecords, getWarehouseSummary } from '../shared/server/db.js';

const db = openLocalD1();
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
counts.records = await countRecords(db);

const grades = {};
for (const g of ['A', 'B', 'C', 'D']) {
  grades[g] = (await one(`SELECT COUNT(*) n FROM colors WHERE grade='${g}'`)).n;
}

const companyActive = (await one(
  `SELECT COALESCE(SUM(s.closing_rolls),0) n FROM stock_current s
   JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
   WHERE m.active=1`
)).n;
const rawTotal = (await one('SELECT COALESCE(SUM(closing_rolls),0) n FROM stock_current')).n;
const inactive = await one(
  `SELECT COUNT(*) rows_n, COALESCE(SUM(s.closing_rolls),0) rolls_n FROM stock_current s
   JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
   WHERE m.active=0`
);
const mostafa = (await one(
  `SELECT COALESCE(SUM(s.closing_rolls),0) n FROM stock_current s
   JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
   JOIN warehouses w ON w.id=s.warehouse_id
   WHERE m.active=1 AND w.keeper_user_id='u-keeper1'`
)).n;
const keeper2 = companyActive - mostafa;

// Independent recompute: opening + in − out == closing, and opening + Σ events == closing.
const drift = (await one(
  `SELECT COUNT(*) n FROM stock_current s WHERE s.opening_rolls + s.rolls_in - s.rolls_out <> s.closing_rolls`
)).n;
const eventDrift = (await one(
  `SELECT COUNT(*) n FROM (
     SELECT s.warehouse_id, s.fabric_id, s.color_id,
            s.opening_rolls + COALESCE((SELECT SUM(rolls_delta) FROM stock_events e
              WHERE e.warehouse_id=s.warehouse_id AND e.fabric_id=s.fabric_id AND e.color_id=s.color_id),0) AS recomputed,
            s.closing_rolls AS closing
     FROM stock_current s) r
   WHERE r.recomputed <> r.closing`
)).n;

const w625 = await one(
  `SELECT
     (SELECT COUNT(DISTINCT fabric_id) FROM mappings WHERE warehouse_id='wh-625') AS fabrics,
     (SELECT COUNT(*) FROM mappings WHERE warehouse_id='wh-625') AS mapped,
     (SELECT COUNT(*) FROM mappings WHERE warehouse_id='wh-625' AND active=1) AS active_mapped,
     (SELECT COALESCE(SUM(s.closing_rolls),0) FROM stock_current s
       JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
       WHERE s.warehouse_id='wh-625' AND m.active=1) AS active_rolls,
     (SELECT capacity_rolls FROM warehouses WHERE id='wh-625') AS capacity`
);
w625.util_pct = Math.round((w625.active_rolls / w625.capacity) * 1000) / 10;

console.log('== SQL-derived numbers (local D1) ==');
console.log('counts:', JSON.stringify(counts));
console.log('color_grades:', JSON.stringify(grades));
console.log('rolls:', JSON.stringify({
  mostafa_active: mostafa, keeper2_active: keeper2, company_active: companyActive,
  raw_total: rawTotal, inactive_mapping_rows: inactive.rows_n, inactive_rolls: inactive.rolls_n,
}));
console.log('wh-625:', JSON.stringify(w625));
console.log('consistency: opening+in-out≠closing rows =', drift, '| events recompute drift rows =', eventDrift);

console.log('per-shed summaries:');
for (const w of (await db.prepare('SELECT id FROM warehouses ORDER BY id').all()).results) {
  const s = await getWarehouseSummary(db, w.id);
  console.log(`  ${s.id.padEnd(12)} fabrics=${String(s.fabric_types).padEnd(3)} colors=${String(s.colors).padEnd(4)} rolls=${String(s.rolls).padEnd(6)} low=${String(s.low_stock).padEnd(3)} util=${s.utilization_pct.toFixed(1)}% [${s.utilization_band}]`);
}

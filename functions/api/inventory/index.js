// GET /api/inventory?wh=&fab= — accordion tree: Warehouse → fabric type →
// colour rows. Rows include closing, metres, value, status. getFabricTypeSummary()
// feeds the fabric level. A combination without an active mapping is flagged.

import { json } from '../../../shared/server/http.js';
import {
  listWarehouses, listFabrics, getFabricTypeSummary, listInventoryRows,
} from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';
import { statusOf, totalMeters, totalValue, reorderQty, STATUS_KEYS } from '../../../shared/stock-math.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const url = new URL(request.url);
  const wh = url.searchParams.get('wh');
  const fab = url.searchParams.get('fab');

  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);

  if (wh && !scope.includes(wh)) {
    return json({ error: 'FORBIDDEN', message: 'Not allowed for your role' }, 403);
  }

  // Tree level: sheds in scope with their fabric-type summaries.
  const tree = [];
  for (const id of wh ? [wh] : scope) {
    const w = await env.DB.prepare(`SELECT * FROM warehouses WHERE id=?`).bind(id).first();
    const fabrics = await env.DB.prepare(
      `SELECT DISTINCT fabric_id FROM mappings WHERE warehouse_id=? ORDER BY fabric_id`
    ).bind(id).all();
    const fsums = [];
    for (const f of fabrics.results) {
      fsums.push(await getFabricTypeSummary(env.DB, id, f.fabric_id));
    }
    tree.push({ warehouse: w, fabrics: fsums });
  }

  let rows = [];
  if (wh) {
    rows = (await listInventoryRows(env.DB, wh, fab)).map((r) => {
      const st = statusOf(r.closing_rolls, r.min_rolls, r.max_rolls);
      return {
        mapping_id: r.mapping_id,
        warehouse_id: r.warehouse_id, fabric_id: r.fabric_id, color_id: r.color_id,
        fab_name_ar: r.fab_name_ar, fab_name_en: r.fab_name_en,
        col_name_ar: r.col_name_ar, col_name_en: r.col_name_en,
        hex: r.hex, family: r.family, grade: r.grade,
        meters_per_roll: r.meters_per_roll, unit_cost_per_roll: r.unit_cost_per_roll,
        opening_rolls: r.opening_rolls, rolls_in: r.rolls_in, rolls_out: r.rolls_out,
        closing_rolls: r.closing_rolls,
        meters: totalMeters(r.closing_rolls, r.meters_per_roll),
        value: totalValue(r.closing_rolls, r.unit_cost_per_roll),
        status: st, status_key: STATUS_KEYS[st],
        min_rolls: r.min_rolls, max_rolls: r.max_rolls, lead_time_days: r.lead_time_days,
        reorder: reorderQty(r.closing_rolls, r.min_rolls),
        mapping_active: r.active === 1,
        valid: r.active === 1,
      };
    });
  }

  return json({ tree, rows, scope });
}

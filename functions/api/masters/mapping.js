// GET/POST/PATCH /api/masters/mapping — the join table. Duplicate
// (warehouse, fabric, colour) is refused by the D1 unique constraint; an
// unmapped active row is flagged and listed by diagnostics. Deactivation is
// the keeper-friendly alternative to deletion.

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listMappings } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  return json({ rows: await listMappings(context.env.DB) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await readBody(request);
  return guard(context, 'inventory.write', body.warehouse_id, async () => {
    const id = body.id || `map-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await env.DB.prepare(
        `INSERT INTO mappings (id, warehouse_id, fabric_id, color_id, min_rolls, max_rolls, lead_time_days, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).bind(id, body.warehouse_id, body.fabric_id, body.color_id,
        Number(body.min_rolls) || 0, Number(body.max_rolls) || 0, Number(body.lead_time_days) || 0).run();
    } catch (err) {
      // UNIQUE (warehouse_id, fabric_id, color_id) — duplicate refused.
      return json({ ok: false, error: 'DUPLICATE', message: 'Duplicate mapping is refused by the unique constraint' }, 409);
    }
    // Ensure a stock_current row exists for the new combination.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO stock_current (warehouse_id, fabric_id, color_id, opening_rolls, rolls_in, rolls_out, closing_rolls)
       VALUES (?, ?, ?, 0, 0, 0, 0)`
    ).bind(body.warehouse_id, body.fabric_id, body.color_id).run();
    return json({ ok: true, id }, 201);
  });
}

export async function onRequestPatch(context) {
  const { env, request } = context;
  const body = await readBody(request);
  return guard(context, 'inventory.write', body.warehouse_id, async () => {
    await env.DB.prepare(
      `UPDATE mappings SET min_rolls=?, max_rolls=?, lead_time_days=?, active=? WHERE id=?`
    ).bind(Number(body.min_rolls) || 0, Number(body.max_rolls) || 0,
      Number(body.lead_time_days) || 0, body.active === false ? 0 : 1, body.id).run();
    return json({ ok: true });
  });
}

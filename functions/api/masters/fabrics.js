// GET/POST/PATCH /api/masters/fabrics — keeper may add and edit (fabric.edit);
// deletion is Admin-only.

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listFabrics } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  return json({ rows: await listFabrics(context.env.DB) });
}

export async function onRequestPost(context) {
  return guard(context, 'fabric.edit', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    const id = body.id || `fab-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO fabrics (id, name_ar, name_en, meters_per_roll, unit_cost_per_roll, active) VALUES (?, ?, ?, ?, ?, 1)`
    ).bind(id, body.name_ar, body.name_en ?? null, Number(body.meters_per_roll) || 0,
      Number(body.unit_cost_per_roll) || 0).run();
    return json({ ok: true, id }, 201);
  });
}

export async function onRequestPatch(context) {
  return guard(context, 'fabric.edit', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    await env.DB.prepare(
      `UPDATE fabrics SET name_ar=?, name_en=?, meters_per_roll=?, unit_cost_per_roll=?, active=? WHERE id=?`
    ).bind(body.name_ar, body.name_en ?? null, Number(body.meters_per_roll) || 0,
      Number(body.unit_cost_per_roll) || 0, body.active === false ? 0 : 1, body.id).run();
    return json({ ok: true });
  });
}

export async function onRequestDelete(context) {
  // Deleting catalogue rows is Admin-only.
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    await env.DB.prepare(`UPDATE fabrics SET active=0 WHERE id=?`).bind(body.id).run();
    return json({ ok: true });
  });
}

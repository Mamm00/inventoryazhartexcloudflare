// GET /api/masters/warehouses — admin write; keeper read.
// Masters deletion is Admin-only (guard 'settings.write' for structural edits).

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listAllWarehouses, getWarehouseSummary } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  const { env } = context;
  const rows = await listAllWarehouses(env.DB);
  const out = [];
  for (const w of rows) {
    const s = await getWarehouseSummary(env.DB, w.id);
    out.push({ ...w, summary: s });
  }
  return json({ rows: out });
}

export async function onRequestPatch(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    await env.DB.prepare(
      `UPDATE warehouses SET name_ar=?, name_en=?, allowed_grades=?, grade_label_ar=?, capacity_rolls=?, active=? WHERE id=?`
    ).bind(body.name_ar, body.name_en, body.allowed_grades, body.grade_label_ar,
      body.capacity_rolls ?? 0, body.active === false ? 0 : 1, body.id).run();
    return json({ ok: true });
  });
}

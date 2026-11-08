// GET/POST/DELETE /api/masters/colors — colours tab of Masters.
// Keeper may add; deleting catalogue rows is Admin-only; re-grade Admin-only.

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listColors, colorUsageIndex } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  const colors = await listColors(context.env.DB);
  const usage = await colorUsageIndex(context.env.DB);
  return json({
    rows: colors.map((c) => ({ ...c, usage_count: (usage.get(c.id) || []).length })),
  });
}

export async function onRequestPost(context) {
  return guard(context, 'color.add', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    const id = body.id || `col-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO colors (id, name_ar, name_en, hex, family, grade, active) VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).bind(id, body.name_ar, body.name_en ?? null, body.hex ?? null, body.family ?? 'misc', body.grade ?? 'A').run();
    return json({ ok: true, id }, 201);
  });
}

export async function onRequestDelete(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    await env.DB.prepare(`UPDATE colors SET active=0 WHERE id=?`).bind(body.id).run();
    return json({ ok: true });
  });
}

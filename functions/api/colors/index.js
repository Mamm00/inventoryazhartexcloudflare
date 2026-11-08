// GET /api/colors — shared catalogue (grid/table data) + usage counts.
// POST /api/colors — keeper may add (shared masters: add yes, delete/re-grade no).

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listColors, colorUsageIndex, listKeeperCodes } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const colors = await listColors(env.DB);
  const usage = await colorUsageIndex(env.DB);
  // Keeper codes: only the signed-in keeper's rows unless the user is Admin.
  const codes = await listKeeperCodes(env.DB, user.role === 'Admin' ? null : user.id);
  return json({
    colors: colors.map((c) => ({
      ...c,
      sheds: usage.get(c.id) || [],
      usage_count: (usage.get(c.id) || []).length,
    })),
    codes,
  });
}

export async function onRequestPost(context) {
  return guard(context, 'color.add', null, async () => {
    const { env, request } = context;
    const body = await readBody(request);
    const id = body.id || `col-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO colors (id, name_ar, name_en, hex, family, grade, active) VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).bind(id, body.name_ar ?? body.nameAr ?? '', body.name_en ?? body.nameEn ?? null,
      body.hex ?? null, body.family ?? 'misc', body.grade ?? 'A').run();
    return json({ ok: true, id }, 201);
  });
}

// GET /api/colors/codes — the keeper's own labels only (Admin sees all).
// POST — upsert a keeper code (keepercode.write). Resolution order for reads
// elsewhere: exact customCode, then case-insensitive customName, own rows only.

import { json, readBody, guard } from '../../../shared/server/http.js';
import { listKeeperCodes } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const codes = await listKeeperCodes(env.DB, user.role === 'Admin' ? null : user.id);
  return json({ codes, scope: user.role === 'Admin' ? 'all' : 'own' });
}

export async function onRequestPost(context) {
  return guard(context, 'keepercode.write', null, async () => {
    const { env, request } = context;
  const user = context.data?.user ?? context.user;
    const body = await readBody(request);
    const keeper = body.keeperUserId && user.role === 'Admin' ? body.keeperUserId : user.id;
    const existing = await env.DB.prepare(
      `SELECT id FROM keeper_color_codes WHERE keeper_user_id=? AND color_id=?`
    ).bind(keeper, body.colorId).first();
    const now = new Date().toISOString().slice(0, 10);
    if (existing) {
      await env.DB.prepare(
        `UPDATE keeper_color_codes SET custom_code=?, custom_name=?, notes=?, last_updated=? WHERE id=?`
      ).bind(body.customCode ?? null, body.customName ?? null, body.notes ?? null, now, existing.id).run();
      return json({ ok: true, id: existing.id, updated: true });
    }
    const id = `kcode-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO keeper_color_codes (id, keeper_user_id, color_id, custom_code, custom_name, notes, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, keeper, body.colorId, body.customCode ?? null, body.customName ?? null, body.notes ?? null, now).run();
    return json({ ok: true, id, updated: false }, 201);
  });
}

// DELETE /api/colors/:id — Admin only (403 for keepers, audited as Blocked).
// An in-use colour is refused with 409 and a Deactivate suggestion.
// PATCH — re-grade: Admin only.

import { json, readBody, guard } from '../../../shared/server/http.js';
import { colorUsageIndex } from '../../../shared/server/db.js';

export async function onRequestDelete(context) {
  const { env, params } = context;
  return guard(context, 'color.delete', null, async () => {
    const usage = await colorUsageIndex(env.DB);
    const sheds = usage.get(params.id) || [];
    if (sheds.length > 0) {
      return json({
        ok: false, error: 'IN_USE',
        message: `Colour is in use in ${sheds.length} shed(s) — deactivate it instead`,
        suggestion: 'deactivate',
      }, 409);
    }
    await env.DB.prepare(`UPDATE colors SET active=0 WHERE id=?`).bind(params.id).run();
    await env.DB.prepare(`DELETE FROM colors WHERE id=?`).bind(params.id).run();
    return json({ ok: true });
  });
}

export async function onRequestPatch(context) {
  const { env, params, request } = context;
  const user = context.data?.user ?? context.user;
  // Re-grading shared masters is Admin-only (keep the action name explicit).
  return guard(context, 'color.delete', null, async () => {
    const body = await readBody(request);
    if (body.grade) {
      await env.DB.prepare(`UPDATE colors SET grade=? WHERE id=?`).bind(body.grade, params.id).run();
    }
    if (body.active !== undefined) {
      await env.DB.prepare(`UPDATE colors SET active=? WHERE id=?`).bind(body.active ? 1 : 0, params.id).run();
    }
    return json({ ok: true });
  });
}

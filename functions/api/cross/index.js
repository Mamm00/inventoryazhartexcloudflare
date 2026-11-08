// GET /api/cross — Cross-View: the OTHER keeper's sheds, same card shape,
// readOnly: true. There are no POST/PATCH/DELETE handlers under /api/cross —
// a UI-level attempt to write is rejected by can() and audited as Blocked.

import { json } from '../../../shared/server/http.js';
import { listWarehouses, listAllWarehouses, getWarehouseSummary, getUser } from '../../../shared/server/db.js';
import { resolveScope, otherKeeperScope } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);
  const other = otherKeeperScope(user, await listAllWarehouses(env.DB));
  const sheds = [];
  for (const id of other) {
    sheds.push(await getWarehouseSummary(env.DB, id));
  }
  // Whose sheds these are — the banner names them.
  let owner = null;
  if (sheds.length > 0) {
    const u = await getUser(env.DB, sheds[0].keeper_user_id);
    owner = u ? { id: u.id, username: u.username, display_name_ar: u.display_name_ar, display_name_en: u.display_name_en } : null;
  }
  return json({ sheds, owner, readOnly: true, scope });
}

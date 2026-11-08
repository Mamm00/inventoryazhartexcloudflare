// GET /api/auth/me — current user + resolved scope.

import { json } from '../../../shared/server/http.js';
import { listWarehouses } from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  return json({
    user: {
      id: user.id, username: user.username, role: user.role,
      warehouseIds: user.warehouseIds,
      displayNameAr: user.displayNameAr, displayNameEn: user.displayNameEn,
    },
    scope: resolveScope(user, all),
  });
}

// GET /api/profile — My Profile (keepers): their scope, their codes, read-only.

import { json } from '../../../shared/server/http.js';
import { listWarehouses, listKeeperCodes, getWarehouse } from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);
  const sheds = [];
  for (const id of scope) {
    const w = await getWarehouse(env.DB, id);
    if (w) sheds.push({ id: w.id, name_ar: w.name_ar, name_en: w.name_en, allowed_grades: w.allowed_grades, grade_label_ar: w.grade_label_ar });
  }
  const codes = await listKeeperCodes(env.DB, user.role === 'Admin' ? null : user.id);
  return json({
    user: {
      id: user.id, username: user.username, role: user.role,
      displayNameAr: user.displayNameAr, displayNameEn: user.displayNameEn,
    },
    sheds, codes, readOnly: true,
  });
}

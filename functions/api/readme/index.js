// GET /api/readme — Guide screen data: version, storage mode, record count,
// security note, how-to steps, colour legend, live role matrix read out of
// PERMS, formula table, data-model table, deploy steps, troubleshooting,
// change log, and a shed map generated per account (admin sees ten rows +
// company total; Mostafa sees five rows + his total).

import { json } from '../../../shared/server/http.js';
import { countRecords, getWarehouseSummary, listWarehouses, getWarehouse } from '../../../shared/server/db.js';
import { PERMS, viewsFor, resolveScope, ROLES } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);

  const shedMap = [];
  let total = 0;
  for (const id of scope) {
    const s = await getWarehouseSummary(env.DB, id);
    shedMap.push(s);
    total += s.rolls;
  }

  const version = (await env.DB.prepare(`SELECT value FROM settings WHERE key='guide_version'`).first())?.value ?? '1.2.0';
  const storageMode = (await env.DB.prepare(`SELECT value FROM settings WHERE key='storage_mode'`).first())?.value ?? 'cloudflare-d1';

  return json({
    version,
    storageMode,
    recordCount: await countRecords(env.DB),
    roleMatrix: { actions: Object.keys(PERMS), perms: PERMS, roles: ROLES },
    views: viewsFor(user),
    shedMap,
    shedMapTotal: total,
    scopeIsAll: user.role === 'Admin',
    steps: ['rd.step1', 'rd.step2', 'rd.step3', 'rd.step4', 'rd.step5', 'rd.step6', 'rd.step7', 'rd.step8'],
  });
}

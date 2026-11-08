// GET /api/stock — Stock Overview: one summary per shed in scope + header
// totals. getWarehouseSummary() per shed; ETag cache.

import { json } from '../../../shared/server/http.js';
import { listWarehouses, getWarehouseSummary } from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);
  const sheds = [];
  for (const id of scope) {
    sheds.push(await getWarehouseSummary(env.DB, id));
  }
  const totals = sheds.reduce((acc, s) => ({
    fabric_types: acc.fabric_types, // de-duped below
    rolls: acc.rolls + s.rolls,
    meters: acc.meters + s.meters,
    value: acc.value + s.value,
    low_stock: acc.low_stock + s.low_stock,
  }), { fabric_types: 0, rolls: 0, meters: 0, value: 0, low_stock: 0 });
  const fabSet = new Set();
  for (const id of scope) {
    for (const r of (await env.DB.prepare(`SELECT DISTINCT fabric_id FROM mappings WHERE warehouse_id=? AND active=1`).bind(id).all()).results) {
      fabSet.add(r.fabric_id);
    }
  }
  totals.fabric_types = fabSet.size;
  totals.shed_count = sheds.length;

  const payload = JSON.stringify({ sheds, totals, scope });
  const etag = `W/"${await sha1(payload)}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', etag, 'cache-control': 'private, max-age=30' },
  });
}

async function sha1(s) {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GET /api/dashboard — live KPIs, rolls-by-shed, fabric mix, grade donut,
// stock trend (day/week/month), top movers, "Reorder now" — all filtered by
// scope. Numbers are query-derived; Workers AI is never authoritative here.

import { json } from '../../../shared/server/http.js';
import {
  getWarehouseSummary, gradeMix, fabricMix, topMovers, reorderList, listWarehouses,
} from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';
import { totalMeters, totalValue, reorderQty } from '../../../shared/stock-math.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const url = new URL(request.url);
  const granularity = url.searchParams.get('trend') || 'week';

  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);
  const bindList = scope.length ? scope : ['__none__'];
  const inScope = scope.length
    ? `IN (${bindList.map(() => '?').join(',')})`
    : `IN ('__none__')`;

  const sheds = [];
  for (const id of scope) sheds.push(await getWarehouseSummary(env.DB, id));
  const kpis = sheds.reduce((a, s) => ({
    rolls: a.rolls + s.rolls, meters: a.meters + s.meters,
    value: a.value + s.value, low: a.low + s.low_stock,
  }), { rolls: 0, meters: 0, value: 0, low: 0 });

  const grades = await gradeMix(env.DB, scope);
  const mix = await fabricMix(env.DB, scope);
  const movers = await topMovers(env.DB, scope, 8);
  const reorder = (await reorderList(env.DB, scope, 20)).map((r) => ({
    ...r,
    reorder_qty: reorderQty(r.closing_rolls, r.min_rolls),
  }));

  // Trend: net rolls per bucket over effective_date, plus running closing.
  const fmt = granularity === 'day' ? '%Y-%m-%d' : granularity === 'month' ? '%Y-%m' : '%Y-W%W';
  const trendRows = (await env.DB.prepare(
    `SELECT strftime('${fmt}', effective_date) AS bucket, SUM(rolls_delta) AS net
     FROM stock_events WHERE warehouse_id ${inScope}
     GROUP BY bucket ORDER BY bucket`
  ).bind(...bindList).all()).results;
  let running = kpis.rolls;
  const rev = trendRows.slice().reverse();
  const trend = rev.map((r) => {
    const point = { bucket: r.bucket, closing: running };
    running -= r.net;
    return point;
  }).reverse();

  return json({
    kpis: {
      rolls: kpis.rolls,
      meters: kpis.meters,
      value: kpis.value,
      low: kpis.low,
    },
    byShed: sheds.map((s) => ({ id: s.id, name_ar: s.name_ar, name_en: s.name_en, rolls: s.rolls })),
    mix, grades, trend, topMovers: movers, reorder,
    scope,
  });
}

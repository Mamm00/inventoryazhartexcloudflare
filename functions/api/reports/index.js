// GET /api/reports?kind=byWarehouse|byFabric|byGrade|byDate&from=&to=&format=
// One builder, four kinds — feeding the screen table, the CSV and the print
// sheet on the company letterhead. CSV escapes formula injection; the print
// sheet is generated server-side (the client opens the returned URL; shared
// helpers never call window.print()).

import { json, csv, csvRow, guard } from '../../../shared/server/http.js';
import {
  listWarehouses, listFabrics, listInventoryRows, listEvents, getWarehouse,
} from '../../../shared/server/db.js';
import { resolveScope } from '../../../shared/permissions.js';
import { totalMeters, totalValue, statusOf, STATUS_KEYS, fmtMeters, fmtMoney, formatDate } from '../../../shared/stock-math.js';
import { t, nm } from '../../../shared/i18n.js';

const KINDS = ['byWarehouse', 'byFabric', 'byGrade', 'byDate', 'colors', 'keeperCodes'];

export async function onRequestGet(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'byWarehouse';
  const from = url.searchParams.get('from') || '0000-01-01';
  const to = url.searchParams.get('to') || '9999-12-31';
  const format = url.searchParams.get('format') || 'json';
  const lang = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';

  if (!KINDS.includes(kind)) return json({ error: 'BAD_KIND' }, 400);

  const all = (await listWarehouses(env.DB)).map((w) => w.id);
  const scope = resolveScope(user, all);
  const report = await buildReport(env, kind, scope, from, to, user);

  if (format === 'csv') {
    if (kind === 'keeperCodes' && user.role !== 'Admin') {
      return json({ error: 'FORBIDDEN' }, 403);
    }
    const lines = [csvRow(report.columns)];
    for (const row of report.rows) lines.push(csvRow(row));
    return csv(lines.join('\r\n'), `${kind}-${from}-${to}.csv`);
  }
  if (format === 'pdf' || format === 'print') {
    const html = printSheet(report, lang, user, from, to);
    if (format === 'pdf' && env.BROWSER && typeof env.BROWSER.pdf === 'function') {
      // Browser Rendering: PDF of the same Arabic RTL letterhead HTML.
      const pdf = await env.BROWSER.pdf(html);
      return new Response(pdf, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' },
      });
    }
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-print-sheet': 'server-generated' },
    });
  }
  return json({ ...report, from, to, kind });
}

async function buildReport(env, kind, scope, from, to, user) {
  const stamp = new Date().toISOString();
  if (kind === 'byWarehouse') {
    const columns = ['warehouse', 'fabric_types', 'colors', 'rolls', 'meters', 'value'];
    const rows = [];
    for (const id of scope) {
      const w = await getWarehouse(env.DB, id);
      let rolls = 0, meters = 0, value = 0, colors = 0;
      const fabs = new Set();
      for (const r of (await listInventoryRows(env.DB, id))) {
        if (r.active !== 1) continue;
        rolls += r.closing_rolls;
        meters += totalMeters(r.closing_rolls, r.meters_per_roll);
        value += totalValue(r.closing_rolls, r.unit_cost_per_roll);
        colors += 1;
        fabs.add(r.fabric_id);
      }
      rows.push([w.name_ar || w.name_en, fabs.size, colors, rolls, meters.toFixed(2), value.toFixed(2)]);
    }
    return { title: t('rep.byWarehouse'), columns, rows, generated: stamp };
  }
  if (kind === 'byFabric') {
    const columns = ['fabric', 'warehouses', 'rolls', 'meters', 'value'];
    const agg = new Map();
    for (const id of scope) {
      for (const r of (await listInventoryRows(env.DB, id))) {
        if (r.active !== 1) continue;
        const key = r.fabric_id;
        if (!agg.has(key)) agg.set(key, { name: r.fab_name_ar || r.fab_name_en, whs: new Set(), rolls: 0, meters: 0, value: 0 });
        const a = agg.get(key);
        a.whs.add(id);
        a.rolls += r.closing_rolls;
        a.meters += totalMeters(r.closing_rolls, r.meters_per_roll);
        a.value += totalValue(r.closing_rolls, r.unit_cost_per_roll);
      }
    }
    const rows = [...agg.entries()].map(([, a]) => [a.name, a.whs.size, a.rolls, a.meters.toFixed(2), a.value.toFixed(2)]);
    rows.sort((x, y) => y[2] - x[2]);
    return { title: t('rep.byFabric'), columns, rows, generated: stamp };
  }
  if (kind === 'byGrade') {
    const columns = ['grade', 'colors', 'rolls', 'meters', 'value'];
    const agg = new Map();
    for (const id of scope) {
      for (const r of (await listInventoryRows(env.DB, id))) {
        if (r.active !== 1) continue;
        const key = r.grade;
        if (!agg.has(key)) agg.set(key, { colors: new Set(), rolls: 0, meters: 0, value: 0 });
        const a = agg.get(key);
        a.colors.add(r.color_id);
        a.rolls += r.closing_rolls;
        a.meters += totalMeters(r.closing_rolls, r.meters_per_roll);
        a.value += totalValue(r.closing_rolls, r.unit_cost_per_roll);
      }
    }
    const rows = [...agg.entries()].sort().map(([g, a]) => [g, a.colors.size, a.rolls, a.meters.toFixed(2), a.value.toFixed(2)]);
    return { title: t('rep.byGrade'), columns, rows, generated: stamp };
  }
  if (kind === 'byDate') {
    const columns = ['effective_date', 'kind', 'warehouse', 'fabric', 'color', 'rolls_delta'];
    const events = (await listEvents(env.DB, { limit: 1000, warehouseIds: scope }))
      .filter((e) => e.effective_date >= from && e.effective_date <= to);
    const rows = events.map((e) => [
      e.effective_date, e.kind, e.wh_name_ar || e.wh_name_en,
      e.fab_name_ar || e.fab_name_en, e.col_name_ar || e.col_name_en, e.rolls_delta,
    ]);
    return { title: t('rep.byDate'), columns, rows, generated: stamp };
  }
  if (kind === 'colors') {
    const columns = ['id', 'name_ar', 'name_en', 'hex', 'family', 'grade', 'keeper_code'];
    const colors = (await env.DB.prepare(`SELECT * FROM colors ORDER BY id`).all()).results;
    const rows = [];
    for (const c of colors) {
      // The colors CSV keeps a Keeper Code column (the signed-in keeper's own
      // code; Admin sees each code with its owner).
      let code = '';
      if (user.role === 'Admin') {
        const r = await env.DB.prepare(
          `SELECT custom_code FROM keeper_color_codes WHERE color_id=? ORDER BY custom_code`
        ).bind(c.id).all();
        code = r.results.map((x) => x.custom_code).join(' | ');
      } else {
        const r = await env.DB.prepare(
          `SELECT custom_code FROM keeper_color_codes WHERE color_id=? AND keeper_user_id=?`
        ).bind(c.id, user.id).first();
        code = r?.custom_code ?? '';
      }
      rows.push([c.id, c.name_ar, c.name_en, c.hex, c.family, c.grade, code]);
    }
    return { title: 'colors', columns, rows, generated: stamp };
  }
  // keeperCodes (Admin only — checked by caller for CSV; rows gated here too)
  const columns = ['code_id', 'keeper', 'color_id', 'custom_code', 'custom_name', 'notes', 'last_updated'];
  const rs = (await env.DB.prepare(
    `SELECT k.*, u.username AS keeper FROM keeper_color_codes k JOIN users u ON u.id = k.keeper_user_id ORDER BY u.username, k.custom_code`
  ).all()).results;
  return {
    title: 'keeperCodes', columns,
    rows: rs.map((r) => [r.id, r.keeper, r.color_id, r.custom_code, r.custom_name, r.notes, r.last_updated]),
    generated: stamp,
  };
}

function printSheet(report, lang, user, from, to) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const head = report.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = report.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${esc(report.title)}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; margin: 2rem; }
  .letterhead { border-bottom: 3px solid #1f4fa3; padding-bottom: .75rem; margin-bottom: 1.25rem; }
  .letterhead h1 { margin: 0; color: #1f4fa3; }
  .meta { color: #555; font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: .35rem .6rem; text-align: start; font-size: .92rem; }
  th { background: #eef2fa; }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <div class="letterhead">
    <h1>${esc(t('app.title', null, lang))} — ${esc(report.title)}</h1>
    <div class="meta">${esc(t('rd.storage', null, lang))}: ${esc(t('rd.storageValue', null, lang))}</div>
    <div class="meta">${esc(t('rep.from', null, lang))} ${esc(from)} · ${esc(t('rep.to', null, lang))} ${esc(to)} · ${esc(t('rep.generated', null, lang))} ${esc(report.generated)}</div>
    <div class="meta">${esc(t('app.signedInAs', null, lang))} ${esc(user.username)} (${esc(user.role)})</div>
  </div>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  <p class="meta">${esc(t('offline.note', { date: formatDate(new Date().toISOString().slice(0, 10), lang) }, lang))}</p>
</body>
</html>`;
}

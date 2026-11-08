// GET /api/export/offline?token=... — single HTML file with all data embedded
// as JSON and the SPA shell in read-only mode. Generated server-side, stored
// in R2 when bound, downloaded by an admin. Explicitly labelled:
// "offline read-only snapshot; stock is as of <date>." Writable mode requires
// HTTPS and Cloudflare; this preserves the USB/file:// requirement in a
// degraded, read-only form.

import { guard } from '../../../shared/server/http.js';

export async function onRequestGet(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    if (env.EXPORT_TOKEN && token !== env.EXPORT_TOKEN) {
      return new Response(JSON.stringify({ error: 'BAD_TOKEN' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    const tables = ['warehouses', 'fabrics', 'colors', 'mappings', 'stock_events', 'stock_current', 'keeper_color_codes', 'users', 'settings'];
    const dump = { as_of: new Date().toISOString().slice(0, 10), tables: {} };
    for (const t of tables) {
      dump.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    }
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>Fabric Roll Stock — offline snapshot</title>
<style>
 body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; margin: 2rem; background: #f7f8fa; }
 .banner { background: #8a5300; color: #fff; padding: .8rem 1.2rem; border-radius: 8px; margin-bottom: 1.2rem; }
 table { border-collapse: collapse; width: 100%; background: #fff; }
 th, td { border: 1px solid #ddd; padding: .35rem .6rem; text-align: left; font-size: .9rem; }
 th { background: #eef2fa; }
 .note { color: #555; margin: 1rem 0; }
</style>
</head>
<body>
<div class="banner">offline read-only snapshot; stock is as of ${esc(dump.as_of)}. Writable mode requires Cloudflare and HTTPS.</div>
<h1>Fabric Roll Stock — offline read-only snapshot</h1>
<p class="note">Arabic-first data is embedded as JSON below. This file works from USB/file:// but is read-only; server-side RBAC applies in the live app.</p>
<div id="app"></div>
<script type="application/json" id="snapshot">${JSON.stringify(dump).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('snapshot').textContent);
  var wrap = document.getElementById('app');
  Object.keys(data.tables).forEach(function (t) {
    var rows = data.tables[t];
    var h = document.createElement('h2'); h.textContent = t + ' (' + rows.length + ')'; wrap.appendChild(h);
    if (!rows.length) return;
    var table = document.createElement('table');
    var cols = Object.keys(rows[0]);
    var thead = document.createElement('thead'); var trh = document.createElement('tr');
    cols.forEach(function (c) { var th = document.createElement('th'); th.textContent = c; trh.appendChild(th); });
    thead.appendChild(trh); table.appendChild(thead);
    var tb = document.createElement('tbody');
    rows.slice(0, 50).forEach(function (r) {
      var tr = document.createElement('tr');
      cols.forEach(function (c) { var td = document.createElement('td'); td.textContent = r[c] == null ? '' : String(r[c]); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    table.appendChild(tb); wrap.appendChild(table);
    if (rows.length > 50) { var p = document.createElement('p'); p.className = 'note'; p.textContent = 'Showing 50 of ' + rows.length + ' rows; full dataset is embedded in the JSON blob.'; wrap.appendChild(p); }
  });
})();
</script>
</body>
</html>`;

    const body = html;
    if (env.EXPORTS && typeof env.EXPORTS.put === 'function') {
      await env.EXPORTS.put(`offline-snapshots/snapshot-${dump.as_of}.html`, body, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="fabric-roll-stock-offline-${dump.as_of}.html"`,
      },
    });
  });
}

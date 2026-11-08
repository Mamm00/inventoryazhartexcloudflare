// POST /api/colors/codes/import — Admin-only CSV import of keeperCodes.
// The importer matches on header names, not positions, and must survive a
// reordered file.

import { json, readBody, guard } from '../../../../shared/server/http.js';

const HEADER_ALIASES = {
  code_id: ['code_id', 'id', 'كود'],
  keeper: ['keeper', 'keeper_user_id', 'username', 'المسؤول'],
  color_id: ['color_id', 'color', 'اللون'],
  custom_code: ['custom_code', 'code', 'الكود'],
  custom_name: ['custom_name', 'name', 'الاسم'],
  notes: ['notes', 'notes ', 'ملاحظات'],
  last_updated: ['last_updated', 'updated', 'آخر تحديث'],
};

function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      cur.push(field); field = '';
      if (cur.length > 1 || cur[0] !== '') rows.push(cur);
      cur = [];
    } else field += ch;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

export async function onRequestPost(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
  const user = context.data?.user ?? context.user;
    const body = await readBody(request);
    const text = String(body.csv || '');
    const rows = parseCsv(text.replace(/^\uFEFF/, ''));
    if (rows.length < 2) return json({ ok: false, error: 'EMPTY' }, 400);

    // Map columns by header NAME — order does not matter.
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      col[key] = header.findIndex((h) => aliases.includes(h));
    }
    if (col.color_id === -1 || col.custom_code === -1) {
      return json({ ok: false, error: 'BAD_HEADERS', message: 'Need at least color_id and custom_code headers' }, 400);
    }

    let imported = 0;
    for (const r of rows.slice(1)) {
      const get = (k) => (col[k] >= 0 ? r[col[k]] ?? '' : '');
      const keeperUsername = get('keeper');
      let keeperId = user.id;
      if (keeperUsername) {
        const u = await env.DB.prepare(`SELECT id FROM users WHERE id=? OR username=?`).bind(keeperUsername, keeperUsername).first();
        if (u) keeperId = u.id;
      }
      const now = get('last_updated') || new Date().toISOString().slice(0, 10);
      const existing = await env.DB.prepare(
        `SELECT id FROM keeper_color_codes WHERE keeper_user_id=? AND color_id=?`
      ).bind(keeperId, get('color_id')).first();
      if (existing) {
        await env.DB.prepare(
          `UPDATE keeper_color_codes SET custom_code=?, custom_name=?, notes=?, last_updated=? WHERE id=?`
        ).bind(get('custom_code'), get('custom_name'), get('notes'), now, existing.id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO keeper_color_codes (id, keeper_user_id, color_id, custom_code, custom_name, notes, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(get('code_id') || `kcode-${crypto.randomUUID().slice(0, 8)}`, keeperId,
          get('color_id'), get('custom_code'), get('custom_name'), get('notes'), now).run();
      }
      imported += 1;
    }
    return json({ ok: true, imported, headers: header });
  });
}

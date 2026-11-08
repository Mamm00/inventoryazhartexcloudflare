// POST /api/colors/load — ★ Load catalog. Idempotent in D1 (INSERT OR IGNORE):
// existing ids are skipped, never overwritten.

import { json, guard } from '../../../shared/server/http.js';
import { CATALOG_ROWS } from '../../../shared/catalog.js';

export async function onRequestPost(context) {
  return guard(context, 'color.add', null, async () => {
    const { env } = context;
    let added = 0;
    let skipped = 0;
    await env.DB.exec('BEGIN');
    for (const c of CATALOG_ROWS) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO colors (id, name_ar, name_en, hex, family, grade, active) VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(c.id, c.name_ar, c.name_en, c.hex, c.family, c.grade).run();
      if (res.meta?.changes > 0) added += 1;
      else skipped += 1;
    }
    await env.DB.exec('COMMIT');
    return json({ ok: true, added, skipped });
  });
}

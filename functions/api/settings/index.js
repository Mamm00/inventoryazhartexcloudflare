// GET/PATCH /api/settings — Admin only; keepers get 403 (audited).
// Backup/restore of the full D1 dataset as JSON.

import { json, readBody, guard, csv } from '../../../shared/server/http.js';
import { countRecords, writeAudit } from '../../../shared/server/db.js';

const TABLES = ['warehouses', 'fabrics', 'colors', 'mappings', 'stock_events', 'stock_current', 'keeper_color_codes', 'users', 'settings'];

export async function onRequestGet(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
    const url = new URL(request.url);
    if (url.searchParams.get('backup') === '1') {
      const dump = { version: '1.2.0', exported_at: new Date().toISOString(), tables: {} };
      for (const t of TABLES) {
        dump.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
      }
      dump.totals = {
        stock_current_closing: dump.tables.stock_current.reduce((a, r) => a + r.closing_rolls, 0),
        records: dump.tables.warehouses.length + dump.tables.fabrics.length + dump.tables.colors.length
          + dump.tables.mappings.length + dump.tables.stock_events.length + dump.tables.stock_current.length
          + dump.tables.keeper_color_codes.length + dump.tables.users.length,
      };
      return json(dump);
    }
    const settings = (await env.DB.prepare(`SELECT * FROM settings`).all()).results;
    const users = (await env.DB.prepare(`SELECT id, username, role, warehouse_ids, active FROM users`).all()).results;
    return json({ settings, users, records: await countRecords(env.DB) });
  });
}

export async function onRequestPatch(context) {
  return guard(context, 'settings.write', null, async () => {
    const { env, request } = context;
  const user = context.data?.user ?? context.user;
    const body = await readBody(request);

    if (body.restore) {
      // Restore from JSON: clear local D1 tables and re-insert, then verify
      // stock_current totals are identical to the backup.
      const dump = body.restore;
      await env.DB.exec('BEGIN');
      for (const t of TABLES) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
        for (const row of dump.tables?.[t] ?? []) {
          const cols = Object.keys(row);
          await env.DB.prepare(
            `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
          ).bind(...cols.map((c) => row[c])).run();
        }
      }
      await env.DB.exec('COMMIT');
      const closing = (await env.DB.prepare(`SELECT COALESCE(SUM(closing_rolls),0) AS n FROM stock_current`).first()).n;
      const expected = dump.tables.stock_current.reduce((a, r) => a + r.closing_rolls, 0);
      await writeAudit(env.DB, {
        actorUserId: user.id, action: 'settings.restore', entity: 'settings', entityId: 'restore',
        afterJson: JSON.stringify({ closing, expected }), result: closing === expected ? 'OK' : 'Blocked (mismatch)',
      });
      return json({ ok: closing === expected, closing, expected });
    }

    if (body.settings) {
      for (const [k, v] of Object.entries(body.settings)) {
        await env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
        ).bind(k, String(v)).run();
      }
    }
    if (body.userRole) {
      // Re-assign users (incl. restoring a SalesManager to a real role).
      await env.DB.prepare(`UPDATE users SET role=?, warehouse_ids=?, active=? WHERE id=?`)
        .bind(body.userRole.role, JSON.stringify(body.userRole.warehouseIds ?? []),
          body.userRole.active === false ? 0 : 1, body.userRole.id).run();
    }
    return json({ ok: true });
  });
}

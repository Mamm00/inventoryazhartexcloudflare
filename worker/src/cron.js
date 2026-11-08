// worker/src/cron.js — scheduled jobs:
//   every 15 min   — expire D1 sessions, release rate-limit counters
//   daily 06:00    — low-stock digest per keeper (Africa/Cairo)
//   daily 02:00    — D1 integrity check: orphans, duplicates, unmapped active
//                    rows, negative stock_current
//   weekly Sunday  — R2 backup of D1 exports + sha256 manifest
//   on demand      — reindex Vectorize after catalogue changes

export async function scheduled(env, ctx) {
  const now = new Date();
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();

  // every 15 minutes
  await expireSessions(env);
  await releaseRateLimits(env);

  // daily 06:00 Africa/Cairo (UTC+2 ⇒ 04:00 UTC)
  if (hour === 4 && minute < 15) await lowStockDigest(env);
  // daily 02:00 UTC
  if (hour === 2 && minute < 15) await integrityCheck(env);
  // weekly Sunday 03:00 UTC
  if (dow === 0 && hour === 3 && minute < 15) await weeklyBackup(env, ctx);
}

async function expireSessions(env) {
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(new Date().toISOString()).run();
}

async function releaseRateLimits(env) {
  // KV-backed buckets carry expirationTtl; nothing durable to sweep.
  if (env.CACHE && typeof env.CACHE.list === 'function') {
    const keys = await env.CACHE.list({ prefix: 'rl:' });
    for (const k of keys.keys ?? []) {
      if (k.expiration && k.expiration * 1000 < Date.now()) await env.CACHE.delete(k.name);
    }
  }
}

async function lowStockDigest(env) {
  const rows = (await env.DB.prepare(
    `SELECT w.keeper_user_id, u.username, u.display_name_ar, m.warehouse_id, m.fabric_id, m.color_id,
            m.min_rolls, COALESCE(s.closing_rolls,0) AS closing_rolls
     FROM mappings m
     JOIN warehouses w ON w.id = m.warehouse_id
     JOIN users u ON u.id = w.keeper_user_id
     LEFT JOIN stock_current s ON s.warehouse_id=m.warehouse_id AND s.fabric_id=m.fabric_id AND s.color_id=m.color_id
     WHERE m.active = 1 AND COALESCE(s.closing_rolls,0) <= m.min_rolls`
  ).all()).results;
  const byKeeper = new Map();
  for (const r of rows) {
    if (!byKeeper.has(r.keeper_user_id)) byKeeper.set(r.keeper_user_id, { username: r.username, name: r.display_name_ar, items: [] });
    byKeeper.get(r.keeper_user_id).items.push(r);
  }
  for (const [, k] of byKeeper) {
    if (env.CACHE && typeof env.CACHE.put === 'function') {
      await env.CACHE.put(`digest:${k.username}:${new Date().toISOString().slice(0, 10)}`,
        JSON.stringify({ count: k.items.length, items: k.items.slice(0, 50) }), { expirationTtl: 604800 });
    }
  }
  return { keepers: byKeeper.size, items: rows.length };
}

async function integrityCheck(env) {
  const one = async (sql) => (await env.DB.prepare(sql).first()).n;
  const report = {
    orphans: await one(`SELECT COUNT(*) n FROM stock_current s WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id)`),
    duplicates: await one(`SELECT COUNT(*) n FROM (SELECT warehouse_id, fabric_id, color_id FROM mappings GROUP BY 1,2,3 HAVING COUNT(*)>1)`),
    unmapped: await one(`SELECT COUNT(*) n FROM stock_current s LEFT JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id WHERE m.id IS NULL OR m.active=0`),
    negative: await one(`SELECT COUNT(*) n FROM stock_current WHERE closing_rolls < 0`),
    checked_at: new Date().toISOString(),
  };
  if (env.CACHE && typeof env.CACHE.put === 'function') {
    await env.CACHE.put('integrity:last', JSON.stringify(report), { expirationTtl: 86400 * 7 });
  }
  return report;
}

async function weeklyBackup(env, ctx) {
  const tables = ['warehouses', 'fabrics', 'colors', 'mappings', 'stock_events', 'stock_current', 'keeper_color_codes', 'users', 'settings'];
  const dump = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of tables) dump.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  const body = JSON.stringify(dump);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const day = new Date().toISOString().slice(0, 10);
  if (env.EXPORTS && typeof env.EXPORTS.put === 'function') {
    await env.EXPORTS.put(`backups/backup-${day}.json`, body, { httpMetadata: { contentType: 'application/json' } });
    await env.EXPORTS.put(`backups/backup-${day}.sha256`, `${sha256}  backup-${day}.json\n`, { httpMetadata: { contentType: 'text/plain' } });
  }
  return { sha256, bytes: body.length };
}

export { integrityCheck, lowStockDigest, weeklyBackup, expireSessions };

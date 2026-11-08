// functions/api/auth/setup.js — first-run database initialization.
//
// The only situation this endpoint ever acts in: the deployment is live and
// bound to a D1 database that has ZERO user accounts (fresh, or partially
// seeded — e.g. schema applied but the 3,000-statement seed never landed,
// which is exactly what happens when someone tries to paste 500 KB of SQL
// into the D1 console from a phone). It:
//   1. refuses (409) the moment any account exists — it can never touch a
//      working database;
//   2. wipes any partial rows (tables discovered at runtime; three tolerant
//      passes handle FK ordering);
//   3. applies migrations/0001–0003 — the exact same SQL the docs describe —
//      DDL tolerant of pre-existing tables, seed strict;
//   4. reports the resulting record count and audits the run.
// Rate-limited per IP like login. The login screen offers a one-tap
// "Initialize database" button when the API reports NO_ACCOUNTS/NO_SCHEMA.

import { countRecords, writeAudit } from '../../../shared/server/db.js';
import { json, clientIp, rateLimitCheck, rateLimitFail } from '../../../shared/server/http.js';
import { SCHEMA_SQL, SEED_SQL, INDEXES_SQL } from '../../../shared/seed-sql.js';

function splitSql(text) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      cur += c;
      if (c === "'") {
        if (text[i + 1] === "'") { cur += text[i + 1]; i += 1; } else quoted = false;
      }
      continue;
    }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      cur += '\n';
      continue;
    }
    if (c === ';') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s);
}

async function runTolerant(db, stmt) {
  try {
    await db.prepare(stmt).run();
  } catch (e) {
    if (!/already exists/i.test(String((e && e.message) || e))) throw e;
  }
}

async function runStrictChunked(db, text) {
  const stmts = splitSql(text);
  let chunk = [];
  let size = 0;
  const flush = async () => {
    if (!chunk.length) return;
    await db.exec(`${chunk.join(';\n')};`);
    chunk = [];
    size = 0;
  };
  for (const s of stmts) {
    chunk.push(s);
    size += s.length;
    if (size > 60_000) await flush();
  }
  await flush();
  return stmts.length;
}

const results = (r) => (Array.isArray(r) ? r : (r && r.results) || []);

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = clientIp(request);
  const rlKey = `setup:${ip}`;
  const locked = await rateLimitCheck(env, rlKey);
  if (locked.locked) {
    return json({ error: 'LOCKED', message: 'Too many attempts — try again in 60 seconds' }, 429);
  }
  await rateLimitFail(env, rlKey); // count the attempt; 5 in a row → 60 s pause

  if (!env.DB || typeof env.DB.prepare !== 'function') {
    return json({ error: 'CONFIG', message: 'Database not bound — set the D1 binding named DB (see DEPLOY.md §4)' }, 503);
  }

  let users = 0;
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    users = (r && r.n) || 0;
  } catch { users = 0; } // no schema yet → same as empty
  if (users > 0) {
    return json({ error: 'ALREADY_SET_UP', message: 'Database already has accounts — setup refuses to touch it' }, 409);
  }

  // 1) wipe partial data (runtime-discovered tables; FK-safe by repetition)
  let tables = [];
  try {
    const res = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'"
    ).all();
    tables = results(res).map((r) => r.name);
  } catch { tables = []; }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const t of tables) {
      try { await env.DB.prepare(`DELETE FROM "${t}"`).run(); } catch { /* FK order resolves over passes */ }
    }
  }

  // 2) apply the documented migrations — DDL tolerant, seed strict
  for (const stmt of splitSql(SCHEMA_SQL)) await runTolerant(env.DB, stmt);
  const seeded = await runStrictChunked(env.DB, SEED_SQL);
  for (const stmt of splitSql(INDEXES_SQL)) await runTolerant(env.DB, stmt);

  const records = await countRecords(env.DB).catch(() => null);
  try {
    await writeAudit(env.DB, {
      action: 'auth.setup', entity: 'database', entityId: 'first-run', ip,
      userAgent: request.headers.get('user-agent'),
      result: `OK (first-run setup: ${seeded} statements)`,
    });
  } catch { /* best effort */ }

  return json({ ok: true, records });
}

// tests/api.test.js — exercises the real Pages Function modules against the
// local D1 adapter (the same handler code Cloudflare runs). Covers:
// login/lockout, Access JWT rejection, Turnstile failure, server-side can(),
// transfer between sheds, negative-stock refusal, concurrent transfer/movement
// serialisation through the Durable Object (20 simultaneous movements: exactly
// the allowed number succeeds, the rest 409, no stock_current row below zero),
// Cross-View has no write routes, keeper code isolation, CSV formula injection,
// JSON round-trip restore.
//
// Note: `wrangler pages dev`/Miniflare end-to-end needs Cloudflare network
// access to fetch wrangler runtime assets; the same handlers are exercised
// here in-process. See FINAL.md for the exact command that could not run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshDb, makeEnv, req, ctx, USERS, serialState } from './_harness.js';
import { onRequestPost as loginPost } from '../functions/api/auth/login.js';
import { onRequestGet as meGet } from '../functions/api/auth/me.js';
import { onRequestGet as stockGet } from '../functions/api/stock/index.js';
import { onRequestGet as inventoryGet } from '../functions/api/inventory/index.js';
import { onRequestPost as movementsPost, onRequestGet as movementsGet } from '../functions/api/movements/index.js';
import { onRequestGet as colorsGet } from '../functions/api/colors/index.js';
import { onRequestGet as codesGet } from '../functions/api/colors/codes.js';
import { onRequestPost as colorsLoadPost } from '../functions/api/colors/load.js';
import { onRequestDelete as colorDelete } from '../functions/api/colors/[id].js';
import { onRequestGet as crossGet } from '../functions/api/cross/index.js';
import { onRequestGet as reportsGet } from '../functions/api/reports/index.js';
import { onRequestGet as auditGet } from '../functions/api/audit/index.js';
import { onRequestGet as settingsGet, onRequestPatch as settingsPatch } from '../functions/api/settings/index.js';
import { onRequestGet as readmeGet } from '../functions/api/readme/index.js';
import { onRequestGet as diagGet } from '../functions/api/masters/diagnostics.js';
import { onRequestGet as offlineGet } from '../functions/api/export/offline.js';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import { WarehouseLedger } from '../worker/src/ledger-do.js';
import { createSession } from '../shared/server/db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'seed_manifest.json'), 'utf-8'));

async function login(env, username, password) {
  return loginPost(ctx(env, null, req('/api/auth/login', { method: 'POST', body: { username, password } })));
}

function cookieOf(res) {
  const raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/frs_session=([^;]+)/);
  return m ? m[1] : null;
}

test('login: seeded accounts authenticate; bad password is 401', async () => {
  const { env } = freshDb();
  const ok = await login(env, 'keeper1', 'mostafa123');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.user.username, 'keeper1');
  assert.equal(body.user.role, 'WarehouseKeeper');
  assert.ok(cookieOf(ok), 'session cookie set');

  const bad = await login(env, 'keeper1', 'wrong');
  assert.equal(bad.status, 401);
});

test('rate limiting: 5 failures trigger a 60-second server-side lockout', async () => {
  const { env } = freshDb();
  for (let i = 0; i < 5; i += 1) {
    const res = await login(env, 'keeper2', 'nope');
    assert.equal(res.status, 401);
  }
  const locked = await login(env, 'keeper2', 'keeper2123'); // even correct password
  assert.equal(locked.status, 429);
  const data = await locked.json();
  assert.equal(data.error, 'LOCKED');
});

test('Turnstile: failed token is rejected when TURNSTILE_SECRET is set', async () => {
  const { env } = freshDb({ TURNSTILE_SECRET: 'test-secret' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), { status: 200 });
  try {
    const res = await loginPost(ctx(env, null, req('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123', turnstileToken: 'bad' },
    })));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'TURNSTILE');
  } finally {
    globalThis.fetch = realFetch;
  }
  // A good token passes siteverify and logs in.
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  try {
    const res = await loginPost(ctx(env, null, req('/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: 'admin123', turnstileToken: 'good' },
    })));
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Access JWT: missing assertion and invalid signature return 403; valid HS256 passes', async () => {
  const { db, env } = freshDb();
  env.ACCESS_CLIENT_SECRET = 'access-secret';
  const next = async () => new Response('ok');

  const noJwt = await middleware({ env, request: req('/api/stock') }, next);
  assert.equal(noJwt.status, 403, 'no cookie and no JWT → 403');

  const badJwt = await middleware({
    env,
    request: req('/api/stock', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }),
  }, next);
  assert.equal(badJwt.status, 403, 'malformed/invalid JWT → 403');

  const token = await signJwt('access-secret', { email: 'keeper1', exp: Math.floor(Date.now() / 1000) + 3600 });
  let passedUser = null;
  const ok = await middleware({
    env,
    request: req('/api/stock', { headers: { 'cf-access-jwt-assertion': token } }),
  }, async () => { passedUser = 'yes'; return new Response('ok'); });
  assert.equal(ok.status, 200);
  assert.equal(passedUser, 'yes');

  const expired = await signJwt('access-secret', { email: 'keeper1', exp: Math.floor(Date.now() / 1000) - 3600 });
  const old = await middleware({
    env,
    request: req('/api/stock', { headers: { 'cf-access-jwt-assertion': expired } }),
  }, next);
  assert.equal(old.status, 403, 'expired JWT → 403');
});

async function signJwt(secret, claims) {
  const enc = new TextEncoder();
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64(claims);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${payload}`));
  return `${head}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}

test('middleware accepts the session cookie created by login', async () => {
  const { env } = freshDb();
  const res = await login(env, 'admin', 'admin123');
  const sid = cookieOf(res);
  let user = null;
  const out = await middleware({
    env,
    request: req('/api/stock', { headers: { cookie: `frs_session=${sid}` } }),
  }, async () => { user = 'ok'; return new Response('ok'); });
  assert.equal(out.status, 200);
  assert.equal(user, 'ok');
});

test('server-side can(): keeper write to a colleague shed is 403 and audited as Blocked', async () => {
  const { db, env } = freshDb();
  const res = await movementsPost(ctx(env, USERS.keeper1, req('/api/movements', {
    method: 'POST',
    body: { kind: 'in', warehouseId: 'wh-625', fabricId: 'fab-041', colorId: 'col-blue-01', rolls: 3 },
  })));
  assert.equal(res.status, 403, 'UI-level attempt to write the colleague shed is refused');
  const audit = await db.prepare(
    `SELECT COUNT(*) n FROM audit_log WHERE result='Blocked' AND warehouse_id='wh-625'`
  ).first();
  assert.ok(audit.n >= 1, 'the denial is audited as Blocked');
});

test('DELETE /api/colors/:id returns 403 for keepers; in-use colour is 409 with Deactivate suggestion', async () => {
  const { db, env } = freshDb();
  const asKeeper = await colorDelete(ctx(env, USERS.keeper1, req('/api/colors/x', { method: 'DELETE' }), { id: 'col-blue-01' }));
  assert.equal(asKeeper.status, 403);

  // Admin deleting an in-use colour: refused with 409 + suggestion.
  const inUse = await db.prepare(`SELECT color_id FROM mappings LIMIT 1`).first();
  const asAdmin = await colorDelete(ctx(env, USERS.admin, req(`/api/colors/${inUse.color_id}`, { method: 'DELETE' }), { id: inUse.color_id }));
  assert.equal(asAdmin.status, 409);
  assert.equal((await asAdmin.json()).suggestion, 'deactivate');
});

test('★ Load catalog is idempotent (INSERT OR IGNORE — existing ids skipped)', async () => {
  const { db, env } = freshDb();
  const first = await colorsLoadPost(ctx(env, USERS.keeper1, req('/api/colors/load', { method: 'POST', body: {} })));
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.ok(firstBody.added > 0);
  const second = await colorsLoadPost(ctx(env, USERS.keeper1, req('/api/colors/load', { method: 'POST', body: {} })));
  const secondBody = await second.json();
  assert.equal(secondBody.added, 0, 'second load adds nothing');
  assert.equal(secondBody.skipped, firstBody.added, 'every row is skipped the second time');
});

test('movement flow: In/Out/Adjustment + negative-stock refusal names the shortfall', async () => {
  const { db, env } = freshDb();
  const row = await db.prepare(`
    SELECT s.warehouse_id, s.fabric_id, s.color_id, s.closing_rolls FROM stock_current s
    JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
    WHERE m.active=1 AND s.warehouse_id IN ('wh-alwa','wh-leon','wh-azouz','wh-zibda','wh-showroom')
    ORDER BY s.closing_rolls LIMIT 1
  `).first();
  const over = row.closing_rolls + 7;
  const res = await movementsPost(ctx(env, USERS.keeper1, req('/api/movements', {
    method: 'POST',
    body: {
      kind: 'out', warehouseId: row.warehouse_id, fabricId: row.fabric_id,
      colorId: row.color_id, rolls: over,
    },
  })));
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, 'NEGATIVE_STOCK');
  assert.equal(data.shortfall, 7, 'the shortfall is named in the refusal');
  assert.equal(data.after, -7);

  // A legal In on the same combo succeeds and raises closing.
  const inRes = await movementsPost(ctx(env, USERS.keeper1, req('/api/movements', {
    method: 'POST',
    body: { kind: 'in', warehouseId: row.warehouse_id, fabricId: row.fabric_id, colorId: row.color_id, rolls: 2 },
  })));
  assert.equal(inRes.status, 200);
  const after = await db.prepare(
    `SELECT closing_rolls FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(row.warehouse_id, row.fabric_id, row.color_id).first();
  assert.equal(after.closing_rolls, row.closing_rolls + 2);
});

test('transfer between sheds moves N rolls and leaves the company total unchanged', async () => {
  const { db, env } = freshDb();
  const shared = await db.prepare(`
    SELECT m1.warehouse_id AS w1, m2.warehouse_id AS w2, m1.fabric_id, m1.color_id
    FROM mappings m1 JOIN mappings m2
      ON m1.fabric_id=m2.fabric_id AND m1.color_id=m2.color_id AND m1.warehouse_id < m2.warehouse_id
    WHERE m1.active=1 AND m2.active=1 LIMIT 1
  `).first();
  const sumBefore = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  const res = await movementsPost(ctx(env, USERS.admin, req('/api/movements', {
    method: 'POST',
    body: {
      kind: 'transfer', fromWarehouseId: shared.w1, toWarehouseId: shared.w2,
      fabricId: shared.fabric_id, colorId: shared.color_id, rolls: 4,
    },
  })));
  assert.equal(res.status, 200);
  const sumAfter = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  assert.equal(sumAfter, sumBefore, 'company total unchanged');
});

test('transfer compensation: receiver failure rolls the sender back (company total unchanged)', async () => {
  const { db, env } = freshDb();
  const sender = await db.prepare(`
    SELECT m.warehouse_id, m.fabric_id, m.color_id FROM mappings m
    WHERE m.active=1 AND NOT EXISTS (
      SELECT 1 FROM mappings m2 WHERE m2.warehouse_id='wh-kashry'
        AND m2.fabric_id=m.fabric_id AND m2.color_id=m.color_id AND m2.active=1)
    LIMIT 1
  `).first();
  const sumBefore = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  const res = await movementsPost(ctx(env, USERS.admin, req('/api/movements', {
    method: 'POST',
    body: {
      kind: 'transfer', fromWarehouseId: sender.warehouse_id, toWarehouseId: 'wh-kashry',
      fabricId: sender.fabric_id, colorId: sender.color_id, rolls: 3,
    },
  })));
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, 'TRANSFER_IN_FAILED');
  assert.equal(data.compensated, true);
  const sumAfter = (await db.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  assert.equal(sumAfter, sumBefore, 'company total unchanged after compensation');
  const rev = await db.prepare(
    `SELECT COUNT(*) n FROM audit_log WHERE action='transfer_compensated'`
  ).first();
  assert.ok(rev.n >= 1, 'the compensation is audited');
});

test('Durable Object concurrency: 20 simultaneous movements — exactly the allowed number succeeds', async () => {
  const { db, env } = freshDb();
  // Controlled combo: exactly 10 rolls in stock.
  const row = await db.prepare(`
    SELECT warehouse_id, fabric_id, color_id FROM stock_current WHERE closing_rolls > 25 LIMIT 1
  `).first();
  await db.prepare(`
    UPDATE stock_current SET opening_rolls=10, rolls_in=0, rolls_out=0, closing_rolls=10
    WHERE warehouse_id=? AND fabric_id=? AND color_id=?
  `).bind(row.warehouse_id, row.fabric_id, row.color_id).run();

  const state = serialState();
  const ledger = new WarehouseLedger(state, env);
  const attempts = [];
  for (let i = 0; i < 20; i += 1) {
    const request = req('https://ledger/apply', {
      method: 'POST',
      body: {
        kind: 'out', warehouseId: row.warehouse_id, fabricId: row.fabric_id,
        colorId: row.color_id, rollsDelta: -1, actor: { id: 'u-keeper1' },
      },
    });
    attempts.push(ledger.fetch(request).then(async (r) => ({ status: r.status, body: await r.json() })));
  }
  const results = await Promise.all(attempts);
  const okCount = results.filter((r) => r.body.ok).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  assert.equal(okCount, 10, `exactly 10 of 20 may succeed (got ${okCount})`);
  assert.equal(conflictCount, 10, `the rest receive 409 (got ${conflictCount})`);
  const after = await db.prepare(
    `SELECT closing_rolls FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(row.warehouse_id, row.fabric_id, row.color_id).first();
  assert.equal(after.closing_rolls, 0);
  const negative = await db.prepare(`SELECT COUNT(*) n FROM stock_current WHERE closing_rolls < 0`).first();
  assert.equal(negative.n, 0, 'no stock_current row goes below zero');
});

test('Cross-View: read-only data, and no write routes exist under /api/cross', async () => {
  const { env } = freshDb();
  const dir = path.join(ROOT, 'functions', 'api', 'cross');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), 'utf-8');
    assert.ok(!/onRequest(Post|Put|Patch|Delete)/.test(src), `cross/${f} must expose no mutating handler`);
  }
  const res = await crossGet(ctx(env, USERS.keeper1, req('/api/cross')));
  const data = await res.json();
  assert.equal(data.readOnly, true);
  assert.ok(data.sheds.length > 0);
  for (const shed of data.sheds) {
    assert.ok(!USERS.keeper1.warehouseIds.includes(shed.id), 'only colleague sheds');
    assert.equal(shed.keeper_user_id, 'u-keeper2');
  }
  assert.equal(data.owner.username, 'keeper2', 'the banner can name whose sheds these are');
});

test('keeper code isolation: each keeper sees only their own codes; Admin sees all', async () => {
  const { env } = freshDb();
  const k1 = await (await codesGet(ctx(env, USERS.keeper1, req('/api/colors/codes')))).json();
  const k2 = await (await codesGet(ctx(env, USERS.keeper2, req('/api/colors/codes')))).json();
  const admin = await (await codesGet(ctx(env, USERS.admin, req('/api/colors/codes')))).json();
  assert.ok(k1.codes.every((c) => c.keeper_user_id === 'u-keeper1'), 'keeper1 sees only own rows');
  assert.ok(k2.codes.every((c) => c.keeper_user_id === 'u-keeper2'), 'keeper2 sees only own rows');
  assert.equal(admin.codes.length, manifest.counts.keeper_codes);
  assert.equal(k1.codes.length + k2.codes.length, admin.codes.length);

  // Same rule on the colours payload (labels never leak to the colleague).
  const colors1 = await (await colorsGet(ctx(env, USERS.keeper1, req('/api/colors')))).json();
  assert.ok(colors1.codes.every((c) => c.keeper_user_id === 'u-keeper1'));
});

test('CSV exports: formula injection escaped, Arabic intact, colours keep a Keeper Code column', async () => {
  const { db, env } = freshDb();
  await db.prepare(
    `INSERT INTO colors (id, name_ar, name_en, hex, family, grade, active) VALUES ('col-evil', ?, 'Evil', '#000000', 'misc', 'A', 1)`
  ).bind('=HYPERLINK("http://evil.example","click")').run();
  const res = await reportsGet(ctx(env, USERS.admin, req('/api/reports?kind=colors&format=csv')));
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/csv'));
  const text = await res.text();
  assert.ok(text.includes('keeper_code'), 'the colors CSV keeps a Keeper Code column');
  assert.ok(text.includes("'=HYPERLINK"), 'formula injection neutralised with a leading apostrophe');
  assert.ok(!/\n=/.test(text), 'no raw formula at line start');
  assert.ok(text.includes('أزرق'), 'Arabic survives CSV export');

  // keeperCodes CSV is Admin-only.
  const asKeeper = await reportsGet(ctx(env, USERS.keeper1, req('/api/reports?kind=keeperCodes&format=csv')));
  assert.equal(asKeeper.status, 403);
  const asAdmin = await reportsGet(ctx(env, USERS.admin, req('/api/reports?kind=keeperCodes&format=csv')));
  assert.equal(asAdmin.status, 200);
  assert.ok((await asAdmin.text()).includes('custom_code'));
});

test('report kinds: byWarehouse/byFabric/byGrade/byDate produce rows', async () => {
  const { env } = freshDb();
  for (const kind of ['byWarehouse', 'byFabric', 'byGrade', 'byDate']) {
    const res = await reportsGet(ctx(env, USERS.admin, req(`/api/reports?kind=${kind}`)));
    assert.equal(res.status, 200, kind);
    const data = await res.json();
    assert.ok(Array.isArray(data.columns) && data.columns.length > 0, kind);
  }
  const wh = await (await reportsGet(ctx(env, USERS.keeper1, req('/api/reports?kind=byWarehouse')))).json();
  assert.equal(wh.rows.length, 5, 'report scope follows the signed-in keeper');
});

test('JSON backup → clear D1 → restore → identical stock_current totals', async () => {
  const a = freshDb();
  const backup = await (await settingsGet(ctx(a.env, USERS.admin, req('/api/settings?backup=1')))).json();
  assert.ok(backup.tables.stock_current.length > 0);

  const b = freshDb();
  // Wipe the target first (JSON export → clear local D1 → restore).
  await b.env.DB.exec('DELETE FROM stock_current');
  const res = await settingsPatch(ctx(b.env, USERS.admin, req('/api/settings', {
    method: 'PATCH', body: { restore: backup },
  })));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.closing, data.expected, 'restore verifies identical totals');
  const bTotal = (await b.env.DB.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  const aTotal = (await a.env.DB.prepare('SELECT SUM(closing_rolls) n FROM stock_current').first()).n;
  assert.equal(bTotal, aTotal, 'identical stock_current totals after restore');
});

test('settings is Admin-only (keepers get 403, audited)', async () => {
  const { db, env } = freshDb();
  const res = await settingsGet(ctx(env, USERS.keeper1, req('/api/settings')));
  assert.equal(res.status, 403);
  const blocked = await db.prepare(
    `SELECT COUNT(*) n FROM audit_log WHERE action='settings.write' AND result='Blocked'`
  ).first();
  assert.ok(blocked.n >= 1);
});

test('readme: shed map per account (admin ten rows + total; Mostafa five rows + total)', async () => {
  const { env } = freshDb();
  const admin = await (await readmeGet(ctx(env, USERS.admin, req('/api/readme')))).json();
  assert.equal(admin.shedMap.length, 10);
  assert.equal(admin.shedMapTotal, manifest.rolls.company_active);
  const k1 = await (await readmeGet(ctx(env, USERS.keeper1, req('/api/readme')))).json();
  assert.equal(k1.shedMap.length, 5);
  assert.equal(k1.shedMapTotal, manifest.rolls.mostafa_active);
  assert.equal(k1.roleMatrix.perms['settings.write'][0], 'Admin', 'role matrix is read out of PERMS');
});

test('stock overview: keeper1 sees exactly 5 shed cards summing to their total', async () => {
  const { env } = freshDb();
  const res = await stockGet(ctx(env, USERS.keeper1, req('/api/stock')));
  const data = await res.json();
  assert.equal(data.sheds.length, 5);
  const sum = data.sheds.reduce((a, s) => a + s.rolls, 0);
  assert.equal(sum, manifest.rolls.mostafa_active, 'shed cards sum equals Mostafa total');
  assert.equal(data.totals.rolls, sum);
});

test('inventory rows carry closing, metres, value, status and the invalid-combination flag', async () => {
  const { env } = freshDb();
  const res = await inventoryGet(ctx(env, USERS.keeper1, req('/api/inventory?wh=wh-showroom')));
  const data = await res.json();
  assert.ok(data.rows.length > 0);
  for (const r of data.rows) {
    assert.equal(typeof r.closing_rolls, 'number');
    assert.ok(Math.abs(r.meters - r.closing_rolls * r.meters_per_roll) < 1e-6);
    assert.ok(Math.abs(r.value - r.closing_rolls * r.unit_cost_per_roll) < 1e-6);
    assert.ok(['out', 'low', 'over', 'ok'].includes(r.status));
  }
  // Inventory of a colleague shed is out of scope → 403.
  const denied = await inventoryGet(ctx(env, USERS.keeper1, req('/api/inventory?wh=wh-625')));
  assert.equal(denied.status, 403);
});

test('diagnostics: the 26 deactivated rows are listed as unmapped-active', async () => {
  const { env } = freshDb();
  const data = await (await diagGet(ctx(env, USERS.admin, req('/api/masters/diagnostics')))).json();
  assert.equal(data.summary.negative, 0);
  assert.equal(data.summary.orphans, 0);
  assert.equal(data.summary.duplicates, 0);
  assert.equal(data.summary.unmapped, manifest.rolls.inactive_mapping_rows,
    'unmapped rows = the deactivated mapping rows (the invalid flag)');
});

test('offline snapshot: admin-only, labelled read-only with an as-of date', async () => {
  const { env } = freshDb();
  const res = await offlineGet(ctx(env, USERS.admin, req('/api/export/offline?token=')));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('offline read-only snapshot; stock is as of'));
  assert.ok(html.includes('Writable mode requires Cloudflare and HTTPS'));
  const denied = await offlineGet(ctx(env, USERS.keeper1, req('/api/export/offline?token=')));
  assert.equal(denied.status, 403);
});

test('health endpoint returns 200', async () => {
  const { onRequestGet } = await import('../functions/api/health.js');
  const { env } = freshDb();
  const res = await onRequestGet({ env, request: req('/api/health') });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('worker entry (worker/src/app.js router) dispatches /api/* through the shared handlers', async () => {
  const { handleApi } = await import('../worker/src/api-router.js');
  const { env } = freshDb();
  const unauth = await handleApi(req('/api/stock'), env);
  assert.equal(unauth.status, 403);
  assert.equal((await unauth.json()).error, 'UNAUTHORIZED');
  const login = await handleApi(req('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { username: 'admin', password: 'admin123' },
  }), env);
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const stock = await handleApi(req('/api/stock', { headers: { cookie } }), env);
  assert.equal(stock.status, 200);
  assert.equal((await stock.json()).sheds.length, 10);
  const notFound = await handleApi(req('/api/nope', { headers: { cookie } }), env);
  assert.equal(notFound.status, 404);
});

#!/usr/bin/env node
// tools/provision.mjs — build-time provisioning for the fabric-roll-stock
// deployment. Runs automatically as npm's `postinstall`, which the Cloudflare
// build executes via `npm clean-install` BEFORE `npx wrangler deploy`. When the
// build environment carries a CLOUDFLARE_API_TOKEN (it does, so wrangler can
// deploy), this script:
//   1. finds-or-creates the D1 database `fabric-roll-stock`, the KV namespace
//      CACHE, the R2 bucket fabric-roll-exports and the app queues;
//   2. rewrites the region between the scissors markers in wrangler.toml with
//      real binding blocks (the repo keeps commented templates — IDs are
//      account-local and never committed);
//   3. applies migrations/ to the database (idempotent — tracked in d1_migrations,
//      and skipped when a hand-seeded users table is detected).
// Without a token (local dev, this repository's test sandbox) it exits 0 with
// one log line and changes nothing. Every step degrades gracefully: a
// permission error leaves that resource as a commented template and the app
// reports the exact missing step at login (CONFIG / NO_ACCOUNTS / NO_SCHEMA).
//
// Flags: --self-test (offline; validates the rewrite logic), --dry-run
// (resolve + print the plan, write nothing).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.toml');
const START = '# --8<-- provisioned-bindings-start';
const END = '# --8<-- provisioned-bindings-end';
const DRY = process.argv.includes('--dry-run');
const SELF_TEST = process.argv.includes('--self-test');

const DB_NAME = 'fabric-roll-stock';
const KV_TITLE = 'CACHE';
const R2_BUCKET = 'fabric-roll-exports';
const QUEUES = ['audit-queue', 'email-queue', 'export-queue',
  'audit-queue-dlq', 'email-queue-dlq', 'export-queue-dlq'];

function log(msg) { console.log(`provision: ${msg}`); }

function runWrangler(args) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  const cmd = existsSync(bin) ? bin : 'wrangler';
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') };
  }
}

const uuidOf = (t) => (String(t).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [null])[0];
const kvIdOf = (t) => (String(t).match(/\b[0-9a-f]{32}\b/i) || [null])[0];
const existsErr = (r) => /already|owns|exists/i.test(r.err);

// ---- resource provisioning ------------------------------------------------

function provisionD1() {
  const list = runWrangler(['d1', 'list', '--json']);
  if (list.ok) {
    try {
      const rows = JSON.parse(list.out);
      const hit = (Array.isArray(rows) ? rows : rows.result || []).find((r) => r.name === DB_NAME);
      if (hit && hit.uuid) return hit.uuid;
    } catch { /* table output — fall through to regex */ }
    const line = list.out.split('\n').find((l) => l.includes(DB_NAME));
    const id = uuidOf(line || '');
    if (id) return id;
  }
  const created = runWrangler(['d1', 'create', DB_NAME, '--json']);
  const id = uuidOf(created.out + created.err);
  if (id) return id;
  log(`could not create D1 database "${DB_NAME}" — create it manually and paste its id into wrangler.toml (DEPLOY.md §5)`);
  return null;
}

function provisionKV() {
  const list = runWrangler(['kv', 'namespace', 'list']);
  if (list.ok) {
    const blocks = String(list.out).split(/\n\s*\n/);
    const hit = blocks.find((b) => new RegExp(`title\\s*=\\s*"${KV_TITLE}"`).test(b) || new RegExp(`"${KV_TITLE}-[0-9a-f]+"`).test(b));
    const id = kvIdOf(hit || '');
    if (id) return id;
  }
  const created = runWrangler(['kv', 'namespace', 'create', KV_TITLE]);
  const id = kvIdOf(created.out + created.err);
  if (id) return id;
  log('could not create KV namespace CACHE — uncomment [[kv_namespaces]] manually (DEPLOY.md §5)');
  return null;
}

function provisionR2() {
  const r = runWrangler(['r2', 'bucket', 'create', R2_BUCKET]);
  if (r.ok || existsErr(r)) return true;
  log('could not create R2 bucket fabric-roll-exports — uncomment [[r2_buckets]] manually (DEPLOY.md §5)');
  return false;
}

function provisionQueues() {
  for (const q of QUEUES) {
    const r = runWrangler(['queues', 'create', q]);
    if (!r.ok && !existsErr(r)) {
      log(`could not create queue "${q}" (${(r.err.split('\n').find((l) => l.trim()) || '').trim()}) — the app falls back to synchronous writes`);
      return false;
    }
  }
  return true;
}

// ---- config rewrite -------------------------------------------------------

export function rewriteConfig(text, p) {
  const gen = [];
  gen.push(p.d1
    ? `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${DB_NAME}"\ndatabase_id = "${p.d1}"\nmigrations_dir = "migrations"`
    : `# [[d1_databases]]\n# binding = "DB"\n# database_name = "${DB_NAME}"\n# database_id = "PASTE-DATABASE-ID"\n# migrations_dir = "migrations"`);
  gen.push(p.kv
    ? `[[kv_namespaces]]\nbinding = "CACHE"\nid = "${p.kv}"`
    : `# [[kv_namespaces]]\n# binding = "CACHE"\n# id = "PASTE-KV-NAMESPACE-ID"`);
  gen.push(p.r2
    ? `[[r2_buckets]]\nbinding = "EXPORTS"\nbucket_name = "${R2_BUCKET}"`
    : `# [[r2_buckets]]\n# binding = "EXPORTS"\n# bucket_name = "${R2_BUCKET}"`);
  const queueBlock = (p.queues
    ? `[[queues.producers]]\nbinding = "AUDIT_QUEUE"\nqueue = "audit-queue"\n\n` +
      QUEUES.slice(0, 3).map((q, i) => `[[queues.consumers]]\nqueue = "${q}"\nmax_retries = 3\ndead_letter_queue = "${QUEUES[i + 3]}"`).join('\n\n') +
      `\n\n` + QUEUES.slice(3).map((q) => `[[queues.consumers]]\nqueue = "${q}"\nmax_retries = 0`).join('\n\n')
    : `# [[queues.producers]]\n# binding = "AUDIT_QUEUE"\n# queue = "audit-queue"`);
  gen.push(queueBlock);
  const body = `\n\n${START}\n\n${gen.join('\n\n')}\n\n${END}\n`;
  const re = new RegExp(`${START}[\\s\\S]*?${END}\\n?`);
  if (!re.test(text)) throw new Error(`wrangler.toml is missing the ${START} … ${END} markers`);
  return text.replace(re, body.trimStart());
}

// ---- migrations -----------------------------------------------------------

function applyMigrations() {
  const r = runWrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
  if (r.ok) { log('migrations applied (idempotent — tracked in d1_migrations)'); return; }
  const probe = runWrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', 'SELECT COUNT(*) AS n FROM users']);
  const n = Number((probe.out.match(/"n"\s*:\s*(\d+)/) || [null, 0])[1]);
  if (n > 0) { log('migrations skipped — users table already seeded'); return; }
  log(`migrations failed — run manually: npx wrangler d1 migrations apply ${DB_NAME} --remote`);
}

// ---- entry ----------------------------------------------------------------

function selfTest() {
  const text = readFileSync(CONFIG, 'utf8');
  const fake = { d1: '00000000-0000-0000-0000-000000000001', kv: 'a'.repeat(32), r2: true, queues: true };
  const out = rewriteConfig(text, fake);
  const checks = [
    out.includes('database_id = "00000000-0000-0000-0000-000000000001"'),
    /^\[\[kv_namespaces\]\]$/m.test(out),
    /^\[\[r2_buckets\]\]$/m.test(out),
    (out.match(/^\[\[queues\.consumers\]\]$/gm) || []).length === 6,
    out.includes(START) && out.includes(END),
    rewriteConfig(text, { d1: null, kv: null, r2: false, queues: false }).includes('# [[d1_databases]]'),
  ];
  if (checks.every(Boolean)) { log('self-test ok'); process.exit(0); }
  log(`self-test FAILED (${checks.filter(Boolean).length}/${checks.length} checks passed)`);
  process.exit(1);
}

function main() {
  if (SELF_TEST) return selfTest();
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    log('no CLOUDFLARE_API_TOKEN in environment — skipping automatic provisioning (manual setup: DEPLOY.md §5)');
    return;
  }
  log('CLOUDFLARE_API_TOKEN present — provisioning resources…');
  const p = {};
  p.d1 = provisionD1(); if (p.d1) log(`D1 ${DB_NAME}: ${p.d1}`);
  p.kv = provisionKV(); if (p.kv) log(`KV CACHE: ${p.kv}`);
  p.r2 = provisionR2(); if (p.r2) log(`R2 ${R2_BUCKET}: ok`);
  p.queues = provisionQueues(); if (p.queues) log('queues: ok');
  const text = readFileSync(CONFIG, 'utf8');
  const next = rewriteConfig(text, p);
  if (DRY) { log('dry-run — not writing wrangler.toml, not applying migrations'); console.log(next); return; }
  writeFileSync(CONFIG, next);
  log('wrangler.toml bindings written');
  if (p.d1) applyMigrations();
  log('done — the following `wrangler deploy` uses these bindings');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

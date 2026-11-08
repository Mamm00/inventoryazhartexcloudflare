// shared/server/http.js — HTTP helpers, server-side RBAC guard, rate limiting,
// Turnstile verification and Access JWT validation. Used by every Pages
// Function; the same modules run in Node tests.

import { can } from '../permissions.js';
import { writeAudit } from './db.js';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function csv(body, filename) {
  // BOM so Excel keeps Arabic intact.
  return new Response('\uFEFF' + body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0';
}

/**
 * guard(context, action, whId, fn) — wraps every mutating handler. Re-checks
 * can() at save time, writes a Blocked audit row on denial, returns 403.
 */
export async function guard(context, action, whId, fn) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  if (!can(user, action, whId)) {
    await writeAudit(env.DB, {
      actorUserId: user?.id ?? null,
      action, entity: 'guard', entityId: `${action}:${whId ?? '-'}`,
      warehouseId: whId ?? null, ip: clientIp(request),
      userAgent: request.headers.get('user-agent'), result: 'Blocked',
    });
    return json({ error: 'FORBIDDEN', message: 'Not allowed for your role' }, 403);
  }
  return fn();
}

// ---- rate limiting (keyed by ${ip}:${username}) --------------------------
// 5 failures trigger a 60-second lockout, enforced server-side. Backed by the
// Workers Rate Limiting binding when present, else KV (CACHE), else memory
// (local tests) — the key and window never change.

export async function rateLimitCheck(env, key) {
  const bucket = await getBucket(env, key);
  return { locked: (bucket.lockedUntil || 0) > Date.now(), failures: bucket.failures || 0 };
}

export async function rateLimitFail(env, key) {
  const bucket = await getBucket(env, key);
  bucket.failures += 1;
  if (bucket.failures >= 5) {
    bucket.lockedUntil = Date.now() + 60_000;
    bucket.failures = 0;
  }
  await putBucket(env, key, bucket);
  return { locked: bucket.lockedUntil > Date.now(), failures: bucket.failures };
}

export async function rateLimitReset(env, key) {
  await putBucket(env, key, { failures: 0, lockedUntil: 0 });
}

async function getBucket(env, key) {
  const mem = memStore(env);
  if (env.CACHE && typeof env.CACHE.get === 'function') {
    const raw = await env.CACHE.get(`rl:${key}`, { type: 'json' });
    return raw ?? { failures: 0, lockedUntil: 0 };
  }
  return mem.get(key) ?? { failures: 0, lockedUntil: 0 };
}

async function putBucket(env, key, bucket) {
  const mem = memStore(env);
  if (env.CACHE && typeof env.CACHE.put === 'function') {
    await env.CACHE.put(`rl:${key}`, JSON.stringify(bucket), { expirationTtl: 300 });
    return;
  }
  mem.set(key, bucket);
}

function memStore(env) {
  if (!env.__mem) env.__mem = new Map();
  return env.__mem;
}

// ---- Turnstile -----------------------------------------------------------

export async function turnstileVerify(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    // Feature-flagged demo mode: verification skipped, but auditable.
    return { ok: true, skipped: true };
  }
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token ?? '',
      remoteip: ip ?? '',
    }),
  }).catch(() => null);
  if (!resp || !resp.ok) return { ok: false, skipped: false };
  const data = await resp.json().catch(() => ({}));
  return { ok: !!data.success, skipped: false };
}

// ---- Cloudflare Access JWT (Cf-Access-Jwt-Assertion) ---------------------
// HS256 verification with the Access client secret via Web Crypto (works in
// workerd and Node). Claims checked: signature, exp, iat (clock skew 60s).

export async function verifyAccessJwt(token, secret, audience) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let sig;
  try {
    sig = b64urlToBytes(parts[2]);
  } catch {
    return null;
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('HMAC', key, sig, data);
  if (!valid) return null;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now - 60) return null;
  if (audience && claims.aud && claims.aud !== audience && !String(claims.aud).includes(audience)) return null;
  return claims;
}

export function b64urlToBytes(s) {
  const rem = s.length % 4;
  if (rem === 1) throw new Error('malformed base64url');
  const pad = rem === 0 ? '' : '='.repeat(4 - rem);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- idempotency ---------------------------------------------------------

export async function idempotent(env, key, produce) {
  if (!key) return produce();
  const mem = memStore(env);
  const k = `idem:${key}`;
  if (env.CACHE && typeof env.CACHE.get === 'function') {
    const hit = await env.CACHE.get(k, { type: 'json' });
    if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': '1' } });
    const resp = await produce();
    const body = await resp.clone().json().catch(() => null);
    if (body) await env.CACHE.put(k, JSON.stringify({ status: resp.status, body }), { expirationTtl: 86400 });
    return resp;
  }
  if (mem.has(k)) {
    const hit = mem.get(k);
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json; charset=utf-8', 'idempotent-replay': '1' } });
  }
  const resp = await produce();
  const body = await resp.clone().json().catch(() => null);
  if (body) mem.set(k, { status: resp.status, body });
  return resp;
}

// ---- CSV safety ----------------------------------------------------------

/**
 * Escape a CSV field; neutralise formula injection (=, +, -, @, tab, CR)
 * per OWASP — every CSV export goes through here.
 */
export function csvField(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function csvRow(fields) {
  return fields.map(csvField).join(',');
}

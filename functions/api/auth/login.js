// POST /api/auth/login — Turnstile-protected, rate-limited (5 failures / 60s
// lockout keyed by ${ip}:${username}), PBKDF2-SHA256 verification against D1.
// Every attempt is audited.

import { getUserByUsername, createSession, recordLoginAttempt, writeAudit } from '../../../shared/server/db.js';
import { json, readBody, clientIp, rateLimitCheck, rateLimitFail, rateLimitReset, turnstileVerify } from '../../../shared/server/http.js';

const SESSION_HOURS = 12;

async function verifyPassword(password, stored) {
  // Format: pbkdf2_sha256$<iters>$<salt hex>$<hash hex>
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const [, iters, saltHex, hashHex] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16))), iterations: Number(iters) },
    key, 256
  );
  const out = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return out === hashHex;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const ip = clientIp(request);
  const body = await readBody(request);
  const username = String(body.username || '');
  const password = String(body.password || '');
  const rlKey = `${ip}:${username}`;

  const locked = await rateLimitCheck(env, rlKey);
  if (locked.locked) {
    await auditLogin(env, username, ip, 'Locked');
    return json({ error: 'LOCKED', message: 'Too many attempts — locked for 60 seconds' }, 429);
  }

  const ts = await turnstileVerify(env, body.turnstileToken, ip);
  if (!ts.ok) {
    await auditLogin(env, username, ip, 'TurnstileFailed');
    return json({ error: 'TURNSTILE', message: 'Turnstile check failed' }, 403);
  }

  const user = await getUserByUsername(env.DB, username);
  const ok = user && user.active === 1 && await verifyPassword(password, user.password_hash);
  if (!ok) {
    await rateLimitFail(env, rlKey);
    await auditLogin(env, username, ip, 'BadCredentials');
    return json({ error: 'BAD_CREDENTIALS', message: 'Wrong username or password' }, 401);
  }

  await rateLimitReset(env, rlKey);
  const sessionId = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await createSession(env.DB, sessionId, user.id, expires, ip, request.headers.get('user-agent'));
  await recordLoginAttempt(env.DB, crypto.randomUUID(), username, ip, true);
  await writeAudit(env.DB, {
    actorUserId: user.id, action: 'auth.login', entity: 'session', entityId: sessionId,
    ip, userAgent: request.headers.get('user-agent'),
    result: ts.skipped ? 'OK (turnstile skipped)' : 'OK',
  });

  return json({
    user: {
      id: user.id, username: user.username, role: user.role,
      warehouseIds: JSON.parse(user.warehouse_ids),
      displayNameAr: user.display_name_ar, displayNameEn: user.display_name_en,
    },
  }, 200, {
    'set-cookie': `frs_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
  });
}

async function auditLogin(env, username, ip, result) {
  await recordLoginAttempt(env.DB, crypto.randomUUID(), username, ip, result === 'OK');
  await writeAudit(env.DB, {
    action: 'auth.login', entity: 'session', entityId: username,
    ip, result: result === 'OK' ? 'OK' : `Blocked (${result})`,
  });
}

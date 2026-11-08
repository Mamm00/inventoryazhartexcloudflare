// functions/api/_middleware.js — auth gate for every /api/* route.
// Session cookie (D1, 12h, revoked on logout) or Cloudflare Access JWT
// (Cf-Access-Jwt-Assertion). Login and health are unauthenticated.

import { getSession } from '../../shared/server/db.js';
import { verifyAccessJwt, json, clientIp } from '../../shared/server/http.js';

const OPEN_PATHS = new Set(['/api/auth/login', '/api/auth/setup', '/api/health']);

export async function onRequest(context, next) {
  const { request, env } = context;
  // Pages calls middleware with one argument (context.next()); tests pass a
  // next callback as the second argument. Support both.
  const nxt = typeof next === 'function' ? next : () => context.next();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (OPEN_PATHS.has(path)) {
    return nxt();
  }

  // 1) Session cookie
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)frs_session=([^;]+)/);
  if (m) {
    const session = await getSession(env.DB, m[1]);
    if (session && session.user_active === 1 && session.expires_at > new Date().toISOString()) {
      const userObj = {
        id: session.user_id,
        username: session.username,
        role: session.role,
        warehouseIds: JSON.parse(session.warehouse_ids),
        displayNameAr: session.display_name_ar,
        displayNameEn: session.display_name_en,
        auth: 'session',
      };
      context.user = userObj;
      // Pages builds a fresh context per stage; context.data is the shared bag.
      context.data = context.data && typeof context.data === 'object' ? context.data : {};
      context.data.user = userObj;
      return nxt();
    }
  }

  // 2) Cloudflare Access JWT
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (jwt && env.ACCESS_CLIENT_SECRET) {
    const claims = await verifyAccessJwt(jwt, env.ACCESS_CLIENT_SECRET, env.ACCESS_AUD);
    if (claims) {
      const { getUserByUsername } = await import('../../shared/server/db.js');
      const u = await getUserByUsername(env.DB, claims.email || claims.sub || '');
      if (u && u.active === 1) {
        const accessUser = {
          id: u.id, username: u.username, role: u.role,
          warehouseIds: JSON.parse(u.warehouse_ids),
          displayNameAr: u.display_name_ar, displayNameEn: u.display_name_en,
          auth: 'access',
        };
        context.user = accessUser;
        context.data = context.data && typeof context.data === 'object' ? context.data : {};
        context.data.user = accessUser;
        return nxt();
      }
    }
    return json({ error: 'UNAUTHORIZED', message: 'Cloudflare Access assertion required or invalid' }, 403);
  }

  return json({ error: 'UNAUTHORIZED', message: 'Sign in required' }, 403, {
    'www-authenticate': 'Cookie realm="fabric-roll-stock"',
  });
}

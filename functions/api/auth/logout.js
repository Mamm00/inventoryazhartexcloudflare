// POST /api/auth/logout — revoke the D1 session.

import { deleteSession, writeAudit } from '../../../shared/server/db.js';
import { json } from '../../../shared/server/http.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)frs_session=([^;]+)/);
  if (m) await deleteSession(env.DB, m[1]);
  await writeAudit(env.DB, {
    actorUserId: user?.id ?? null, action: 'auth.logout', entity: 'session',
    entityId: user?.id ?? '-', result: 'OK',
  });
  return json({ ok: true }, 200, {
    'set-cookie': 'frs_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
  });
}

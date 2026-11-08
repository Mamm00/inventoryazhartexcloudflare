// GET /api/audit — paginated audit log including Blocked rows:
// who · when · what · before → after per field.

import { json } from '../../../shared/server/http.js';
import { listAudit } from '../../../shared/server/db.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const rows = await listAudit(env.DB, limit, offset);
  return json({ rows, limit, offset });
}

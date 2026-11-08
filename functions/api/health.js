// GET /api/health — liveness probe (acceptance: returns 200).

import { json } from '../../shared/server/http.js';
import { countRecords } from '../../shared/server/db.js';

export async function onRequestGet(context) {
  let records = null;
  try {
    records = await countRecords(context.env.DB);
  } catch {
    records = null;
  }
  return json({ ok: true, service: 'fabric-roll-stock', records });
}

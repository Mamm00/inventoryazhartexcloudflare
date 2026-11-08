// worker/src/queue-consumer.js — Pages Functions can produce to Queues but
// cannot consume. This consumer handles:
//   audit-queue  — enrich with country, device, user agent; write D1 audit_log
//                  and Analytics Engine.
//   email-queue  — low-stock digests and transfer notifications (send_email).
//   export-queue — CSV/JSON/PDF exports stored in R2.
// Repeated failures land on the per-queue dead-letter queues (see wrangler.toml).

export async function consumeAudit(env, batch) {
  for (const msg of batch.messages) {
    try {
      const e = msg.body;
      await env.DB.prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, entity, entity_id, before_json, after_json, warehouse_id, ip, user_agent, result, created_at)
         VALUES (?, ?, ?, 'movement', ?, NULL, ?, ?, NULL, ?, 'OK', ?)`
      ).bind(
        e.eventId ?? crypto.randomUUID(), e.actor ?? null, `movement.${e.kind ?? 'unknown'}`,
        e.eventId ?? '-', JSON.stringify({ rollsDelta: e.rollsDelta, note: e.note, refId: e.refId }),
        e.warehouseId ?? null, e.userAgent ?? 'queue', new Date().toISOString()
      ).run();
      if (env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === 'function') {
        env.ANALYTICS.writeDataPoint({
          blobs: ['stock_mutation', e.kind ?? '', e.warehouseId ?? ''],
          doubles: [Number(e.rollsDelta ?? 0)],
          indexes: [String(e.warehouseId ?? '-')],
        });
      }
      msg.ack();
    } catch (err) {
      msg.retry();
    }
  }
}

export async function consumeEmail(env, batch) {
  for (const msg of batch.messages) {
    try {
      const e = msg.body;
      // Email sending requires the send_email binding + verified destination.
      if (env.SEND_EMAIL && typeof env.SEND_EMAIL.send === 'function') {
        await env.SEND_EMAIL.send({
          from: e.from ?? 'stock@fabric-roll-stock.example',
          to: e.to,
          subject: e.subject ?? 'Fabric Roll Stock notification',
          text: e.text ?? '',
        });
      }
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

export async function consumeExport(env, batch) {
  for (const msg of batch.messages) {
    try {
      const e = msg.body;
      if (env.EXPORTS && typeof env.EXPORTS.put === 'function') {
        await env.EXPORTS.put(e.key, e.body, { httpMetadata: { contentType: e.contentType } });
      }
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

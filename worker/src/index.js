// worker/src/index.js — companion Worker entry: Durable Object fetch router,
// queue consumer fan-out, cron triggers. Deploy with: cd worker && wrangler deploy

import { WarehouseLedger } from './ledger-do.js';
import { consumeAudit, consumeEmail, consumeExport } from './queue-consumer.js';
import { scheduled } from './cron.js';

export { WarehouseLedger };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'fabric-roll-ledger-worker' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // /apply/:warehouse routes to that warehouse's ledger shard (used when a
    // Function reaches the DO through a service binding without idFromName).
    const m = url.pathname.match(/^\/apply\/([^/]+)$/);
    if (m && request.method === 'POST') {
      const stub = env.WAREHOUSE_LEDGER.get(env.WAREHOUSE_LEDGER.idFromName(decodeURIComponent(m[1])));
      return stub.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },

  async queue(batch, env) {
    switch (batch.queue) {
      case 'audit-queue': return consumeAudit(env, batch);
      case 'email-queue': return consumeEmail(env, batch);
      case 'export-queue': return consumeExport(env, batch);
      default:
        for (const msg of batch.messages) msg.ack(); // DLQ: acknowledged, retained for inspection
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, ctx));
  },
};

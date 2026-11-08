// worker/src/app.js — the full application entry deployed by `npx wrangler
// deploy` (the CI's user deploy command). One worker serves:
//   - the static SPA from [assets] (app/ — only /api/* runs first)
//   - /api/* via the exact Pages Function modules (functions/api/**)
//   - the WarehouseLedger Durable Object (per-warehouse mutation serialisation)
//   - queue consumers (audit / email / export + DLQs) and cron triggers
// The split companion entry (worker/src/index.js) remains deployable on its
// own for the two-worker topology described in DEPLOY.md.

import { WarehouseLedger } from './ledger-do.js';
import { consumeAudit, consumeEmail, consumeExport } from './queue-consumer.js';
import { scheduled } from './cron.js';
import { handleApi } from './api-router.js';

export { WarehouseLedger };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'fabric-roll-stock' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    // Assets-first config routes only /api/* here; anything else that reaches
    // the worker is an asset miss — fall back to the asset server (404 page).
    return env.ASSETS.fetch(request);
  },

  async queue(batch, env) {
    switch (batch.queue) {
      case 'audit-queue': return consumeAudit(env, batch);
      case 'email-queue': return consumeEmail(env, batch);
      case 'export-queue': return consumeExport(env, batch);
      default:
        for (const msg of batch.messages) msg.ack(); // DLQ: acknowledged, retained
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env, ctx));
  },
};

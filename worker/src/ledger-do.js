// worker/src/ledger-do.js — Durable Object WarehouseLedger: serialises every
// stock mutation per warehouse and prevents negative stock. The apply logic
// lives in shared/ledger-core.js so the Pages Functions fallback and the test
// suites execute the identical code path.

import { applyMutation } from '../../shared/ledger-core.js';

export class WarehouseLedger {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const body = await request.json();
    return this.state.blockConcurrencyWhile(() => this.apply(body));
  }

  async apply(body) {
    const result = await applyMutation(this.env, body);
    return Response.json(result, { status: result.ok ? 200 : (result.status ?? 400) });
  }
}

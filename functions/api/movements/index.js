// GET /api/movements — recent events in scope.
// POST /api/movements — In · Out · Transfer · Adjustment.
//   - Transfer needs both sheds and touches two Durable Objects (sender first;
//     receiver failure compensates with a reversal event — company total
//     unchanged). The destination list is deliberately unscoped.
//   - Adjustment is signed.
//   - Negative stock is refused with a message naming the combination and the
//     shortfall — never silently clipped.

import { json, readBody, guard, idempotent, clientIp } from '../../../shared/server/http.js';
import { listEvents, getFabric, writeAudit } from '../../../shared/server/db.js';
import { applyMutation, applyTransfer } from '../../../shared/ledger-core.js';
import { can, resolveScope, isDestinationOnly } from '../../../shared/permissions.js';

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const all = (await env.DB.prepare(`SELECT id FROM warehouses`).all()).results.map((r) => r.id);
  const scope = resolveScope(user, all);
  const events = await listEvents(env.DB, { limit: 100, warehouseIds: scope });
  return json({ events, scope });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const body = await readBody(request);
  const kind = String(body.kind || '');
  return idempotent(env, request.headers.get('idempotency-key'), async () => {
    if (kind === 'transfer') {
      return guard(context, 'movement.create', body.fromWarehouseId, async () => {
        // Destination is checked with the destination-only action: the list is
        // deliberately unscoped, and the receiver shard accepts the event.
        if (!can(user, 'transfer.receive', body.toWarehouseId)) {
          await writeAudit(env.DB, {
            actorUserId: user.id, action: 'movement.create', entity: 'movement',
            entityId: 'transfer', warehouseId: body.toWarehouseId,
            ip: clientIp(request), result: 'Blocked',
          });
          return json({ error: 'FORBIDDEN', message: 'Not allowed for your role' }, 403);
        }
        return runTransfer(context, body);
      });
    }
    return guard(context, 'movement.create', body.warehouseId, async () => runMutation(context, body, kind));
  });
}

async function ledgerCall(env, body) {
  // Prefer the companion Worker's Durable Object (serialises mutations per
  // warehouse); fall back to the identical shared implementation when the
  // service binding is not attached or not reachable (local dev / tests).
  try {
    if (env.WAREHOUSE_LEDGER && typeof env.WAREHOUSE_LEDGER.idFromName === 'function'
      && typeof env.WAREHOUSE_LEDGER.get === 'function') {
      const stub = env.WAREHOUSE_LEDGER.get(env.WAREHOUSE_LEDGER.idFromName(body.warehouseId));
      const resp = await stub.fetch('https://ledger/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ...(await resp.json()), _status: resp.status };
    }
  } catch {
    // Binding exists but is not connected (e.g. companion Worker not running
    // in wrangler pages dev) — apply through the shared implementation.
  }
  return applyMutation(env, body);
}

async function runMutation(context, body, kind) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  const rolls = Number(body.rolls);
  let delta = rolls;
  if (kind === 'out') delta = -Math.abs(rolls);
  else if (kind === 'adjustment') delta = rolls; // signed
  else delta = Math.abs(rolls);
  const result = await ledgerCall(env, {
    kind: kind === 'in' ? 'in' : kind === 'out' ? 'out' : 'adjustment',
    warehouseId: body.warehouseId, fabricId: body.fabricId, colorId: body.colorId,
    rollsDelta: delta, actor: { id: user.id }, note: body.note ?? null,
    effectiveDate: body.effectiveDate || undefined,
  });
  return respond(context, body, result, kind);
}

async function runTransfer(context, body) {
  const { env } = context;
  const user = context.data?.user ?? context.user;
  const n = Number(body.rolls);
  const refId = crypto.randomUUID();
  const common = {
    fabricId: body.fabricId, colorId: body.colorId, actor: { id: user.id },
    note: body.note ?? null, effectiveDate: body.effectiveDate || undefined,
  };
  // Sender's DO first.
  const outRes = await ledgerCall(env, {
    ...common, kind: 'transfer_out', warehouseId: body.fromWarehouseId, rollsDelta: -n, refId,
  });
  if (!outRes.ok) return respond(context, body, outRes, 'transfer');
  // Receiver's DO second.
  const inRes = await ledgerCall(env, {
    ...common, kind: 'transfer_in', warehouseId: body.toWarehouseId, rollsDelta: n, refId,
  });
  if (!inRes.ok) {
    const rev = await ledgerCall(env, {
      ...common, kind: 'adjustment', warehouseId: body.fromWarehouseId, rollsDelta: n,
      note: `transfer_out_reversal for ${refId}: ${inRes.error}`, refId,
    });
    await writeAudit(env.DB, {
      actorUserId: user.id, action: 'transfer_compensated', entity: 'transfer', entityId: refId,
      beforeJson: JSON.stringify({ out: outRes }), afterJson: JSON.stringify({ in: inRes, reversal: rev }),
      warehouseId: body.fromWarehouseId, result: 'Blocked',
    });
    return json({
      ok: false, error: 'TRANSFER_IN_FAILED',
      message: `Receiver failed (${inRes.error}); sender compensated — company total unchanged`,
      compensated: true, refId,
    }, 409);
  }
  await writeAudit(env.DB, {
    actorUserId: user.id, action: 'movement.create', entity: 'transfer', entityId: refId,
    afterJson: JSON.stringify({ from: outRes.closingRolls, to: inRes.closingRolls }),
    warehouseId: body.fromWarehouseId, result: 'OK',
  });
  return json({ ok: true, refId, from: outRes.closingRolls, to: inRes.closingRolls });
}

async function respond(context, body, result, kind) {
  const { env, request } = context;
  const user = context.data?.user ?? context.user;
  if (!result.ok) {
    await writeAudit(env.DB, {
      actorUserId: user.id, action: 'movement.create', entity: 'movement',
      entityId: result.eventId ?? `${body.warehouseId}:${body.fabricId}:${body.colorId}`,
      warehouseId: body.warehouseId, ip: clientIp(request),
      afterJson: JSON.stringify({ error: result.error, message: result.message }),
      result: `Blocked (${result.error})`,
    });
    return json({
      ok: false, error: result.error, message: result.message,
      after: result.after, shortfall: result.shortfall,
    }, result.status ?? 400);
  }
  const fabric = await getFabric(env.DB, body.fabricId);
  await writeAudit(env.DB, {
    actorUserId: user.id, action: 'movement.create', entity: 'movement', entityId: result.eventId,
    afterJson: JSON.stringify({ kind, rolls: body.rolls, closing: result.closingRolls }),
    warehouseId: body.warehouseId, ip: clientIp(request), result: 'OK',
  });
  return json({
    ok: true, eventId: result.eventId, closingRolls: result.closingRolls,
    metersPerRoll: fabric?.meters_per_roll ?? 0,
  });
}

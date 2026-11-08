// shared/ledger-core.js — the single implementation of a stock mutation.
// Used by worker/src/ledger-do.js (inside blockConcurrencyWhile), by Pages
// Functions when the DO binding is not yet attached, and by the test suites.
// A row that would drive closing below zero is refused — never clipped.

import { checkNonNegative } from './stock-math.js';

export const MUTATION_KINDS = ['in', 'out', 'transfer_out', 'transfer_in', 'adjustment'];

/**
 * applyMutation(env, body) → { ok, closingRolls, eventId } | { ok:false, error, message, status }
 * body: { kind, warehouseId, fabricId, colorId, rollsDelta, actor:{id}, note, refId, effectiveDate }
 */
export async function applyMutation(env, body) {
  const { kind, warehouseId, fabricId, colorId, rollsDelta, actor, note = null, refId = null } = body;
  const effectiveDate = body.effectiveDate || new Date().toISOString().slice(0, 10);
  if (!MUTATION_KINDS.includes(kind)) {
    return { ok: false, error: 'BAD_KIND', message: `Unknown kind ${kind}`, status: 400 };
  }
  if (!Number.isInteger(rollsDelta)) {
    return { ok: false, error: 'BAD_DELTA', message: 'rollsDelta must be an integer', status: 400 };
  }

  const current = await env.DB.prepare(
    `SELECT closing_rolls FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(warehouseId, fabricId, colorId).first();
  const before = current?.closing_rolls ?? 0;

  const chk = checkNonNegative(before, rollsDelta);
  if (!chk.ok) {
    return {
      ok: false,
      error: 'NEGATIVE_STOCK',
      message: `Closing would be ${chk.after}; shortfall ${chk.shortfall} roll(s)`,
      after: chk.after,
      shortfall: chk.shortfall,
      status: 409,
    };
  }

  const mapping = await env.DB.prepare(
    `SELECT id, active FROM mappings WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(warehouseId, fabricId, colorId).first();
  if (!mapping || !mapping.active) {
    return { ok: false, error: 'UNMAPPED', message: 'No active mapping for that combination', status: 422 };
  }

  const fabric = await env.DB.prepare(
    `SELECT meters_per_roll, unit_cost_per_roll FROM fabrics WHERE id=?`
  ).bind(fabricId).first();
  const metersPerRoll = fabric?.meters_per_roll ?? 0;
  const costPerRoll = fabric?.unit_cost_per_roll ?? 0;

  const eventId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const metersDelta = rollsDelta * metersPerRoll;
  const valueDelta = rollsDelta * costPerRoll;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stock_events (id, warehouse_id, fabric_id, color_id, kind, rolls_delta, meters_delta, value_delta, ref_id, note, actor_user_id, created_at, effective_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, warehouseId, fabricId, colorId, kind, rollsDelta, metersDelta, valueDelta, refId, note, actor.id, createdAt, effectiveDate),
    env.DB.prepare(
      `INSERT INTO stock_current (warehouse_id, fabric_id, color_id, opening_rolls, rolls_in, rolls_out, closing_rolls)
       VALUES (?, ?, ?, 0, MAX(?,0), MAX(?,0), ?)
       ON CONFLICT(warehouse_id, fabric_id, color_id) DO UPDATE SET
         closing_rolls = closing_rolls + ?,
         rolls_in = rolls_in + MAX(?,0),
         rolls_out = rolls_out + MAX(?,0)`
    ).bind(warehouseId, fabricId, colorId, rollsDelta, -rollsDelta, chk.after,
      rollsDelta, rollsDelta, -rollsDelta),
  ]);

  if (env.AUDIT_QUEUE && typeof env.AUDIT_QUEUE.send === 'function') {
    try {
      await env.AUDIT_QUEUE.send({
        eventId, actor: actor.id, warehouseId, fabricId, colorId, kind, rollsDelta, note, refId,
      });
    } catch {
      // Queue unavailability must not lose the stock mutation; the audit_log
      // write in the consumer is best-effort enrichment.
    }
  }

  return { ok: true, closingRolls: chk.after, eventId, before };
}

/**
 * applyTransfer(env, body) — touches two ledger shards. The sender's shard is
 * called first; if the sender succeeds and the receiver fails, compensate with
 * a transfer_out_reversal event and an audit row. The company total must
 * remain unchanged.
 * body: { fromWarehouseId, toWarehouseId, fabricId, colorId, rolls, actor, note, effectiveDate }
 */
export async function applyTransfer(env, body) {
  const { fromWarehouseId, toWarehouseId, fabricId, colorId, rolls, actor, note = null } = body;
  const n = Number(rolls);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'BAD_ROLLS', message: 'rolls must be a positive integer', status: 400 };
  }
  const refId = crypto.randomUUID();
  const effectiveDate = body.effectiveDate || new Date().toISOString().slice(0, 10);

  const outRes = await applyMutation(env, {
    kind: 'transfer_out', warehouseId: fromWarehouseId, fabricId, colorId,
    rollsDelta: -n, actor, note, refId, effectiveDate,
  });
  if (!outRes.ok) return outRes;

  const inRes = await applyMutation(env, {
    kind: 'transfer_in', warehouseId: toWarehouseId, fabricId, colorId,
    rollsDelta: n, actor, note, refId, effectiveDate,
  });
  if (!inRes.ok) {
    // Compensate: reversal event on the sender + audit row. Company total
    // unchanged (the out never happened as far as stock is concerned).
    const rev = await applyMutation(env, {
      kind: 'adjustment', warehouseId: fromWarehouseId, fabricId, colorId,
      rollsDelta: n, actor, note: `transfer_out_reversal for ${refId}: ${inRes.error}`,
      refId, effectiveDate,
    });
    if (env.DB && typeof env.DB.prepare === 'function') {
      await env.DB.prepare(
        `INSERT INTO audit_log (id, actor_user_id, action, entity, entity_id, before_json, after_json, warehouse_id, ip, user_agent, result, created_at)
         VALUES (?, ?, 'transfer_compensated', 'transfer', ?, ?, ?, ?, NULL, NULL, 'Blocked', ?)`
      ).bind(crypto.randomUUID(), actor?.id ?? null, refId,
        JSON.stringify({ out: outRes }), JSON.stringify({ in: inRes, reversal: rev }),
        fromWarehouseId, new Date().toISOString()).run();
    }
    return {
      ok: false, error: 'TRANSFER_IN_FAILED',
      message: `Receiver failed (${inRes.error}); sender compensated`,
      compensated: true, status: 409,
    };
  }
  return {
    ok: true, refId,
    from: { closingRolls: outRes.closingRolls },
    to: { closingRolls: inRes.closingRolls },
  };
}

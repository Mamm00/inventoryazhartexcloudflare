// shared/server/db.js — D1 query layer. Every function takes the D1-compatible
// `db` binding first (env.DB), so the same code runs against Cloudflare D1 and
// against the local better-sqlite3 adapter in tests. getStock() is a SQL query
// over stock_events (with stock_current for the hot path).

import { utilization, statusOf, totalMeters, totalValue, reorderQty } from '../stock-math.js';

const rows = (p) => p.then((r) => (r && Array.isArray(r.results) ? r.results : r));

// ---- auth ----------------------------------------------------------------

export function getUserByUsername(db, username) {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();
}

export function getUser(db, id) {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
}

export function listUsers(db) {
  return rows(db.prepare(`SELECT id, username, display_name_ar, display_name_en, role, warehouse_ids, active FROM users ORDER BY username`).all());
}

export function createSession(db, id, userId, expiresAt, ip, userAgent) {
  return db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, new Date().toISOString(), expiresAt, ip ?? null, userAgent ?? null).run();
}

export function getSession(db, id) {
  return db.prepare(
    `SELECT s.*, u.username, u.role, u.warehouse_ids, u.display_name_ar, u.display_name_en, u.active AS user_active
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(id).first();
}

export function deleteSession(db, id) {
  return db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
}

export function expireSessions(db, nowIso) {
  return db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso).run();
}

export function recordLoginAttempt(db, id, username, ip, success) {
  return db.prepare(
    `INSERT INTO login_attempts (id, username, ip, success, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, username, ip ?? null, success ? 1 : 0, new Date().toISOString()).run();
}

// ---- masters -------------------------------------------------------------

export function listWarehouses(db) {
  return rows(db.prepare(`SELECT * FROM warehouses WHERE active = 1 ORDER BY id`).all());
}

export function listAllWarehouses(db) {
  return rows(db.prepare(`SELECT * FROM warehouses ORDER BY id`).all());
}

export function getWarehouse(db, id) {
  return db.prepare(`SELECT * FROM warehouses WHERE id = ?`).bind(id).first();
}

export function listFabrics(db) {
  return rows(db.prepare(`SELECT * FROM fabrics ORDER BY id`).all());
}

export function listColors(db) {
  return rows(db.prepare(`SELECT * FROM colors ORDER BY id`).all());
}

export function getFabric(db, id) {
  return db.prepare(`SELECT * FROM fabrics WHERE id = ?`).bind(id).first();
}

export function getColor(db, id) {
  return db.prepare(`SELECT * FROM colors WHERE id = ?`).bind(id).first();
}

export function listMappings(db, where = '', bind = []) {
  const sql = `SELECT m.*, w.name_ar AS wh_name_ar, w.name_en AS wh_name_en,
       f.name_ar AS fab_name_ar, f.name_en AS fab_name_en, f.meters_per_roll, f.unit_cost_per_roll,
       c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex, c.family, c.grade
     FROM mappings m
     JOIN warehouses w ON w.id = m.warehouse_id
     JOIN fabrics f ON f.id = m.fabric_id
     JOIN colors c ON c.id = m.color_id
     ${where} ORDER BY m.warehouse_id, m.fabric_id, m.color_id`;
  return rows(db.prepare(sql).bind(...bind).all());
}

// ---- stock ---------------------------------------------------------------

/** Hot path: stock_current row (opening + in − out = closing). */
export function getStock(db, w, f, c) {
  return db.prepare(
    `SELECT * FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(w, f, c).first();
}

/**
 * Independent recompute over stock_events + opening — the spec's getStock
 * formula. Used by diagnostics and tests to verify stock_current.
 */
export async function getStockFromEvents(db, w, f, c) {
  const base = await db.prepare(
    `SELECT opening_rolls FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(w, f, c).first();
  const ev = await rows(db.prepare(
    `SELECT COALESCE(SUM(rolls_delta),0) AS net FROM stock_events WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(w, f, c).all());
  return (base?.opening_rolls ?? 0) + (ev[0]?.net ?? 0);
}

/** stockAsOf(w,f,c,date) — same as getStockFromEvents restricted to rows dated ≤ date. */
export async function stockAsOf(db, w, f, c, date) {
  const base = await db.prepare(
    `SELECT opening_rolls FROM stock_current WHERE warehouse_id=? AND fabric_id=? AND color_id=?`
  ).bind(w, f, c).first();
  const ev = await rows(db.prepare(
    `SELECT COALESCE(SUM(rolls_delta),0) AS net FROM stock_events
     WHERE warehouse_id=? AND fabric_id=? AND color_id=? AND effective_date <= ?`
  ).bind(w, f, c, date).all());
  return (base?.opening_rolls ?? 0) + (ev[0]?.net ?? 0);
}

/**
 * getWarehouseSummary(warehouseId) — fabric types / colours / rolls / metres /
 * value / low / utilisation / lastActivity over ACTIVE mappings only.
 * Spec: "over ACTIVE mappings only".
 */
export async function getWarehouseSummary(db, warehouseId) {
  const wh = await getWarehouse(db, warehouseId);
  if (!wh) return null;
  const agg = await db.prepare(
    `SELECT COUNT(DISTINCT m.fabric_id) AS fabric_types,
            COUNT(*) AS colors,
            COALESCE(SUM(s.closing_rolls), 0) AS rolls
     FROM mappings m
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE m.warehouse_id = ? AND m.active = 1`
  ).bind(warehouseId).first();
  const detail = await rows(db.prepare(
    `SELECT s.closing_rolls, f.meters_per_roll, f.unit_cost_per_roll,
            m.min_rolls, m.max_rolls
     FROM mappings m
     JOIN fabrics f ON f.id = m.fabric_id
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE m.warehouse_id = ? AND m.active = 1`
  ).bind(warehouseId).all());
  let meters = 0, value = 0, low = 0;
  for (const r of detail) {
    const closing = r.closing_rolls ?? 0;
    meters += totalMeters(closing, r.meters_per_roll ?? 0);
    value += totalValue(closing, r.unit_cost_per_roll ?? 0);
    const st = statusOf(closing, r.min_rolls ?? 0, r.max_rolls ?? 0);
    if (st === 'low' || st === 'out') low += 1;
  }
  const last = await db.prepare(
    `SELECT MAX(created_at) AS last_activity FROM stock_events WHERE warehouse_id = ?`
  ).bind(warehouseId).first();
  const rolls = agg?.rolls ?? 0;
  const cap = wh.capacity_rolls ?? 0;
  const util = utilization(rolls, cap);
  return {
    id: wh.id, name_ar: wh.name_ar, name_en: wh.name_en,
    keeper_user_id: wh.keeper_user_id, allowed_grades: wh.allowed_grades,
    grade_label_ar: wh.grade_label_ar,
    capacity_rolls: cap,
    fabric_types: agg?.fabric_types ?? 0,
    colors: agg?.colors ?? 0,
    rolls, meters, value, low_stock: low,
    utilization_pct: util.pct, utilization_band: util.band,
    last_activity: last?.last_activity ?? null,
  };
}

/** getFabricTypeSummary(wh, fab) — colours, rolls, metres, value, low/out. */
export async function getFabricTypeSummary(db, whId, fabId) {
  const fab = await getFabric(db, fabId);
  const detail = await rows(db.prepare(
    `SELECT m.color_id, m.min_rolls, m.max_rolls, m.active,
            COALESCE(s.closing_rolls, 0) AS closing_rolls
     FROM mappings m
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE m.warehouse_id = ? AND m.fabric_id = ?`
  ).bind(whId, fabId).all());
  let rolls = 0, low = 0, out = 0;
  for (const r of detail) {
    rolls += r.closing_rolls;
    const st = statusOf(r.closing_rolls, r.min_rolls ?? 0, r.max_rolls ?? 0);
    if (st === 'low') low += 1;
    if (st === 'out') out += 1;
  }
  return {
    warehouse_id: whId, fabric_id: fabId,
    name_ar: fab?.name_ar, name_en: fab?.name_en,
    meters_per_roll: fab?.meters_per_roll ?? 0,
    unit_cost_per_roll: fab?.unit_cost_per_roll ?? 0,
    colors: detail.length,
    rolls,
    meters: rolls * (fab?.meters_per_roll ?? 0),
    value: rolls * (fab?.unit_cost_per_roll ?? 0),
    low, out,
  };
}

/** colorUsageIndex() — unique (colour, shed) pairs over ALL mapping rows, inactive included. */
export async function colorUsageIndex(db) {
  const rs = await rows(db.prepare(
    `SELECT DISTINCT color_id, warehouse_id FROM mappings`
  ).all());
  const map = new Map();
  for (const r of rs) {
    if (!map.has(r.color_id)) map.set(r.color_id, []);
    map.get(r.color_id).push(r.warehouse_id);
  }
  return map;
}

/** countRecords() — includes keeperColorCodes, so a backup that drops them reads smaller. */
export async function countRecords(db) {
  const tables = ['warehouses', 'fabrics', 'colors', 'mappings', 'stock_events', 'stock_current', 'keeper_color_codes', 'users'];
  let total = 0;
  for (const t of tables) {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
    total += r?.n ?? 0;
  }
  return total;
}

// ---- inventory -----------------------------------------------------------

/** Inventory rows for a shed joined to labels; closing/metres/value/status included. */
export function listInventoryRows(db, whId, fabId = null) {
  const where = fabId
    ? `WHERE m.warehouse_id = ? AND m.fabric_id = ?`
    : `WHERE m.warehouse_id = ?`;
  const bind = fabId ? [whId, fabId] : [whId];
  return rows(db.prepare(
    `SELECT m.id AS mapping_id, m.warehouse_id, m.fabric_id, m.color_id, m.min_rolls, m.max_rolls, m.lead_time_days, m.active,
            f.name_ar AS fab_name_ar, f.name_en AS fab_name_en, f.meters_per_roll, f.unit_cost_per_roll,
            c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex, c.family, c.grade,
            COALESCE(s.opening_rolls,0) AS opening_rolls, COALESCE(s.rolls_in,0) AS rolls_in,
            COALESCE(s.rolls_out,0) AS rolls_out, COALESCE(s.closing_rolls,0) AS closing_rolls
     FROM mappings m
     JOIN fabrics f ON f.id = m.fabric_id
     JOIN colors c ON c.id = m.color_id
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     ${where} ORDER BY m.fabric_id, m.color_id`
  ).bind(...bind).all());
}

// ---- keeper codes --------------------------------------------------------

export function listKeeperCodes(db, keeperUserId = null) {
  if (keeperUserId) {
    return rows(db.prepare(
      `SELECT k.*, c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex
       FROM keeper_color_codes k LEFT JOIN colors c ON c.id = k.color_id
       WHERE k.keeper_user_id = ? ORDER BY k.custom_code`
    ).bind(keeperUserId).all());
  }
  return rows(db.prepare(
    `SELECT k.*, c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex
     FROM keeper_color_codes k LEFT JOIN colors c ON c.id = k.color_id
     ORDER BY k.keeper_user_id, k.custom_code`
  ).all());
}

/**
 * resolveKeeperCode — resolution order: exact match on customCode, then
 * case-insensitive customName, only among that user's own rows.
 */
export async function resolveKeeperCode(db, keeperUserId, query) {
  const exact = await db.prepare(
    `SELECT * FROM keeper_color_codes WHERE keeper_user_id = ? AND custom_code = ?`
  ).bind(keeperUserId, query).first();
  if (exact) return exact;
  const ci = await rows(db.prepare(
    `SELECT * FROM keeper_color_codes WHERE keeper_user_id = ? AND LOWER(custom_name) = LOWER(?)`
  ).bind(keeperUserId, query).all());
  return ci[0] ?? null;
}

// ---- audit ---------------------------------------------------------------

export function writeAudit(db, { id, actorUserId, action, entity, entityId, beforeJson, afterJson, warehouseId, ip, userAgent, result }) {
  return db.prepare(
    `INSERT INTO audit_log (id, actor_user_id, action, entity, entity_id, before_json, after_json, warehouse_id, ip, user_agent, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id ?? crypto.randomUUID(), actorUserId ?? null, action, entity, entityId ?? '',
    beforeJson ?? null, afterJson ?? null, warehouseId ?? null, ip ?? null, userAgent ?? null,
    result ?? 'OK', new Date().toISOString()).run();
}

export function listAudit(db, limit = 200, offset = 0) {
  return rows(db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all());
}

// ---- events / dashboard / reports ----------------------------------------

export function listEvents(db, { limit = 100, warehouseIds = null, kind = null } = {}) {
  const conds = [];
  const bind = [];
  if (warehouseIds && warehouseIds.length) {
    conds.push(`e.warehouse_id IN (${warehouseIds.map(() => '?').join(',')})`);
    bind.push(...warehouseIds);
  }
  if (kind) {
    conds.push(`e.kind = ?`);
    bind.push(kind);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return rows(db.prepare(
    `SELECT e.*, f.name_ar AS fab_name_ar, f.name_en AS fab_name_en,
            c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex,
            w.name_ar AS wh_name_ar, w.name_en AS wh_name_en,
            u.username AS actor_username
     FROM stock_events e
     JOIN fabrics f ON f.id = e.fabric_id
     JOIN colors c ON c.id = e.color_id
     JOIN warehouses w ON w.id = e.warehouse_id
     LEFT JOIN users u ON u.id = e.actor_user_id
     ${where} ORDER BY e.created_at DESC, e.id LIMIT ?`
  ).bind(...bind, limit).all());
}

/** Grade mix over active mappings with closing rolls (dashboard donut). */
export async function gradeMix(db, warehouseIds) {
  const scope = warehouseIds && warehouseIds.length ? warehouseIds : null;
  const conds = scope ? `m.warehouse_id IN (${scope.map(() => '?').join(',')}) AND ` : '';
  const bind = scope ? [...scope] : [];
  return rows(db.prepare(
    `SELECT c.grade, COALESCE(SUM(s.closing_rolls),0) AS rolls
     FROM mappings m JOIN colors c ON c.id = m.color_id
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE ${conds} m.active = 1 GROUP BY c.grade ORDER BY c.grade`
  ).bind(...bind).all());
}

/** Fabric mix (rolls per fabric) over active mappings. */
export async function fabricMix(db, warehouseIds) {
  const scope = warehouseIds && warehouseIds.length ? warehouseIds : null;
  const conds = scope ? `m.warehouse_id IN (${scope.map(() => '?').join(',')}) AND ` : '';
  const bind = scope ? [...scope] : [];
  return rows(db.prepare(
    `SELECT m.fabric_id, f.name_ar, f.name_en, COALESCE(SUM(s.closing_rolls),0) AS rolls
     FROM mappings m JOIN fabrics f ON f.id = m.fabric_id
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE ${conds} m.active = 1 GROUP BY m.fabric_id ORDER BY rolls DESC LIMIT 12`
  ).bind(...bind).all());
}

/** Top movers — most event activity in scope. */
export async function topMovers(db, warehouseIds, limit = 8) {
  const scope = warehouseIds && warehouseIds.length ? warehouseIds : null;
  const conds = scope ? `WHERE e.warehouse_id IN (${scope.map(() => '?').join(',')})` : '';
  const bind = scope ? [...scope] : [];
  return rows(db.prepare(
    `SELECT e.warehouse_id, e.fabric_id, e.color_id,
            w.name_ar AS wh_name_ar, w.name_en AS wh_name_en,
            f.name_ar AS fab_name_ar, f.name_en AS fab_name_en,
            c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex,
            COUNT(*) AS moves, SUM(ABS(e.rolls_delta)) AS rolled
     FROM stock_events e
     JOIN warehouses w ON w.id = e.warehouse_id
     JOIN fabrics f ON f.id = e.fabric_id
     JOIN colors c ON c.id = e.color_id
     ${conds}
     GROUP BY e.warehouse_id, e.fabric_id, e.color_id
     ORDER BY rolled DESC LIMIT ?`
  ).bind(...bind, limit).all());
}

/** Reorder list: closing ≤ min over active mappings. */
export async function reorderList(db, warehouseIds, limit = 20) {
  const scope = warehouseIds && warehouseIds.length ? warehouseIds : null;
  const conds = scope ? `m.warehouse_id IN (${scope.map(() => '?').join(',')}) AND ` : '';
  const bind = scope ? [...scope] : [];
  return rows(db.prepare(
    `SELECT m.warehouse_id, m.fabric_id, m.color_id, m.min_rolls,
            COALESCE(s.closing_rolls,0) AS closing_rolls,
            w.name_ar AS wh_name_ar, w.name_en AS wh_name_en,
            f.name_ar AS fab_name_ar, f.name_en AS fab_name_en,
            c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex
     FROM mappings m
     JOIN warehouses w ON w.id = m.warehouse_id
     JOIN fabrics f ON f.id = m.fabric_id
     JOIN colors c ON c.id = m.color_id
     LEFT JOIN stock_current s
       ON s.warehouse_id = m.warehouse_id AND s.fabric_id = m.fabric_id AND s.color_id = m.color_id
     WHERE ${conds} m.active = 1 AND COALESCE(s.closing_rolls,0) <= m.min_rolls
     ORDER BY (m.min_rolls - COALESCE(s.closing_rolls,0)) DESC LIMIT ?`
  ).bind(...bind, limit).all());
}

export { rows };

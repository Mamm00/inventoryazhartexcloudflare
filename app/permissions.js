// shared/permissions.js — server-side RBAC. Imported by Pages Functions, the
// Durable Object, and mirrored (untrusted) by the SPA for affordance only.
//
// Roles: Admin | WarehouseKeeper | SalesManager (legacy label only).
// SalesManager is kept so an old JSON backup prints a readable role; a restored
// user carrying it is treated as read-only until an Admin re-assigns them.

export const ROLES = ['Admin', 'WarehouseKeeper', 'SalesManager'];

// PERMS is the single source of truth for the role matrix. The Guide screen
// (#readme) reads its live role matrix out of PERMS — never a second copy.
export const PERMS = {
  'inventory.write': ['WarehouseKeeper'],
  'movement.create': ['WarehouseKeeper'],
  'color.add': ['WarehouseKeeper'],
  'color.delete': ['Admin'],
  'fabric.edit': ['Admin', 'WarehouseKeeper'],
  'keepercode.write': ['WarehouseKeeper'],
  'settings.write': ['Admin'],
};

// Actions where only the destination warehouse is checked (a transfer's
// receiver may sit outside the actor's scope; the source is checked as a
// normal scoped action).
const DESTINATION_ONLY = new Set(['transfer.receive']);

export function isDestinationOnly(action) {
  return DESTINATION_ONLY.has(action);
}

/**
 * can(user, action, whId) — authoritative check. Server-side only; the UI
 * mirrors this for affordance and it is never trusted.
 */
export function can(user, action, whId) {
  if (!user) return false;
  if (user.role === 'Admin') return true;
  if (user.role === 'SalesManager') return false;
  if (whId != null && !isDestinationOnly(action)) {
    const scope = user.warehouseIds || [];
    // Admin already returned true; keepers are scoped. An empty scope on a
    // keeper means "no sheds" (admin uses [] ⇒ all ten, handled above).
    if (!scope.includes(whId)) return false;
  }
  // A destination-only action (transfer.receive) borrows the permission of
  // its base action — the destination list is deliberately unscoped.
  const lookup = isDestinationOnly(action) ? 'movement.create' : action;
  const allowed = PERMS[lookup];
  return allowed ? allowed.includes(user.role) : false;
}

/**
 * viewsFor(user) — which of the twelve screens the sidebar may show.
 */
export function viewsFor(user) {
  if (!user) return [];
  const base = ['readme', 'stock', 'inventory', 'movements', 'colors', 'cross', 'dashboard', 'reports', 'masters', 'audit'];
  if (user.role === 'Admin') return [...base, 'settings'];
  if (user.role === 'SalesManager') return ['readme', 'stock', 'inventory', 'colors', 'cross', 'dashboard', 'reports', 'profile'];
  return [...base, 'profile']; // WarehouseKeeper — no Settings
}

/**
 * resolveScope(user, allWarehouseIds) — the warehouse ids a user may see.
 * Admin (warehouseIds []) ⇒ every active warehouse.
 */
export function resolveScope(user, allWarehouseIds) {
  if (!user) return [];
  if (user.role === 'Admin') return allWarehouseIds.slice();
  const all = new Set(allWarehouseIds || []);
  return (user.warehouseIds || []).filter((id) => all.has(id));
}

/**
 * otherKeeperScope(user, warehouses) — sheds NOT in the user's scope
 * (Cross-View). Admin has no "other" sheds; gets [].
 */
export function otherKeeperScope(user, warehouses) {
  if (!user || user.role === 'Admin') return [];
  const scope = new Set(user.warehouseIds || []);
  return warehouses.filter((w) => !scope.has(w.id)).map((w) => w.id);
}

-- migrations/0001_schema.sql — D1 schema (SQLite-compatible DDL).
-- Business model: Warehouse (مخزن / عرض) → Fabric type (قماش) → Colour (لون) → Roll (بكرة)
-- A roll is counted. Metres come from fabrics.meters_per_roll. No barcode,
-- no serial number, no working-width model.

CREATE TABLE warehouses (
  id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT,
  keeper_user_id TEXT NOT NULL, allowed_grades TEXT NOT NULL,
  grade_label_ar TEXT, capacity_rolls INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE fabrics (
  id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT,
  meters_per_roll REAL NOT NULL, unit_cost_per_roll REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE colors (
  id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT,
  hex TEXT, family TEXT NOT NULL, grade TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

-- mappings is the join table: one row per (warehouseId, fabricId, colorId).
-- A combination without an active mapping row is invalid.
CREATE TABLE mappings (
  id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL, fabric_id TEXT NOT NULL, color_id TEXT NOT NULL,
  min_rolls INTEGER NOT NULL DEFAULT 0, max_rolls INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (warehouse_id, fabric_id, color_id)
);

-- stock_events: every mutation (In / Out / Transfer out+in / Adjustment signed).
CREATE TABLE stock_events (
  id TEXT PRIMARY KEY, warehouse_id TEXT NOT NULL, fabric_id TEXT NOT NULL, color_id TEXT NOT NULL,
  kind TEXT NOT NULL, rolls_delta INTEGER NOT NULL, meters_delta REAL NOT NULL,
  value_delta REAL NOT NULL, ref_id TEXT, note TEXT, actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL, effective_date TEXT NOT NULL
);

-- stock_current: hot path (opening + in − out = closing).
CREATE TABLE stock_current (
  warehouse_id TEXT NOT NULL, fabric_id TEXT NOT NULL, color_id TEXT NOT NULL,
  opening_rolls INTEGER NOT NULL DEFAULT 0, rolls_in INTEGER NOT NULL DEFAULT 0,
  rolls_out INTEGER NOT NULL DEFAULT 0, closing_rolls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, fabric_id, color_id)
);

-- keeper_color_codes: private shelf labels. Neither keeper's list may leak
-- into the other's screens, CSVs, or print sheets.
CREATE TABLE keeper_color_codes (
  id TEXT PRIMARY KEY, keeper_user_id TEXT NOT NULL, color_id TEXT NOT NULL,
  custom_code TEXT, custom_name TEXT, notes TEXT, last_updated TEXT NOT NULL,
  UNIQUE (keeper_user_id, color_id)
);

-- audit_log: who / when / what, before → after per field, incl. Blocked rows.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL, entity TEXT NOT NULL,
  entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, warehouse_id TEXT,
  ip TEXT, user_agent TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL
);

-- ---- auth / sessions (PBKDF2-SHA256 hashes in D1, never btoa) -------------

CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  display_name_ar TEXT, display_name_en TEXT, role TEXT NOT NULL,
  warehouse_ids TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT
);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY, username TEXT, ip TEXT, success INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

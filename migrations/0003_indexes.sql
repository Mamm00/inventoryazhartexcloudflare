-- migrations/0003_indexes.sql — secondary indexes.

CREATE INDEX idx_stock_events_wh_date ON stock_events (warehouse_id, effective_date);
CREATE INDEX idx_stock_events_combo ON stock_events (warehouse_id, fabric_id, color_id);
CREATE INDEX idx_stock_events_ref ON stock_events (ref_id);
CREATE INDEX idx_stock_current_wh ON stock_current (warehouse_id);
CREATE INDEX idx_mappings_wh ON mappings (warehouse_id);
CREATE INDEX idx_mappings_fab ON mappings (fabric_id);
CREATE INDEX idx_mappings_color ON mappings (color_id);
CREATE INDEX idx_keeper_codes_user ON keeper_color_codes (keeper_user_id);
CREATE INDEX idx_audit_created ON audit_log (created_at);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
CREATE INDEX idx_colors_family ON colors (family);
CREATE INDEX idx_colors_grade ON colors (grade);

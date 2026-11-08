// GET /api/masters/diagnostics — Run diagnostics: orphans, duplicates,
// unmapped rows, negative stock, and missing translations. Query-derived.

import { json } from '../../../shared/server/http.js';

export async function onRequestGet(context) {
  const { env } = context;
  const q = async (sql, bind = []) => (await env.DB.prepare(sql).bind(...bind).all()).results;

  const orphans = await q(`
    SELECT 'stock_current' AS tbl, warehouse_id, fabric_id, color_id FROM stock_current s
    WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id)
    UNION ALL
    SELECT 'stock_events', warehouse_id, fabric_id, color_id FROM stock_events e
    WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.warehouse_id=e.warehouse_id AND m.fabric_id=e.fabric_id AND m.color_id=e.color_id)
    UNION ALL
    SELECT 'mappings->warehouse', warehouse_id, fabric_id, color_id FROM mappings m
    WHERE NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.id=m.warehouse_id)
  `);

  const duplicates = await q(`
    SELECT warehouse_id, fabric_id, color_id, COUNT(*) AS n FROM mappings
    GROUP BY warehouse_id, fabric_id, color_id HAVING COUNT(*) > 1
  `);

  const unmapped = await q(`
    SELECT s.warehouse_id, s.fabric_id, s.color_id, s.closing_rolls FROM stock_current s
    LEFT JOIN mappings m ON m.warehouse_id=s.warehouse_id AND m.fabric_id=s.fabric_id AND m.color_id=s.color_id
    WHERE m.id IS NULL OR m.active = 0
  `);

  const negative = await q(`
    SELECT warehouse_id, fabric_id, color_id, closing_rolls FROM stock_current WHERE closing_rolls < 0
  `);

  const missingTranslations = await q(`
    SELECT 'warehouses' AS tbl, id FROM warehouses WHERE name_ar IS NULL OR name_ar = '' OR name_en IS NULL OR name_en = ''
    UNION ALL SELECT 'fabrics', id FROM fabrics WHERE name_ar IS NULL OR name_ar = '' OR name_en IS NULL OR name_en = ''
    UNION ALL SELECT 'colors', id FROM colors WHERE name_ar IS NULL OR name_ar = '' OR name_en IS NULL OR name_en = ''
  `);

  return json({
    orphans, duplicates, unmapped, negative, missingTranslations,
    summary: {
      orphans: orphans.length, duplicates: duplicates.length,
      unmapped: unmapped.length, negative: negative.length,
      missingTranslations: missingTranslations.length,
    },
  });
}

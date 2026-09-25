-- Volta Industrial — app-facing UC views (NOT part of the SDP pipeline; apply via SQL).
-- The Databricks App's boot-time sync (app/server/db/sync.ts) reads `raw_parts` and expects
-- these exact columns: id, part_id, part_name, part_category, description, part_local,
-- lead_time_days, unit_cost_usd. This enriches the raw parquet catalog to match that contract.
-- Genie also reads raw_parts; the added columns are additive.
CREATE OR REPLACE VIEW dfurg_febar_catalog.volta_industrial.raw_parts AS
SELECT
  part_id                     AS id,
  part_id,
  part_name,
  part_type                   AS part_category,
  description,
  (COALESCE(local_stock_qty, 0) > 0) AS part_local,
  lead_time_days,
  unit_cost_usd
FROM read_files('/Volumes/dfurg_febar_catalog/volta_industrial/raw_data/parts', format => 'parquet');

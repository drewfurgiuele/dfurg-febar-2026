-- Volta plant-floor analytics — worst at-risk production LINES (top 20).
-- Column aliases (lot_id / product_name / facility / region / return_count /
-- units_sold / return_rate_pct / total_refund_usd) are kept so the existing
-- Analytics table + generated types resolve unchanged; the data is Volta's:
--   lot_id          := line_id
--   product_name    := line_name
--   facility        := plant_name
--   region          := region
--   return_count    := open work-order count
--   units_sold      := 0 (no per-line "sold" analog on the floor)
--   return_rate_pct := failure_risk_score * 100  (drives the severity color)
--   total_refund_usd:= downtime exposure ($)
-- @param catalog STRING = dfurg_febar_catalog
-- @param schema STRING = volta_industrial
SELECT
  line_id                              AS lot_id,
  line_name                            AS product_name,
  plant_name                           AS facility,
  region,
  CAST(open_wo_count AS BIGINT)        AS return_count,
  CAST(0 AS BIGINT)                    AS units_sold,
  CAST(ROUND(failure_risk_score * 100, 1) AS DOUBLE) AS return_rate_pct,
  CAST(ROUND(downtime_exposure_usd, 2) AS DOUBLE)    AS total_refund_usd
FROM IDENTIFIER(:catalog || '.' || :schema || '.gold_line_status')
WHERE risk_band IN ('critical', 'elevated', 'watch')
ORDER BY failure_risk_score DESC
LIMIT 20

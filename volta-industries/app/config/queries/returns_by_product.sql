-- Volta plant-floor analytics — at-risk lines by plant (top 10).
-- Column aliases (product_name / return_count / total_refund_usd) are kept so
-- the existing Analytics client + generated types resolve unchanged; the data
-- is Volta's: product_name := plant, return_count := # at-risk lines,
-- total_refund_usd := summed downtime exposure.
-- @param catalog STRING = dfurg_febar_catalog
-- @param schema STRING = volta_industrial
SELECT
  plant_name AS product_name,
  CAST(COUNT(*) AS BIGINT) AS return_count,
  CAST(ROUND(SUM(downtime_exposure_usd), 2) AS DOUBLE) AS total_refund_usd
FROM IDENTIFIER(:catalog || '.' || :schema || '.gold_line_status')
WHERE risk_band IN ('critical', 'elevated', 'watch')
GROUP BY plant_name
ORDER BY return_count DESC
LIMIT 10

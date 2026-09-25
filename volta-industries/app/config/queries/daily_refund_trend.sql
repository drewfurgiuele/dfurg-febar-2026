-- Volta plant-floor analytics — daily downtime EXPOSURE trend (last 30 days).
-- Column aliases (return_date / total_refund_usd) are kept so the existing
-- Analytics client + generated types resolve unchanged; the numbers are Volta's
-- (per-snapshot at-risk downtime exposure), not returns/refunds.
-- Referenced via IDENTIFIER(:catalog || '.' || :schema || '.t') so it resolves
-- on any workspace; :catalog/:schema are bound at runtime (charts.ts) and
-- sampled at typegen via the @param annotations below.
-- @param catalog STRING = dfurg_febar_catalog
-- @param schema STRING = volta_industrial
SELECT
  snapshot_date AS return_date,
  CAST(ROUND(
    SUM(CASE WHEN failure_risk_score >= 0.6
             THEN failure_risk_score * 2 * 22000
             ELSE 0 END), 2) AS DOUBLE) AS total_refund_usd
FROM IDENTIFIER(:catalog || '.' || :schema || '.silver_risk')
WHERE snapshot_date >= date_sub(current_date(), 30)
GROUP BY snapshot_date
ORDER BY snapshot_date

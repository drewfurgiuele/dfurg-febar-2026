-- Volta Industrial — UC Metric View `mv_line_risk` over gold_line_status.
-- Canonical source for dashboard KPI tiles + Genie headline answers (see specifications/02-uc-governance.md).
-- The failure model does NOT read this view.
CREATE OR REPLACE VIEW dfurg_febar_catalog.volta_industrial.mv_line_risk
WITH METRICS
LANGUAGE YAML
COMMENT 'Governed metric view: downtime exposure / at-risk counts by plant, machine_type, risk_band, criticality.'
AS $$
version: 0.1
source: dfurg_febar_catalog.volta_industrial.gold_line_status
dimensions:
  - name: plant_id
    expr: plant_id
  - name: machine_type
    expr: machine_type
  - name: risk_band
    expr: risk_band
  - name: criticality
    expr: criticality
  - name: line_id
    expr: line_id
measures:
  - name: downtime_exposure
    expr: SUM(downtime_exposure_usd)
  - name: open_work_orders
    expr: SUM(open_wo_count)
  - name: line_count
    expr: COUNT(1)
  - name: critical_count
    expr: SUM(CASE WHEN risk_band = 'critical' THEN 1 ELSE 0 END)
  - name: elevated_count
    expr: SUM(CASE WHEN risk_band = 'elevated' THEN 1 ELSE 0 END)
  - name: atrisk_count
    expr: SUM(CASE WHEN risk_band IN ('critical', 'elevated') THEN 1 ELSE 0 END)
  - name: avg_failure_risk
    expr: AVG(failure_risk_score)
  - name: avg_vibration
    expr: AVG(vibration_rms)
$$;

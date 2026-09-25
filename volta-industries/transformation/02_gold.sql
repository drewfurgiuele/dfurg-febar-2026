-- Volta Industrial — SDP pipeline `volta_plant_floor` · GOLD layer
-- Silver -> gold aggregations. See specifications/01-lakeflow.md §B (Silver -> Gold).
-- Every dashboard aggregate carries plant_id, machine_type, risk_band.

-- gold_line_status — THE COHERENCE SPINE. One row per line at the CURRENT snapshot
-- (snapshot_date = max in silver_risk = NOW-1), with telemetry, WO backlog, risk, band.
-- Dashboard, metric view, Genie, and the app all read this.
CREATE OR REFRESH MATERIALIZED VIEW gold_line_status
COMMENT 'One row per line, current position: telemetry + WO backlog + failure risk + risk_band + downtime exposure.'
AS
WITH current_risk AS (
  -- One row per line at the current snapshot. Raw data can carry a duplicate
  -- current-day snapshot for a few lines, so keep the highest-risk row per line.
  SELECT * EXCEPT (rn) FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY failure_risk_score DESC) AS rn
    FROM silver_risk
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM silver_risk)
  ) WHERE rn = 1
),
latest_telemetry AS (
  SELECT line_id, vibration_rms, temperature_c, utilization_pct, error_count,
         ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY telemetry_date DESC) AS rn
  FROM silver_telemetry
),
joined AS (
  SELECT
    cr.line_id,
    cr.plant_id,
    cr.line_name,
    cr.machine_type,
    cr.criticality,
    cr.plant_lat,
    cr.plant_lng,
    cr.snapshot_date,
    t.vibration_rms,
    t.temperature_c,
    t.utilization_pct,
    cr.failure_risk_score,
    COALESCE(w.open_wo_count, 0)            AS open_wo_count,
    COALESCE(w.has_open_corrective, false)  AS has_open_corrective,
    w.candidate_part_id,
    cr.risk_signal_score,
    p.local_stock_qty,
    p.lead_time_days     AS part_lead_time_days,
    p.unit_cost_usd      AS part_unit_cost_usd
  FROM current_risk cr
  LEFT JOIN latest_telemetry t ON cr.line_id = t.line_id AND t.rn = 1
  LEFT JOIN silver_work_orders w ON cr.line_id = w.line_id
  LEFT JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/parts', format => 'parquet') p
    ON w.candidate_part_id = p.part_id
)
SELECT
  -- id / plant_name / region / current_status / last_check_at feed the app's Lakebase mirror
  -- contract (server/db/sync.ts). current_status maps the 4-band model onto the app's 3 states.
  concat(line_id, ':', plant_id) AS id,
  line_id, plant_id, line_name, machine_type, criticality, plant_lat, plant_lng,
  CASE plant_id
    WHEN 'PLANT-01' THEN 'Detroit'    WHEN 'PLANT-02' THEN 'Pittsburgh'
    WHEN 'PLANT-03' THEN 'Columbus'   WHEN 'PLANT-04' THEN 'Milwaukee'
    WHEN 'PLANT-05' THEN 'Charlotte'  WHEN 'PLANT-06' THEN 'Dallas'
    WHEN 'PLANT-07' THEN 'Phoenix'    WHEN 'PLANT-08' THEN 'Portland'
    ELSE plant_id
  END AS plant_name,
  CASE plant_id
    WHEN 'PLANT-01' THEN 'Michigan'       WHEN 'PLANT-02' THEN 'Pennsylvania'
    WHEN 'PLANT-03' THEN 'Ohio'           WHEN 'PLANT-04' THEN 'Wisconsin'
    WHEN 'PLANT-05' THEN 'North Carolina' WHEN 'PLANT-06' THEN 'Texas'
    WHEN 'PLANT-07' THEN 'Arizona'        WHEN 'PLANT-08' THEN 'Oregon'
    ELSE NULL
  END AS region,
  vibration_rms, temperature_c, utilization_pct,
  failure_risk_score, open_wo_count, has_open_corrective,
  -- part_local: is the needed part stocked locally? No needed part -> not a constraint (true).
  CASE WHEN candidate_part_id IS NULL THEN true ELSE COALESCE(local_stock_qty, 0) > 0 END AS part_local,
  candidate_part_id,
  part_lead_time_days,
  part_unit_cost_usd,
  risk_signal_score,
  -- downtime exposure: at-risk lines only (>= 0.6), ~2 expected unplanned hours @ ~$22K/hr.
  CASE WHEN failure_risk_score >= 0.6 THEN failure_risk_score * 2 * 22000 ELSE 0 END AS downtime_exposure_usd,
  CASE
    WHEN failure_risk_score >= 0.75 AND has_open_corrective THEN 'critical'
    WHEN failure_risk_score >= 0.6  THEN 'elevated'
    WHEN failure_risk_score >= 0.4  THEN 'watch'
    ELSE 'healthy'
  END AS risk_band,
  -- current_status: the app mirror's 3-state enum (healthy / at_risk / critical).
  CASE
    WHEN failure_risk_score >= 0.75 AND has_open_corrective THEN 'critical'
    WHEN failure_risk_score >= 0.4  THEN 'at_risk'
    ELSE 'healthy'
  END AS current_status,
  CAST(snapshot_date AS TIMESTAMP) AS last_check_at
FROM joined;

-- gold_open_atrisk — at-risk lines + parts context. Model scoring input AND the app's floor queue.
CREATE OR REFRESH MATERIALIZED VIEW gold_open_atrisk
COMMENT 'Lines in critical/elevated/watch with candidate part + lead time + cost context.'
AS
SELECT
  line_id, plant_id, line_name, machine_type, criticality, plant_lat, plant_lng,
  vibration_rms, temperature_c, utilization_pct,
  failure_risk_score, open_wo_count, has_open_corrective,
  downtime_exposure_usd, risk_band,
  part_local,
  candidate_part_id,
  part_lead_time_days,
  part_unit_cost_usd
FROM gold_line_status
WHERE risk_band IN ('critical', 'elevated', 'watch');

-- gold_maintenance_outcomes — maintenance history, one row per decision + features + label.
-- Heuristic-coefficient source + OPTIONAL ML training table (03-ml-maintenance.md).
CREATE OR REFRESH MATERIALIZED VIEW gold_maintenance_outcomes
COMMENT 'One row per historical maintenance decision with outcome (label: downtime_cost_avoided_usd).'
AS
SELECT
  event_id, line_id, plant_id, machine_type, criticality,
  action_type, risk_at_action, part_local,
  action_cost_usd, downtime_hours,
  avoided_unplanned_stop, downtime_cost_avoided_usd,
  initiated_date
FROM silver_maintenance;

-- gold_maintenance_recommendations — the ranked action per at-risk line, built by the HEURISTIC.
-- part_local is the key lever: expediting a non-local part is slow AND costly, so pulling now
-- wins for the hero (LINE-0004, non-local part). ML (optional) can overwrite this same table.
-- Columns match 03-ml-maintenance.md inference shape so nothing downstream changes.
CREATE OR REFRESH MATERIALIZED VIEW gold_maintenance_recommendations
COMMENT 'Ranked maintenance action per at-risk line (heuristic): recommended_action + predicted values + action_ranking JSON.'
AS
WITH base AS (
  SELECT
    line_id,
    failure_risk_score,
    part_local,
    COALESCE(part_unit_cost_usd, 500.0)  AS puc,
    COALESCE(part_lead_time_days, 7)      AS ltd
  FROM gold_open_atrisk
),
calc AS (
  SELECT
    line_id, failure_risk_score, part_local,
    -- stop = 4h unplanned @ $22K/hr
    failure_risk_score * 88000.0 AS pull_avoided,
    40000.0 AS pull_cost,
    8000.0 AS run_avoided,
    failure_risk_score * 88000.0 * (CASE WHEN part_local THEN 0.6 ELSE 1.0 END) AS run_cost,
    failure_risk_score * 88000.0 * (CASE WHEN part_local THEN 0.6 ELSE 0.3 END) AS exp_avoided,
    (CASE WHEN part_local THEN puc * 2 + 400 ELSE puc * 3 + ltd * 22000.0 END) AS exp_cost
  FROM base
),
nets AS (
  SELECT *,
    pull_avoided - pull_cost AS pull_net,
    run_avoided  - run_cost  AS run_net,
    exp_avoided  - exp_cost  AS exp_net
  FROM calc
),
ranked AS (
  SELECT *,
    CASE
      WHEN pull_net >= run_net AND pull_net >= exp_net THEN 'pull_now'
      WHEN exp_net  >= run_net AND exp_net  >= pull_net THEN 'expedite_parts_and_run'
      ELSE 'run_to_shift_end'
    END AS recommended_action
  FROM nets
)
SELECT
  line_id,
  recommended_action,
  ROUND(CASE recommended_action
    WHEN 'pull_now' THEN pull_avoided
    WHEN 'expedite_parts_and_run' THEN exp_avoided
    ELSE run_avoided END, 2) AS predicted_downtime_cost_avoided_usd,
  -- alias the app's Lakebase mirror expects (server/db/sync.ts selects predicted_downtime_cost_usd)
  ROUND(CASE recommended_action
    WHEN 'pull_now' THEN pull_avoided
    WHEN 'expedite_parts_and_run' THEN exp_avoided
    ELSE run_avoided END, 2) AS predicted_downtime_cost_usd,
  ROUND(CASE recommended_action
    WHEN 'pull_now' THEN pull_net
    WHEN 'expedite_parts_and_run' THEN exp_net
    ELSE run_net END, 2) AS predicted_net_value_usd,
  to_json(array(
    named_struct('action', 'pull_now',               'avoided', ROUND(pull_avoided, 2), 'cost', ROUND(pull_cost, 2), 'net', ROUND(pull_net, 2)),
    named_struct('action', 'run_to_shift_end',        'avoided', ROUND(run_avoided, 2),  'cost', ROUND(run_cost, 2),  'net', ROUND(run_net, 2)),
    named_struct('action', 'expedite_parts_and_run',  'avoided', ROUND(exp_avoided, 2),  'cost', ROUND(exp_cost, 2),  'net', ROUND(exp_net, 2))
  )) AS action_ranking,
  current_timestamp() AS scored_at
FROM ranked;

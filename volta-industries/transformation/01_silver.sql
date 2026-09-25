-- Volta Industrial — SDP pipeline `volta_plant_floor` · SILVER layer
-- Raw parquet (in the raw_data Volume, written by data_generation/generate_data.py) -> silver.
-- No bronze: silver reads the Volume directly via read_files(). See specifications/01-lakeflow.md §B.
-- ${catalog} / ${schema} are supplied by the pipeline `configuration`.

-- note_risk_flags — the ai_classify showcase, DEDUPED.
-- Classify each DISTINCT technician note exactly once (there are only a handful),
-- then silver_risk joins the score back per snapshot — no second LLM call.
CREATE OR REFRESH MATERIALIZED VIEW note_risk_flags
COMMENT 'Deduped ai_classify of technician notes -> risk_signal_score (failing 1.0 / degrading 0.6 / healthy 0.1).'
AS
WITH distinct_notes AS (
  SELECT DISTINCT technician_note_text AS note
  FROM read_files('/Volumes/${catalog}/${schema}/raw_data/risk_snapshots', format => 'parquet')
  WHERE technician_note_text IS NOT NULL AND length(trim(technician_note_text)) > 0
),
classified AS (
  SELECT note,
         ai_classify(note, ARRAY('failing', 'degrading', 'healthy')) AS risk_label
  FROM distinct_notes
)
SELECT
  note,
  risk_label,
  CASE risk_label
    WHEN 'failing'   THEN 1.0
    WHEN 'degrading' THEN 0.6
    ELSE 0.1
  END AS risk_signal_score
FROM classified;

-- silver_telemetry — per line x day telemetry, denormalized with line master.
CREATE OR REFRESH MATERIALIZED VIEW silver_telemetry
CLUSTER BY (telemetry_date)
COMMENT 'Per line x day telemetry joined to line master (plant, machine_type, geo).'
AS
SELECT
  t.line_id,
  t.telemetry_date,
  t.vibration_rms,
  t.temperature_c,
  t.utilization_pct,
  t.error_count,
  l.plant_id,
  l.line_name,
  l.machine_type,
  l.criticality,
  l.plant_lat,
  l.plant_lng
FROM read_files('/Volumes/${catalog}/${schema}/raw_data/telemetry', format => 'parquet') t
JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/lines', format => 'parquet') l
  USING (line_id);

-- silver_risk — daily risk snapshots joined to line master + the deduped note signal.
CREATE OR REFRESH MATERIALIZED VIEW silver_risk
CLUSTER BY (snapshot_date)
COMMENT 'Daily failure-risk snapshots with line master and ai_classify risk_signal_score.'
AS
SELECT
  r.line_id,
  r.snapshot_date,
  r.failure_risk_score,
  r.open_wo_count       AS snapshot_open_wo_count,
  r.technician_note_text,
  COALESCE(n.risk_signal_score, 0.1) AS risk_signal_score,
  l.plant_id,
  l.line_name,
  l.machine_type,
  l.criticality,
  l.plant_lat,
  l.plant_lng
FROM read_files('/Volumes/${catalog}/${schema}/raw_data/risk_snapshots', format => 'parquet') r
JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/lines', format => 'parquet') l
  USING (line_id)
LEFT JOIN note_risk_flags n
  ON r.technician_note_text = n.note;

-- silver_work_orders — per-line work-order rollup + latest part needed on an open corrective WO.
CREATE OR REFRESH MATERIALIZED VIEW silver_work_orders
COMMENT 'Per-line WO rollup: open count, has_open_corrective, and the latest open-corrective part.'
AS
WITH wo AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/work_orders', format => 'parquet')
),
rollup AS (
  SELECT
    line_id,
    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_wo_count,
    MAX(CASE WHEN status = 'open' AND wo_type = 'corrective' THEN 1 ELSE 0 END) = 1 AS has_open_corrective
  FROM wo
  GROUP BY line_id
),
latest_open_corrective AS (
  SELECT line_id, part_id, opened_date,
         ROW_NUMBER() OVER (PARTITION BY line_id ORDER BY opened_date DESC) AS rn
  FROM wo
  WHERE status = 'open' AND wo_type = 'corrective' AND part_id IS NOT NULL
)
SELECT
  r.line_id,
  r.open_wo_count,
  r.has_open_corrective,
  loc.part_id AS candidate_part_id
FROM rollup r
LEFT JOIN latest_open_corrective loc
  ON r.line_id = loc.line_id AND loc.rn = 1;

-- silver_maintenance — 18-month maintenance-decision history denormalized (feeds gold_maintenance_outcomes).
CREATE OR REFRESH MATERIALIZED VIEW silver_maintenance
COMMENT 'Maintenance-decision history with outcomes, denormalized with line master.'
AS
SELECT
  m.event_id,
  m.line_id,
  m.action_type,
  m.risk_at_action,
  m.part_local,
  m.initiated_date,
  m.action_cost_usd,
  m.downtime_hours,
  m.avoided_unplanned_stop,
  m.downtime_cost_avoided_usd,
  l.plant_id,
  l.machine_type,
  l.criticality
FROM read_files('/Volumes/${catalog}/${schema}/raw_data/maintenance_events', format => 'parquet') m
JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/lines', format => 'parquet') l
  USING (line_id);

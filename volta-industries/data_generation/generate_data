# Databricks notebook source
# MAGIC %md
# MAGIC # Volta Industrial — Downtime & Maintenance Rescue · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Volta demo under `<catalog>.<schema>` using Spark
# MAGIC (Databricks Connect serverless when run locally, the runtime's `spark` when run as a
# MAGIC job). Follows the `databricks-synthetic-data-gen` skill: `spark.range` + `F.when` +
# MAGIC broadcast joins + Window + `F.element_at` — no driver loops, no `.collect()` on big tables.
# MAGIC
# MAGIC **The load-bearing anomaly** (one driver, two visible symptoms): a high-utilization run
# MAGIC ~3 weeks ago wore a cluster of production lines toward failure — rising vibration/temperature
# MAGIC telemetry + open corrective work orders + parts that would need expediting — while the rest of
# MAGIC the fleet runs to plan. The hero is `LINE-04` at `PLANT-03` (Ohio, failure risk ~0.87, part not
# MAGIC local); the maintenance play the heuristic ranks first is **pull_now**. See `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template.** This script
# MAGIC writes the RAW parquet datasets only; silver + gold are the SDP pipeline's job.

# COMMAND ----------

from __future__ import annotations

import os
from datetime import datetime, timedelta

import numpy as np
from pyspark.sql import DataFrame
from pyspark.sql import functions as F

# ── Config ─────────────────────────────────────────────────────────────────
IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")
    dbutils.widgets.text("schema", "", "Schema")
    CATALOG = dbutils.widgets.get("catalog")
    SCHEMA = dbutils.widgets.get("schema")
else:
    import argparse

    _p = argparse.ArgumentParser()
    _p.add_argument("--catalog", default=os.environ.get("DEMO_CATALOG"))
    _p.add_argument("--schema", default=os.environ.get("DEMO_SCHEMA"))
    _a, _ = _p.parse_known_args()
    CATALOG, SCHEMA = _a.catalog, _a.schema
assert CATALOG and SCHEMA, "catalog + schema required (widgets in-job, --catalog/--schema or DEMO_CATALOG/DEMO_SCHEMA locally)"

RAW_VOL = "raw_data"

# ── Story timeline ───────────────────────────────────────────────────────────
STORY_PINNED_NOW = datetime(2026, 8, 1)
NOW = STORY_PINNED_NOW if os.environ.get("VOLTA_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
WEAR_ONSET = NOW - timedelta(days=21)
RISK_RAMP = NOW - timedelta(days=18)
SNAPSHOT_DATE = NOW - timedelta(days=1)
RISK_WINDOW_START = NOW - timedelta(days=14)

# ── Deterministic story anchors ───────────────────────────────────────────────
N_LINES = 1_200
N_PLANTS = 8
N_AFFECTED = 90                                   # high-risk lines (pull_now wins)
N_MODERATE = 70                                   # moderate-risk cohort (run/expedite win) → plausible mix
COST_PER_HOUR = 22000.0                           # unplanned-downtime cost/hr
EXPECTED_STOP_HOURS = 4.0                          # expected unplanned-stop duration

HERO_LINE = "LINE-04"
HERO_PLANT = "PLANT-03"                            # Ohio
HERO_LINE_ID = "LINE-0004"                         # global line id (see id scheme below)

# Plant anchors: (plant_id, name, state, lat, lng)
PLANTS = [
    ("PLANT-01", "Detroit", "MI", 42.33, -83.05),
    ("PLANT-02", "Pittsburgh", "PA", 40.44, -79.996),
    ("PLANT-03", "Columbus", "OH", 39.96, -82.99),   # the Ohio plant — hero
    ("PLANT-04", "Milwaukee", "WI", 43.04, -87.91),
    ("PLANT-05", "Charlotte", "NC", 35.23, -80.84),
    ("PLANT-06", "Dallas", "TX", 32.78, -96.80),
    ("PLANT-07", "Phoenix", "AZ", 33.45, -112.07),
    ("PLANT-08", "Portland", "OR", 45.52, -122.68),
]
MACHINE_TYPES = ["CNC_Mill", "Hydraulic_Press", "Welding_Cell", "Assembly_Robot", "Injection_Molder", "Grinder"]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('VOLTA_PIN_TIME') == '1' else 'rolling'})")
print(f"WEAR_ONSET: {WEAR_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_LINE_ID} at {HERO_PLANT} (Ohio), failure risk climbing, part not local")

try:
    spark  # noqa: F821
except NameError:
    from databricks.connect import DatabricksSession

    spark = (
        DatabricksSession.builder.profile(os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
        .serverless(True)
        .getOrCreate()
    )

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.{RAW_VOL}")
RAW_VOL_ROOT = f"/Volumes/{CATALOG}/{SCHEMA}/{RAW_VOL}"


def _raw_path(table: str) -> str:
    return f"{RAW_VOL_ROOT}/{table.removeprefix('raw_')}"


def _save(df: DataFrame, table: str) -> None:
    path = _raw_path(table)
    df.write.mode("overwrite").parquet(path)
    n = spark.read.parquet(path).count()
    print(f"  ✓ {table:26s} rows={n:>10,}  → {path}")


# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Lines — ~1,200 production lines across 8 plants, geo-anchored
# MAGIC The hero LINE-0004 is pinned to PLANT-03 (Ohio). The affected cohort is a deterministic
# MAGIC set of line indices; the hero is forced in.

# COMMAND ----------

print("\n[1/6] Generating lines...")

plant_id_arr = F.array(*[F.lit(p[0]) for p in PLANTS])
plant_name_arr = F.array(*[F.lit(p[1]) for p in PLANTS])
plant_state_arr = F.array(*[F.lit(p[2]) for p in PLANTS])
plant_lat_arr = F.array(*[F.lit(float(p[3])) for p in PLANTS])
plant_lng_arr = F.array(*[F.lit(float(p[4])) for p in PLANTS])
mtype_arr = F.array(*[F.lit(m) for m in MACHINE_TYPES])
crit_arr = F.array(F.lit("high"), F.lit("medium"), F.lit("medium"), F.lit("low"))

# Hero at index 3 → LINE-0004; force it to PLANT-03.
AFFECTED_IDX = [3] + [i for i in range(30, 30 + (N_AFFECTED - 1) * 13, 13)][: N_AFFECTED - 1]
affected_idx_arr = F.array(*[F.lit(int(i)) for i in AFFECTED_IDX])
MODERATE_IDX = [i for i in range(700, 700 + N_MODERATE * 7, 7)][:N_MODERATE]
moderate_idx_arr = F.array(*[F.lit(int(i)) for i in MODERATE_IDX])

lines_df = (
    spark.range(0, N_LINES)
    .withColumn("line_id", F.concat(F.lit("LINE-"), F.lpad((F.col("id") + 1).cast("string"), 4, "0")))
    .withColumn("_pi", (F.rand(1) * N_PLANTS).cast("int"))
    # hero → PLANT-03 (index 2)
    .withColumn("_pi", F.when(F.col("line_id") == HERO_LINE_ID, F.lit(2)).otherwise(F.col("_pi")))
    .withColumn("plant_id", F.element_at(plant_id_arr, F.col("_pi") + 1))
    .withColumn("line_name", F.concat(F.lit("Line "), F.lpad(((F.col("id") % 25 + 1)).cast("string"), 2, "0")))
    .withColumn("machine_type", F.element_at(mtype_arr, (F.rand(2) * len(MACHINE_TYPES) + 1).cast("int")))
    .withColumn("plant_lat", F.round(F.element_at(plant_lat_arr, F.col("_pi") + 1) + (F.rand(3) - 0.5) * 0.04, 2))
    .withColumn("plant_lng", F.round(F.element_at(plant_lng_arr, F.col("_pi") + 1) + (F.rand(4) - 0.5) * 0.04, 2))
    .withColumn("install_date", F.date_sub(F.lit(NOW.date().isoformat()).cast("date"), (F.rand(5) * 4000 + 400).cast("int")))
    .withColumn("criticality", F.element_at(crit_arr, (F.rand(6) * 4 + 1).cast("int")))
    .withColumn("is_active", F.lit(True))
    .select("line_id", "plant_id", "line_name", "machine_type", "plant_lat", "plant_lng", "install_date", "criticality", "is_active")
)
_save(lines_df, "raw_lines")

AFFECTED_LINES = [f"LINE-{i + 1:04d}" for i in AFFECTED_IDX]
MODERATE_LINES = [f"LINE-{i + 1:04d}" for i in MODERATE_IDX]
ATRISK_LINES = AFFECTED_LINES + MODERATE_LINES

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Parts — replacement parts catalog; local_stock_qty=0 means must-expedite

# COMMAND ----------

print("\n[2/6] Generating parts...")

parts_df = (
    spark.range(0, 800)
    .withColumn("part_id", F.concat(F.lit("PART-"), F.lpad((F.col("id") + 1).cast("string"), 5, "0")))
    .withColumn("machine_type", F.element_at(mtype_arr, (F.rand(11) * len(MACHINE_TYPES) + 1).cast("int")))
    .withColumn("part_type", F.element_at(F.array(F.lit("bearing"), F.lit("spindle"), F.lit("hydraulic_seal"), F.lit("servo_motor"), F.lit("sensor"), F.lit("belt")), (F.rand(12) * 6 + 1).cast("int")))
    .withColumn("part_name", F.concat(F.col("part_type"), F.lit(" "), F.col("machine_type")))
    .withColumn("unit_cost_usd", F.round(200 + F.rand(13) * 4000, 2))
    .withColumn("lead_time_days", (1 + F.rand(14) * 20).cast("int"))
    # PART-00001 is pinned NON-local (the hero's replacement part must be expedited);
    # the rest are ~50% local.
    .withColumn("local_stock_qty", F.when(F.col("part_id") == "PART-00001", F.lit(0)).when(F.rand(15) < 0.5, (F.rand(16) * 8 + 1).cast("int")).otherwise(F.lit(0)))
    .withColumn(
        "description",
        F.concat_ws(" ", F.lit("Replacement"), F.col("part_type"), F.lit("for"), F.col("machine_type"), F.lit("machines."),
                    F.when(F.col("local_stock_qty") > 0, F.lit("In local stock.")).otherwise(F.lit("Not stocked locally; must be expedited from the regional depot.")),
                    F.lit("Lead time"), F.col("lead_time_days").cast("string"), F.lit("days.")),
    )
    .withColumn("is_active", F.lit(True))
    .select("part_id", "part_name", "part_type", "machine_type", "unit_cost_usd", "lead_time_days", "local_stock_qty", "description", "is_active")
)
_save(parts_df, "raw_parts")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Telemetry — 18 months daily line telemetry; affected lines' vibration/temp ramp

# COMMAND ----------

print("\n[3/6] Generating telemetry...")

affected_line_arr = F.array(*[F.lit(l) for l in AFFECTED_LINES])
atrisk_line_arr = F.array(*[F.lit(l) for l in ATRISK_LINES])
ramp_off = (SNAPSHOT_DATE - RISK_RAMP).days

# Affected lines: dense last 60 days with a vibration/temperature ramp.
affected_telemetry = (
    spark.createDataFrame([(l,) for l in AFFECTED_LINES], "line_id string")
    .crossJoin(spark.range(0, 60).withColumnRenamed("id", "day_offset"))
    .withColumn("telemetry_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("day_offset").cast("int")))
    .withColumn("_ramped", F.col("day_offset") <= F.lit(ramp_off))
    .withColumn("_amt", F.when(F.col("_ramped"), (F.lit(ramp_off) - F.col("day_offset")) / F.lit(float(max(ramp_off, 1)))).otherwise(F.lit(0.0)))
    .withColumn("vibration_rms", F.round(2.0 + F.col("_amt") * 4.0 + F.rand(21) * 0.4, 3))     # baseline ~2, ramps to ~6
    .withColumn("temperature_c", F.round(55 + F.col("_amt") * 30 + F.rand(22) * 3, 1))          # baseline ~55, ramps to ~85
    .withColumn("utilization_pct", F.round(70 + F.rand(23) * 25, 1))
    .withColumn("error_count", (F.col("_amt") * 8 + F.rand(24) * 2).cast("int"))
    .select("line_id", "telemetry_date", "vibration_rms", "temperature_c", "utilization_pct", "error_count")
)

# Baseline telemetry: sampled broad grid (everyday, in-band). Exclude at-risk lines so their
# ramp isn't diluted.
N_BASELINE_TEL = 3_400_000
_baseline_lines = [f"LINE-{i + 1:04d}" for i in range(N_LINES) if i not in set(AFFECTED_IDX) | set(MODERATE_IDX)]
line_arr = F.array(*[F.lit(l) for l in _baseline_lines])
_n_baseline_lines = len(_baseline_lines)
baseline_telemetry = (
    spark.range(0, N_BASELINE_TEL)
    .withColumn("line_id", F.element_at(line_arr, (F.rand(31) * _n_baseline_lines + 1).cast("int")))
    .withColumn("telemetry_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(32) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("vibration_rms", F.round(1.5 + F.rand(33) * 1.2, 3))
    .withColumn("temperature_c", F.round(50 + F.rand(34) * 10, 1))
    .withColumn("utilization_pct", F.round(60 + F.rand(35) * 30, 1))
    .withColumn("error_count", (F.rand(36) * 2).cast("int"))
    .select("line_id", "telemetry_date", "vibration_rms", "temperature_c", "utilization_pct", "error_count")
)

telemetry_df = affected_telemetry.unionByName(baseline_telemetry)
_save(telemetry_df, "raw_telemetry")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Work orders — open corrective backlog on the affected lines

# COMMAND ----------

print("\n[4/6] Generating work orders...")

part_id_arr = F.array(*[F.lit(f"PART-{i + 1:05d}") for i in range(800)])
_WO_COLS = ["line_id", "wo_type", "part_id", "opened_date", "closed_date", "downtime_hours", "status"]

# Affected lines: OPEN corrective work orders. The hero gets the pinned non-local part.
affected_wo = (
    spark.createDataFrame([(l,) for l in ATRISK_LINES], "line_id string")
    .withColumn("wo_type", F.lit("corrective"))
    .withColumn(
        "part_id",
        F.when(F.col("line_id") == HERO_LINE_ID, F.lit("PART-00001"))
        .otherwise(F.element_at(part_id_arr, (F.rand(41) * 800 + 1).cast("int"))),
    )
    .withColumn("opened_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), (2 + F.rand(42) * 12).cast("int")))
    .withColumn("closed_date", F.lit(None).cast("date"))
    .withColumn("downtime_hours", F.lit(0.0))
    .withColumn("status", F.lit("open"))
    .select(*_WO_COLS)
)
# Baseline WOs: closed history.
baseline_wo = (
    spark.range(0, 115_000)
    .withColumn("line_id", F.element_at(line_arr, (F.rand(43) * _n_baseline_lines + 1).cast("int")))
    .withColumn("wo_type", F.element_at(F.array(F.lit("preventive"), F.lit("preventive"), F.lit("corrective"), F.lit("emergency")), (F.rand(44) * 4 + 1).cast("int")))
    .withColumn("part_id", F.when(F.rand(45) < 0.6, F.element_at(part_id_arr, (F.rand(46) * 800 + 1).cast("int"))).otherwise(F.lit(None).cast("string")))
    .withColumn("opened_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (10 + F.rand(47) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("closed_date", F.expr("date_add(opened_date, cast(rand(48)*10+1 as int))"))
    .withColumn("downtime_hours", F.round(F.rand(49) * 6, 1))
    .withColumn("status", F.lit("closed"))
    .select(*_WO_COLS)
)
wo_df = (
    affected_wo.unionByName(baseline_wo)
    .withColumn("wo_id", F.concat(F.lit("WO-"), F.lpad((F.monotonically_increasing_id() % 90000000 + 1).cast("string"), 8, "0")))
    .select("wo_id", "line_id", "wo_type", "part_id", "opened_date", "closed_date", "downtime_hours", "status")
)
_save(wo_df, "raw_work_orders")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Risk snapshots — daily failure-risk for the last ~14 days + current

# COMMAND ----------

print("\n[5/6] Generating risk snapshots...")

_RISK_NOTES = [
    "vibration trending up on spindle bearing", "temperature above threshold, coolant checked",
    "intermittent fault, part not in local stock", "backlog on preventive maintenance", "operator reports unusual noise",
]
_HEALTHY_NOTES = ["running to plan, no faults", "pm completed on schedule", None, None]
risk_notes_arr = F.array(*[F.lit(x) for x in _RISK_NOTES])
healthy_arr = F.array(*[(F.lit(x) if x is not None else F.lit(None).cast("string")) for x in _HEALTHY_NOTES])

n_snap_days = (SNAPSHOT_DATE - RISK_WINDOW_START).days + 1

affected_risk = (
    spark.createDataFrame([(l,) for l in AFFECTED_LINES], "line_id string")
    .crossJoin(spark.range(0, n_snap_days).withColumnRenamed("id", "d"))
    .withColumn("snapshot_date", F.date_sub(F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"), F.col("d").cast("int")))
    .withColumn("_progress", (F.lit(n_snap_days - 1) - F.col("d")) / F.lit(float(max(n_snap_days - 1, 1))))
    .withColumn(
        "failure_risk_score",
        F.when(F.col("line_id") == HERO_LINE_ID, F.round(F.least(F.lit(0.92), 0.25 + F.col("_progress") * 0.62), 3))
        .otherwise(F.round(F.least(F.lit(0.95), 0.15 + F.col("_progress") * (0.62 + F.rand(51) * 0.2)), 3)),
    )
    .withColumn("open_wo_count", (1 + F.col("_progress") * 2 + F.rand(52)).cast("int"))
    .withColumn(
        "technician_note_text",
        F.when(F.rand(53) < 0.85, F.element_at(risk_notes_arr, (F.rand(54) * len(_RISK_NOTES) + 1).cast("int")))
        .when(F.rand(55) < 0.3, F.element_at(healthy_arr, (F.rand(56) * len(_HEALTHY_NOTES) + 1).cast("int")))
        .otherwise(F.lit(None).cast("string")),
    )
    .select("line_id", "snapshot_date", "failure_risk_score", "open_wo_count", "technician_note_text")
)
moderate_risk = (
    spark.createDataFrame([(l,) for l in MODERATE_LINES], "line_id string")
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("failure_risk_score", F.round(0.42 + F.rand(57) * 0.21, 3))
    .withColumn("open_wo_count", (1 + F.rand(58) * 2).cast("int"))
    .withColumn(
        "technician_note_text",
        F.when(F.rand(59) < 0.6, F.element_at(risk_notes_arr, (F.rand(60) * len(_RISK_NOTES) + 1).cast("int")))
        .otherwise(F.element_at(healthy_arr, (F.rand(66) * len(_HEALTHY_NOTES) + 1).cast("int"))),
    )
    .select("line_id", "snapshot_date", "failure_risk_score", "open_wo_count", "technician_note_text")
)
everyday_risk = (
    spark.range(0, N_LINES)
    .withColumn("line_id", F.concat(F.lit("LINE-"), F.lpad((F.col("id") + 1).cast("string"), 4, "0")))
    .withColumn("is_atrisk", F.array_contains(atrisk_line_arr, F.col("line_id")))
    .filter(~F.col("is_atrisk"))
    .withColumn("snapshot_date", F.lit(SNAPSHOT_DATE.date().isoformat()).cast("date"))
    .withColumn("failure_risk_score", F.round(0.03 + F.rand(61) * 0.17, 3))
    .withColumn("open_wo_count", (F.rand(62)).cast("int"))
    .withColumn("technician_note_text", F.element_at(healthy_arr, (F.rand(63) * len(_HEALTHY_NOTES) + 1).cast("int")))
    .select("line_id", "snapshot_date", "failure_risk_score", "open_wo_count", "technician_note_text")
)
risk_df = affected_risk.unionByName(moderate_risk).unionByName(everyday_risk)
_save(risk_df, "raw_risk_snapshots")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Maintenance events — 18 months of decisions with outcomes (model training)
# MAGIC pull_now on high-risk/non-local avoids the most downtime cost per dollar; run_to_shift_end
# MAGIC wins on low-risk; expedite on moderate time-critical. This ranks the hero as pull_now.

# COMMAND ----------

print("\n[6/6] Generating maintenance events...")

line_pop_arr = F.array(*[F.lit(f"LINE-{i + 1:04d}") for i in range(N_LINES)])
maintenance_df = (
    spark.range(0, 35_000)
    .withColumn("event_id", F.concat(F.lit("MEV-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("line_id", F.element_at(line_pop_arr, (F.rand(71) * N_LINES + 1).cast("int")))
    .withColumn("action_type", F.element_at(F.array(F.lit("pull_now"), F.lit("pull_now"), F.lit("run_to_shift_end"), F.lit("expedite_parts_and_run")), (F.rand(72) * 4 + 1).cast("int")))
    .withColumn("risk_at_action", F.round(0.3 + F.rand(73) * 0.65, 3))
    .withColumn("part_local", F.rand(74) < 0.5)
    .withColumn("initiated_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(75) * HIST_SPAN_DAYS).cast("int")))
    # Outcomes learnable by NET = downtime_cost_avoided - action_cost.
    .withColumn(
        "downtime_hours",
        F.when(F.col("action_type") == "pull_now", F.round(1.5 + F.rand(76) * 1.5, 1))     # planned, short
        .when(F.col("action_type") == "run_to_shift_end", F.round(F.col("risk_at_action") * 6, 1))  # gamble
        .otherwise(F.round(0.5 + F.rand(77), 1)),
    )
    .withColumn(
        "action_cost_usd",
        F.when(F.col("action_type") == "pull_now", F.round(F.col("downtime_hours") * 22000 * 0.3, 2))  # planned cheaper/hr
        .when(F.col("action_type") == "run_to_shift_end", F.round(F.col("risk_at_action") * (4 * 22000) + F.when(F.col("part_local"), 0).otherwise(3000), 2))
        .otherwise(F.round(2500 + F.rand(78) * 3000, 2)),  # expedite: parts premium
    )
    # pull_now avoids an unplanned stop when risk is high; run avoids nothing; expedite avoids ~60%.
    .withColumn(
        "avoided_unplanned_stop",
        F.when(F.col("action_type") == "pull_now", F.rand(79) < F.col("risk_at_action"))
        .when(F.col("action_type") == "expedite_parts_and_run", F.rand(80) < F.col("risk_at_action") * 0.6)
        .otherwise(F.lit(False)),
    )
    .withColumn(
        "downtime_cost_avoided_usd",
        F.when(F.col("avoided_unplanned_stop"), F.round(F.col("risk_at_action") * 4 * 22000, 2)).otherwise(F.lit(0.0)),
    )
    .select("event_id", "line_id", "action_type", "risk_at_action", "part_local", "initiated_date", "action_cost_usd", "downtime_hours", "avoided_unplanned_stop", "downtime_cost_avoided_usd")
)
_save(maintenance_df, "raw_maintenance_events")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Six raw datasets written. Next: run the SDP pipeline (`transformation/*.sql`) to build silver
# MAGIC + gold, then the metric view, the failure model (`transformation/maintenance_train_score.py`),
# MAGIC the dashboard, and the Genie space. Validate against `01-lakeflow.md` Section C.

# COMMAND ----------

print("\n✅ Volta raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero: {HERO_LINE_ID} at {HERO_PLANT}")
print(f"   Affected lines: {len(AFFECTED_LINES)}  moderate: {len(MODERATE_LINES)}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_line": HERO_LINE_ID, "hero_plant": HERO_PLANT,
        "affected_lines": len(AFFECTED_LINES), "moderate_lines": len(MODERATE_LINES),
    }))

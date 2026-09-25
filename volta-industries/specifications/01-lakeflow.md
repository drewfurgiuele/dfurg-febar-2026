# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The company**: Volta Industrial — a heavy industrial-equipment maker (~8 plants, ~$1.8B revenue, connected-machine telemetry, aftermarket parts/service). The demo samples one fleet of production lines across the 8 plants so joins stay cheap.

**The plants + lines**: 8 plants (`PLANT-01`…`PLANT-08`), each with ~15–25 production lines; each line has ~3–6 machines with telemetry. The demo samples ~1,200 lines. `PLANT-03` is the **Ohio plant** (the hero's plant).

**Hero line**: `LINE-04` at `PLANT-03` (Ohio) — a production line whose lead machine's telemetry (vibration + temperature) has trended into elevated failure risk over ~3 weeks, with the replacement part **NOT stocked locally** (would need expediting). The demo's spotlight. Deterministic. Its failure-risk score is high (~0.87) and the recommended maintenance play the heuristic ranks first is **pull_now** (planned downtime) — because the expected cost of an unplanned stop (downtime at ~$22K/hr + expedited-parts premium + SLA exposure) exceeds the cost of pulling it now for planned maintenance.

**The parts + supplier catalog** carries a searchable **`description`** (part, machine fitment, where it's stocked, lead time) — the text **Lakebase Search** (Milestone 2) indexes, and what the app's maintenance-context search + the **expedite-parts** play query run over (matching a line's failing machine to a part + whether it's local or needs expediting).

**The anomaly (one driver, two visible symptoms)**: ~3 weeks ago a run of high-utilization production wore a cluster of machines toward failure faster than the planned-maintenance schedule anticipated. On the **affected lines**:
- **Risk side (the alarm)** — ~90 production lines crossed into **elevated failure risk** (`failure_risk_score` climbing from a ~0.15 baseline to ~0.7–0.9) in the last ~3 weeks, driven by rising vibration/temperature telemetry + open work-order backlog (shown RED).
- **Parts side** — many of those lines need a replacement part that is **not stocked locally** (would need expediting if the line stops unplanned) — the compounding cost that shifts the pull-now-vs-run math.
- **Healthy side** — the rest of the sampled fleet (~1,200 lines) sits at a normal ~0.03–0.2 risk running to plan (shown STEEL/blue).

This is the load-bearing shape: **production lines trending toward a stop, rising telemetry, parts-expedite exposure, concentrated in a recent 3-week window** — legible on one plant-floor view (a failure-risk × utilization scatter, or lines ranked by risk, a red cluster). The recommended action ("pull it now") is literally supported by the data because the line's telemetry is trending to failure AND the part isn't local, so an unplanned stop costs more than planned downtime.

**Failure-signal notes** (verbatim technician/work-order-note phrases, used predominantly on the affected at-risk lines — feed the note pool so `ai_classify` has a clear signal). Rising-risk tone: *"vibration trending up on spindle bearing"*, *"temperature above threshold, coolant checked"*, *"intermittent fault, part not in local stock"*, *"backlog on preventive maintenance"*, *"operator reports unusual noise"*. Healthy tone (for stable lines): *"running to plan, no faults"*, *"pm completed on schedule"*. These must be exact substrings — Genie + the dashboard search for them.

**Time references**: `NOW = datetime.now()` by default (rolling; set `VOLTA_PIN_TIME=1` to freeze). `HISTORY_START = NOW − 18 months` (telemetry + work-order + failure history for the model). `WEAR_ONSET = NOW − 21 days` (~3 weeks back — the high-utilization run / wear begins). `RISK_RAMP = NOW − 18 days` (affected lines' failure risk climbs). `SNAPSHOT_DATE = NOW − 1 day` (the "current" plant-floor snapshot). **Causal chain**: stable fleet before −3w → high-utilization run at −3w → affected lines' telemetry degrades + risk ramps −3w to −1w → everyone else stable → the CURRENT snapshot shows the at-risk cluster. Peak of the risk divergence sits in the past week-and-a-half, left of the chart edge.

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen` (read `SKILLS/databricks-synthetic-data-gen/SKILL.md`). Use the pre-provisioned databricks-connect venv (Python 3.12). Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window + `F.element_at`. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, no `raw_` prefix). SDP silver reads via `read_files()` — no bronze:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_lines` | ~1,200 | Production lines across 8 plants. `plant_id`, `line_name`, `machine_type`, `plant_lat`/`plant_lng` (plant anchor + jitter — drives the map), `install_date`, `criticality` (`high`/`medium`/`low` — SLA weight). `LINE-04` at `PLANT-03` pinned as the hero. |
| `raw_parts` | ~800 | Parts catalog: replacement parts per machine type. `part_type`, `unit_cost_usd`, `lead_time_days`, `local_stock_qty` (0 = must expedite), plus a searchable **`description`** (part + fitment + stock/lead-time) — indexed by **Lakebase Search**; the **expedite-parts** play queries it. |
| `raw_telemetry` | ~3.5M | 18 months of daily machine telemetry rollups (one row per line×day). `vibration_rms`, `temperature_c`, `utilization_pct`, `error_count`. The affected lines' vibration/temperature ramp from `RISK_RAMP`. |
| `raw_work_orders` | ~120K | Maintenance work orders over 18 months. `wo_type` (`preventive`/`corrective`/`emergency`), `opened_date`, `closed_date` (nullable — NULL = open), `part_id` (FK, nullable), `downtime_hours`, `status`. The affected lines have OPEN corrective backlog. |
| `raw_risk_snapshots` | ~120K | Daily `failure_risk_score` (0–1) for the affected lines across the last ~14 days + a current-snapshot sample of everyday lines. Affected → 0.7–0.9; everyday → 0.03–0.2. Carries `technician_note_text` (the `ai_classify` signal). |
| `raw_maintenance_events` | ~35K | 18-month history of maintenance decisions taken on at-risk lines, each with an OUTCOME (`avoided_unplanned_stop` bool, `downtime_cost_avoided_usd`, `action_cost_usd`, `downtime_hours`) — the **training data for the failure-risk model** (`03-ml-maintenance.md`). ~3 action types: `pull_now`, `run_to_shift_end`, `expedite_parts_and_run`. |

### Data Variation

Telemetry + risk — the load-bearing shape is the **affected-line failure divergence**, but everyday telemetry needs realistic rhythm:
- **Weekly rhythm** — utilization dips on weekends; ±10% noise on vibration/temperature.
- **Baseline** — most lines sit at low, stable failure risk (0.03–0.2) with vibration/temperature in-band. Keep it calm so the affected ramp dominates.
- **A few everyday corrective WOs** — a small background rate so the fleet isn't unnaturally static, placed so it doesn't collide with the affected-cohort signal.

**The affected-line split (the whole story):** failure risk is **telemetry-and-wear-driven**, not uniform. The high-utilization run pushes the ~90 affected lines' vibration/temperature up and risk from baseline to 0.7–0.9 over ~3 weeks; everyone else stays calm. This single rule produces the red cluster without forcing it.

### Note pool (`technician_note_text` on risk snapshots)

~15 hand-coded strings in 2 tones. **Rising-risk** (must include the Shared-Context failure-signal phrases verbatim): attached predominantly to the affected at-risk lines. **Healthy**: "running to plan, no faults", "pm completed on schedule". **Distribution**: affected at-risk → 85% rising-risk / 15% healthy · everyday → 10% rising-risk / 90% healthy.

### Plant/line master + geo

Each line inherits its plant's `plant_lat`/`plant_lng` (DOUBLE) + jitter so points spread. The ~90 affected lines spread across plants but concentrate the hero at `PLANT-03`/`LINE-04`. The map colors by `risk_band` (derived in gold), not raw criticality.

### The Event

- **Affected lines** (~90): `failure_risk_score` ramps from ~0.15 starting `RISK_RAMP`, climbing to 0.7–0.9 over ~10 days, with vibration/temperature above threshold in `raw_telemetry` and OPEN corrective work orders in `raw_work_orders`. Many need a part with `local_stock_qty = 0` (must expedite). Notes rising-risk-toned.
- **Everyday lines** (~1,200): failure risk 0.03–0.2, telemetry in-band, notes healthy.
- **Everything else** normal — the divergence is confined to the affected lines.

Quantify the exposure so the KPIs land: **downtime-at-risk exposure** ≈ **$3.3M** (affected lines × failure probability × expected unplanned-stop hours × ~$22K/hr); **open corrective work orders** ≈ ~150 on the affected cohort. Demo targets — the generation should roll up roughly to them.

**Maintenance-decision history (`raw_maintenance_events`) — the model's training signal.** Over 18 months, generate realistic maintenance decisions with outcomes so the model in `03-ml-maintenance.md` can learn which action avoids the most downtime cost per dollar in which situation:
- `pull_now` (planned downtime for maintenance): moderate cost (planned downtime hours); **best when failure risk is high AND the part isn't local** (the hero case) — avoids a costly unplanned stop.
- `run_to_shift_end` (defer, accept the risk): cheapest if it holds; but when failure risk is high it often leads to an unplanned stop (high `downtime_cost` + expedited parts) — the gamble that loses on high-risk lines.
- `expedite_parts_and_run` (rush the part, keep running): high parts cost but avoids the immediate stop; wins when failure risk is moderate and the line's output is time-critical.
- Make outcomes **learnable**: pull_now on high-risk, non-local-part lines shows the best `downtime_cost_avoided` per `action_cost`; run_to_shift_end wins on low-risk lines; expedite wins on moderate-risk time-critical lines. This lets the model rank `LINE-04` as **pull_now**.

### Raw table schemas (gen output)

ID formats: `LINE-NNNN` / `PLANT-NN` / `PART-NNNNN` / `WO-NNNNNNNN` / `MEV-NNNNNNNN`. PKs in **bold**, FKs marked.

- **`raw_lines`** — **line_id**, plant_id, line_name, machine_type, plant_lat/plant_lng (DOUBLE), install_date (DATE), criticality (`high/medium/low`), is_active.
- **`raw_parts`** — **part_id**, part_name, part_type, machine_type (FK-ish — which machine it fits), unit_cost_usd (DOUBLE), lead_time_days (INT), local_stock_qty (INT — 0 = must expedite), **description** (STRING), is_active.
- **`raw_telemetry`** — line_id (FK), telemetry_date (DATE), vibration_rms (DOUBLE), temperature_c (DOUBLE), utilization_pct (DOUBLE), error_count (INT). One row per line×day.
- **`raw_work_orders`** — **wo_id**, line_id (FK), wo_type (`preventive/corrective/emergency`), part_id (FK, nullable), opened_date (DATE), closed_date (DATE, nullable), downtime_hours (DOUBLE), status (`open/closed`).
- **`raw_risk_snapshots`** — line_id (FK), snapshot_date (DATE), failure_risk_score (DOUBLE 0–1), open_wo_count (INT), technician_note_text (STRING, nullable). Daily last ~14 days + `SNAPSHOT_DATE`.
- **`raw_maintenance_events`** — **event_id**, line_id (FK), action_type (`pull_now/run_to_shift_end/expedite_parts_and_run`), risk_at_action (DOUBLE), part_local (BOOLEAN), initiated_date (DATE), action_cost_usd (DOUBLE), downtime_hours (DOUBLE), avoided_unplanned_stop (BOOLEAN), downtime_cost_avoided_usd (DOUBLE). 18-month history — the model's labeled outcomes.

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md` before implementing.

Create pipeline `volta_plant_floor`. Configure with `configuration: {catalog, schema}` and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')`.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (downtime exposure $, open WOs #, at-risk #) + trend | risk/downtime exposure by plant + machine_type + risk band | `mv_line_risk` metric view (over `gold_line_status`) |
| Dashboard scatter/map + at-risk widgets | per line current position with geo + plant + telemetry + risk + band flag | `gold_line_status` |
| Genie "which lines are trending to a stop and why" | same per-line fact with denormalized telemetry + WO + note | `gold_line_status` |
| Failure model training | one row per historical maintenance decision + features + outcome | `gold_maintenance_outcomes` |
| Failure model scoring input | one row per OPEN at-risk line + candidate-action + parts context | `gold_open_atrisk` |
| App's floor queue (at-risk + ranked action) | current at-risk with line/telemetry/geo + ranked action + expected downtime cost | `gold_open_atrisk` JOIN `gold_maintenance_recommendations` |
| App's analytics drill-downs | telemetry trend, worst lines, per-plant rollups | `silver_telemetry`, `gold_line_status` |

### Raw layer (no bronze)

Section A writes 6 raw parquet datasets: `lines`, `parts`, `telemetry`, `work_orders`, `risk_snapshots`, `maintenance_events`. SDP silver reads via `read_files()`.

### Raw → Silver (joins + expectations + `ai_classify` dedup MV)

**`note_risk_flags`** — *the `ai_classify` showcase, deduped*. Over `SELECT DISTINCT technician_note_text`, call `ai_classify(note, ARRAY('failing','degrading','healthy'))` once per distinct string → `risk_signal_score` (1.0/0.6/0.1). `silver_risk` joins back on the note so every snapshot inherits the score without a second LLM call.

**`silver_telemetry`** — per line×day denormalized. `raw_telemetry` JOIN `raw_lines`. Cluster by `telemetry_date`.
**`silver_risk`** — current + recent risk position. `raw_risk_snapshots` JOIN `raw_lines` JOIN `note_risk_flags`. Cluster by `snapshot_date`.
**`silver_work_orders`** — per-line WO rollup: `open_wo_count`, `has_open_corrective`, latest part needed.
**`silver_maintenance`** — maintenance-decision history denormalized. Powers the model training table.

### Silver → Gold (aggregations)

**Dashboard-filter contract.** Every dashboard aggregate MUST carry `plant_id`, `machine_type`, and `risk_band`.

**`gold_line_status`** — *the heart* — one row per line reflecting the CURRENT position (`snapshot_date = SNAPSHOT_DATE`) with telemetry, WO backlog, risk, band. Built from `silver_risk` (current) JOIN latest `silver_telemetry` + `silver_work_orders` on `line_id`. Dims: `line_id`, `plant_id`, `line_name`, `machine_type`, `criticality`, `plant_lat`, `plant_lng`. Fields: `vibration_rms`, `temperature_c`, `utilization_pct`, `failure_risk_score`, `open_wo_count`, `has_open_corrective`, `part_local` (is the needed part in local stock), `risk_signal_score`, and derived measures + a status flag:
- `downtime_exposure_usd` — for at-risk lines: `failure_risk_score × expected_unplanned_hours × 22000` (demo ~$22K/hr, ~2 expected hours per line) when `failure_risk_score ≥ 0.6` else 0 — rolls the ~95 at-risk lines up to ~$3.3M.
- **`risk_band`**: `'critical'` (`failure_risk_score ≥ 0.75` AND `has_open_corrective`), `'elevated'` (`≥ 0.6`), `'watch'` (`≥ 0.4`), `'healthy'` (else). Affected lines → `critical`/`elevated`.

> `gold_line_status` is the coherence spine — dashboard, metric view, Genie, and the app all read it.

**`gold_open_atrisk`** — `gold_line_status WHERE risk_band IN ('critical','elevated','watch')`, enriched with candidate-action + parts context: `part_local` (BOOLEAN — is the needed part stocked locally), `candidate_part_id` (the replacement part), `part_lead_time_days`, `part_unit_cost_usd`, and the line's `criticality` (SLA weight). Columns: line/geo/plant + `failure_risk_score`, `downtime_exposure_usd`, `open_wo_count`, `part_local`, `candidate_part_id`, `part_lead_time_days`, `part_unit_cost_usd`, `criticality`.

**`gold_maintenance_outcomes`** — maintenance history, one row per decision. Pass-through from `silver_maintenance` + features: `action_type`, `risk_at_action`, `part_local`, `action_cost_usd`, `downtime_hours`, `avoided_unplanned_stop`, `downtime_cost_avoided_usd`. The heuristic's coefficient source + the OPTIONAL ML training table.

**`gold_maintenance_recommendations`** — *the ranked action per open at-risk line* — **built by the pipeline HEURISTIC** (ML optional, `03-ml-maintenance.md`). For each row in `gold_open_atrisk`, construct the three candidate actions and rank by **net value = downtime_cost_avoided − action_cost**. The **`part_local` flag is the key lever** — expediting a part that isn't stocked locally is slow AND costly, which is what makes pulling the line now the right call for the hero (non-local part). Let `stop = 4h × 22000`:
- **pull_now**: `downtime_cost_avoided ≈ failure_risk_score × stop` (avoids the unplanned stop), `action_cost ≈ 40000` (a planned 2h pull + lost production on a high-value line — a real, fixed opportunity cost). **Best net when risk is high AND the part isn't local** (expedite can't help fast, running risks the full stop). The hero case.
- **run_to_shift_end**: `downtime_cost_avoided ≈ 8000` (keeps producing to shift end — a small output value), `action_cost ≈ failure_risk_score × stop × (0.6 if part_local else 1.0)` — the expected cost of the gamble. On any genuinely at-risk line this net is negative (you should act), so it's the "defer / do nothing" baseline that loses here — as it should.
- **expedite_parts_and_run**: `downtime_cost_avoided ≈ failure_risk_score × stop × (0.6 if part_local else 0.3)` (a local part rushes in and largely averts the stop; a non-local part can't arrive fast, so it averts little), `action_cost ≈ part_unit_cost × 2 + 400` if local, else `part_unit_cost × 3 + lead_time_days × stop_rate` (the rush premium + downtime waiting for a non-local part). **Wins on moderate-risk lines whose part IS local** — the second cohort in the mix.
- `net_value = downtime_cost_avoided − action_cost`; `recommended_action` = argmax; `action_ranking` = JSON array of all three with `net`/`cost`. Columns match `03-ml-maintenance.md` → Inference shape. Coefficients mirror `gold_maintenance_outcomes`, so **pull_now wins for `LINE-04`** (high risk, non-local part) while **expedite_parts_and_run wins for moderate-risk local-part lines** — a plausible mix, not 100% one action.

### Consumer routing

- `mv_line_risk` (over `gold_line_status`) → dashboard KPIs + Genie headline answers.
- `gold_line_status` → dashboard scatter/map + at-risk/plant widgets.
- `gold_open_atrisk` → model scoring input AND (joined with output) the app's floor queue.
- `gold_maintenance_recommendations` → app's floor queue + dashboard action widgets.
- `gold_maintenance_outcomes` → heuristic coefficients + OPTIONAL ML training.
- `silver_telemetry` → app analytics drill-downs.

---

## C. Validation

Run before `03-ml-maintenance.md`.

**Load-bearing (must pass):**
- **The hero line exists** — `gold_line_status WHERE line_id='LINE-04' AND plant_id='PLANT-03'` → `failure_risk_score ≥ 0.75`, `risk_band = 'critical'`, `has_open_corrective = true`, `part_local = false`, `downtime_exposure_usd > 0`.
- **The hero has a non-local part + candidate action** — `gold_open_atrisk WHERE line_id='LINE-04'` → `part_local = false`, `candidate_part_id` present, `part_lead_time_days` > 0.
- **High-risk cluster** — `gold_line_status` GROUP BY `plant_id`, `risk_band`: ~90 critical/elevated lines spread across plants; the rest healthy.
- **Anomaly confined** — the vast majority of lines are `healthy`.
- **Exposure KPIs land** — `SUM(downtime_exposure_usd)` ≈ $3.3M; open corrective WOs ≈ ~150 (±20% OK).
- **`risk_signal_score` separates** — affected at-risk ≥ 0.6; healthy ≤ 0.2.
- **`note_risk_flags` dedup works** — `COUNT(DISTINCT technician_note_text) << COUNT(*)`.
- **Maintenance outcomes are learnable** — `gold_maintenance_outcomes` GROUP BY `action_type`: pull_now on high-risk/non-local shows the best `downtime_cost_avoided` per `action_cost`; run_to_shift_end on low-risk; expedite on moderate. If they don't separate, regenerate.
- **Risk ramp is in the past** — daily `AVG(failure_risk_score)` on affected lines shows a build ~2.5w ago.
- **Action mix is plausible** — the heuristic produces a MIX driven by `part_local`: pull_now on the high-risk / non-local-part lines (incl. the hero), expedite_parts_and_run on moderate-risk lines whose part is local. Roughly a 50/50 split, not 100% one type. (run_to_shift_end is the "defer" baseline — it loses on any genuinely at-risk line, which is correct.)

**Smoke checks**: `plant_id` in `PLANT-01..08`; line geo non-null + in earth-bounds; `risk_band` enum is the 4 values; `gold_open_atrisk` ~90–200 rows; `failure_risk_score` in [0,1]; `vibration_rms`/`temperature_c` never negative.

Add `pipeline_id` to `resources.json`.

# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-maintenance.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products** — do **not** build resources for these: **Databricks One** (workspace surface), **Genie Code** (authoring assist), **Unity Catalog** / **Unity AI Gateway** (governance layers).

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md` before implementing.

Create `Volta Plant Floor` Genie Space.

### Tables

`mv_line_risk` (canonical exposure metric view over `gold_line_status`), `gold_line_status` (per-line current position: telemetry, WO backlog, `failure_risk_score`, `risk_band`, geo — used for scatter + plant/machine rollups via GROUP BY), `gold_open_atrisk` (current at-risk lines + parts context), `gold_maintenance_recommendations` (the ranked action per line + predicted downtime cost avoided), `raw_parts` (parts catalog + local stock), `raw_lines` (line master + plant + geo).

### Self-sufficient room

- **Space `description`** (via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the event (high-utilization run → lines trending to failure with parts-expedite exposure) + the headline exposure + the pull-now-vs-run angle. Lift from the README.
- **Story-context `text_instruction`** at the TOP: WHAT HAPPENED · WHAT TO HELP SAM DO · TONE. ~5-8 lines.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc, same order.

### Instructions

```
You analyze Volta Industrial plant-floor data for Sam Ortiz (VP Manufacturing Operations, non-technical).

CONTEXT: A high-utilization run ~3 weeks ago wore a cluster of production lines toward failure —
rising vibration/temperature telemetry, open corrective work orders, and parts that would need
expediting if a line stops unplanned. ~90 critical lines across 8 plants, while the rest of the
~1,200-line fleet runs to plan. Unplanned downtime costs ~$22K/hour.

BASELINES: A healthy line sits at failure_risk_score ~0.03-0.2 with vibration in-band. risk_band is
the single signal: 'critical' (risk >= 0.75 with an open corrective WO), 'elevated' (>= 0.6),
'watch' (>= 0.4), 'healthy'. The part_local flag decides which plays are viable: expedite_parts_and_run
only nets positive value when the part is stocked LOCALLY (short lead time) — that's a moderate-risk
line's play. For a high-risk line whose part is NON-local (like LINE-04's ~14-day lead time), expedite
is the weakest option and pull_now wins. Never present the three actions as co-equal.

HEADLINE NUMBERS — always answer from mv_line_risk:
- "What's our downtime exposure?" → MEASURE(downtime_exposure)
- "How many open work orders?" → MEASURE(open_work_orders)
- "How many lines are critical?" → MEASURE(critical_count)

INVESTIGATION FLOW for "which lines are trending to a stop and why?":
1. mv_line_risk → MEASURE(critical_count) + MEASURE(atrisk_count) by plant_id → where the risk is
2. gold_line_status → the at-risk cluster on rising vibration/temperature with open corrective WOs (GROUP BY plant_id, risk_band)
3. gold_open_atrisk WHERE line_id='LINE-04' → the hero: high risk, part not local
4. gold_maintenance_recommendations → the recommended action (pull_now/run_to_shift_end/expedite_parts_and_run) + predicted downtime cost avoided
Conclude + suggest: "Want me to rank the action for LINE-04?"

ACTION FOLLOW-UP:
- "What should we do about LINE-04?" → gold_maintenance_recommendations for that line → recommended_action + predicted_downtime_cost_avoided_usd + the action_ranking options. LINE-04's part is non-local, so pull_now wins and expedite is the weakest play — say so.
- "When does expediting the part make sense?" → expedite_parts_and_run wins only on moderate-risk lines whose part is stocked locally (part_local = true); for a high-risk, non-local line, pull now.
- "How much downtime cost could we avoid across all at-risk lines?" → SUM(predicted_downtime_cost_avoided_usd).
- "How many lines should we pull now vs expedite?" → GROUP BY recommended_action.
```

### Sample Questions — 7-step story arc

1. **Headline** — "What's our downtime exposure right now, and how many open work orders?" → `MEASURE(downtime_exposure)` + `MEASURE(open_work_orders)` from `mv_line_risk`.
2. **The cluster** — "Which plants is the failure risk concentrated in?" → `MEASURE(atrisk_count)` GROUP BY `plant_id`.
3. **Drill to the driver** — "What do these at-risk lines have in common?" → `gold_line_status` GROUP BY `machine_type`, `risk_band` → rising vibration/temperature + open corrective WOs.
4. **The hero line** — "LINE-04 is trending toward a stop — how bad is it and is the part in stock?" → `gold_open_atrisk WHERE line_id='LINE-04'` → high risk, part not local.
5. **The recommendation** — "Should we pull LINE-04 now or run it to the end of the shift?" → `gold_maintenance_recommendations` for that line → `recommended_action = 'pull_now'`, `predicted_downtime_cost_avoided_usd`, the ranked options.
6. **Portfolio impact** — "Across all at-risk lines, how much downtime cost could we avoid, and by which action?" → `gold_maintenance_recommendations` SUM + GROUP BY `recommended_action`.
7. **Expedite side** — "Which lines are best served by expediting the part instead of pulling?" → `gold_maintenance_recommendations WHERE recommended_action='expedite_parts_and_run'` JOIN `gold_open_atrisk`.

### Validation

"What's our downtime exposure?" → from `mv_line_risk` (`MEASURE(downtime_exposure)`), matches the dashboard tile. "Which lines are at risk?" → lines on rising telemetry with open corrective WOs. "LINE-04?" → pull_now with a downtime-cost-avoided figure. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md`. The skill owns the JSON shape; this spec is story-level.

Create `Volta Plant Floor` dashboard. Save at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less**. Link the Genie space. (Save the Genie space at the project root too — `./genie_space.json`.)

### Why this dashboard works

- **Two pages, one story**: page 1 the glance — *"a cluster of lines is trending toward a stop with parts-expedite exposure; here's the exposure and where."* Page 2 the deep-dive — *"which lines, which plants, and what the model recommends."*
- **One metric view + two datasets**: `mv_line_risk` (KPI tiles + plant splits), `gold_line_status` (scatter, plant/machine rollups), `gold_maintenance_recommendations` (action-mix + cost-avoided widget).
- **A risk scatter is the visual hook**: full-width scatter — x = `vibration_rms`, y = `failure_risk_score`, color = `risk_band` — a red cluster in the high-vibration/high-risk quadrant. (A plant map by `plant_lat`/`plant_lng` is a fine second view.)
- **One AI showcase per page**: page 1's scatter carries the `ai_classify` risk signal; page 2 surfaces the **maintenance recommendation**.
- **Clean theme — no borders, white canvas**: red = critical, amber = watch.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the event.

### Theme

```
canvasBackgroundColor: #F5F7FB (light) / #0F1419 (dark)
widgetBackgroundColor: #FFFFFF (light) / #161B22 (dark)
widgetBorderColor:     same as widgetBackgroundColor
fontColor:             #1F2530 (light) / #E8ECF0 (dark)
selectionColor:        #4F7CE3 (light) / #8ACAFF (dark)
visualizationColors:   ["#094074","#3C6997","#5ADBFF","#FFB020","#E5484D"]
widgetHeaderAlignment: LEFT
```

**Semantic colors (literal-hex pinned, NEVER `themeColorType: position N`):** Critical/at-risk → `#E5484D` red · Watch/elevated → `#FFB020` amber · Healthy → `#3C6997` steel blue.

**`risk_band` color pins:** critical `#E5484D` · elevated `#FFB020` · watch `#FFB020` · healthy `#3C6997`.

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_exposure` | `SELECT plant_id, machine_type, risk_band, criticality, MEASURE(\`downtime_exposure\`) AS downtime_exposure_usd, MEASURE(\`open_work_orders\`) AS open_work_orders, MEASURE(\`critical_count\`) AS critical_count, MEASURE(\`atrisk_count\`) AS atrisk_count, MEASURE(\`line_count\`) AS line_count FROM mv_line_risk GROUP BY ALL` | 4 KPI counters + plant/band split bars |
| `ds_lines` | `SELECT line_id, plant_id, machine_type, criticality, plant_lat, plant_lng, risk_band, failure_risk_score, vibration_rms, temperature_c, open_wo_count, downtime_exposure_usd FROM gold_line_status` | Risk scatter, per-plant rollups, worst-line tables |
| `ds_maintenance` | `SELECT line_id, recommended_action, predicted_downtime_cost_avoided_usd, predicted_net_value_usd FROM gold_maintenance_recommendations` | Recommended-action mix + total predicted cost avoided |

**No hardcoded clamps** — the global filters scope.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Plant | `plant_id` | ds_exposure, ds_lines | All |
| Machine type | `machine_type` | ds_exposure, ds_lines | All |
| Risk band | `risk_band` | ds_exposure, ds_lines | All |

Bind only the datasets above — **do NOT bind `ds_maintenance`** (keyed by at-risk line).

### Page 1 — Plant Floor (the glance)

**Row 1** — title markdown. *"Volta Plant Floor. Sam Ortiz, VP Manufacturing Operations. A high-utilization run ~3 weeks ago wore a cluster of lines toward failure (red — trending to a stop). This dashboard tracks the downtime exposure and the recommended action."*

**Row 2 — 4 × `counter`** (`ds_exposure`):
- **Downtime exposure** · `SUM(\`downtime_exposure_usd\`)` · `number-currency` USD compact · red.
- **Open work orders** · `SUM(\`open_work_orders\`)` · number compact · amber.
- **Critical lines** · `SUM(\`critical_count\`)` · number compact · red.
- **At-risk lines** · `SUM(\`atrisk_count\`)` · number compact · amber.

**Row 3 — `scatter` · "Failure risk vs vibration"** (full width). `ds_lines`. x = `vibration_rms`, y = `failure_risk_score`, color = `risk_band` (pins), size = `open_wo_count`. Sample healthy lines (`WHERE risk_band != 'healthy' OR rand() < 0.1`). Tooltip: line_id, plant_id, machine_type, vibration, failure_risk, risk_band. *The red cluster (high vibration, high risk) — the lines about to stop. LINE-04 is the zoom target.*

**Row 4 — two side-by-side**
- **`bar` grouped · "At-risk lines by plant & band"** · `ds_exposure` · x = `plant_id`, y = `SUM(atrisk_count)`, color = `risk_band` (pins).
- **`bar` horizontal · "Downtime exposure by machine type"** · `ds_exposure` · y = `machine_type`, x = `SUM(downtime_exposure_usd)`.

### Page 2 — Maintenance (the deep-dive)

**Row 1** — title markdown. *"Maintenance — pull now or run? The lines trending to a stop, whether the part is local, and the model's recommended action with the downtime cost it avoids."*

**Row 2 — worst lines**
- **`table` · "Highest downtime exposure"** · `ds_lines` · `WHERE risk_band IN ('critical','elevated')`, columns line_id, plant_id, machine_type, vibration_rms, failure_risk_score, `downtime_exposure_usd`, sort exposure DESC · *LINE-04 near the top.*
- **`table` · "Rising-risk watch list"** · `ds_lines` · `WHERE risk_band='watch'`, columns line_id, plant_id, failure_risk_score, open_wo_count, sort risk DESC.

**Row 3 — the failure model**
- **`bar` · "Recommended action (mix)"** · `ds_maintenance` · x = `recommended_action`, y = `COUNT(1)` · *pull_now on high-risk/non-local lines; expedite on moderate/local — the model isn't a fixed rule.*
- **`counter` · "Total predicted downtime cost avoided"** · `ds_maintenance` · `SUM(\`predicted_downtime_cost_avoided_usd\`)` · `number-currency` USD compact · color `#094074`.

**Row 4 — `table` · "Maintenance recommendations"** (full width) · `ds_maintenance` joined to `ds_lines` for names · columns line_id, plant_id, `recommended_action`, `predicted_downtime_cost_avoided_usd`, `predicted_net_value_usd`, sort net value DESC.

### Validation

Open the published dashboard and confirm: the scatter shows a red high-vibration/high-risk cluster, the exposure tiles land (~$3.3M downtime exposure), LINE-04 appears in the highest-exposure table, the recommended-action mix is a plausible blend (pull_now + expedite), and the global filters update every widget. Sanity-check that Genie's "what's our downtime exposure?" matches `MEASURE(downtime_exposure)`. Add `dashboard_id` to `resources.json`.

---

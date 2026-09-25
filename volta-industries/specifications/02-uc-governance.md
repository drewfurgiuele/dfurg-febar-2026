# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_line_risk`

Source: `gold_line_status` (the current per-line position). Single view, aggregated materialization. This is the **one governed definition** of Volta's downtime-exposure metrics — the dashboard KPI tiles, Sam's Genie answers, and the app all read these same measures.

**Dimensions**: `plant_id`, `machine_type`, `risk_band`, `criticality`, `line_id`.

**Measures**:

| Name | Expression |
|------|------------|
| `downtime_exposure` | `SUM(downtime_exposure_usd)` |
| `open_work_orders` | `SUM(open_wo_count)` |
| `line_count` | `COUNT(1)` |
| `critical_count` | `SUM(CASE WHEN risk_band = 'critical' THEN 1 ELSE 0 END)` |
| `elevated_count` | `SUM(CASE WHEN risk_band = 'elevated' THEN 1 ELSE 0 END)` |
| `atrisk_count` | `SUM(CASE WHEN risk_band IN ('critical','elevated') THEN 1 ELSE 0 END)` |
| `avg_failure_risk` | `AVG(failure_risk_score)` |
| `avg_vibration` | `AVG(vibration_rms)` |

Count/flag measures use `SUM(CASE WHEN … )` so they compute at the filtered-slice level. `avg_failure_risk`/`avg_vibration` are coarse health signals, not KPI tiles (downtime exposure + open WOs + at-risk count are the tiles).

**Materialization**: aggregated on `(plant_id, machine_type, risk_band, criticality) × all measures`, refresh every 6h.

### Consumers

- **Dashboard KPI tiles** — Downtime exposure ($), Open work orders (#), At-risk lines (#), Critical lines (#) — all via `MEASURE(...)`.
- **Genie headline answers** — "what's our downtime exposure?", "how many open work orders?", "how many lines are critical?" resolve to these measures.
- **The app's KPI cards** — the Plant Floor page reads the same measures (via warehouse SQL over the MV).

> The failure model (`03-ml-maintenance.md`) does **not** consume `mv_line_risk`. It trains on `gold_maintenance_outcomes` (per-decision history) and scores `gold_open_atrisk` (per-line) — different grain.

### Validation

- `MEASURE(downtime_exposure)` across at-risk ≈ $3.3M (matches the raw gold rollup ≈ $3.55M).
- `MEASURE(critical_count)` ≈ 90; `MEASURE(atrisk_count)` ≈ 95.
- Genie's "what's our downtime exposure?" matches `MEASURE(downtime_exposure)` for that slice.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.

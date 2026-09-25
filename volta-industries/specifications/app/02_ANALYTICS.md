# Analytics Page

Light, bespoke charts over Delta (via SQL Warehouse) — secondary to the embedded AI/BI dashboard. Reads the Gold tables the SDP pipeline wrote (`01-lakeflow.md`), NOT Lakebase.

## Charts (2–4, aligned to the story's key numbers)

Rewrite/replace every file in `config/queries/` for this domain (the template ships LuxeBeauty examples that point at nothing). Update `client/src/analytics/AnalyticsView.tsx` so its `queryKey` list matches the files kept. Suggested set:

- **`vibration_trend.sql`** — daily/weekly `AVG(vibration_rms)` on the affected lines vs the rest of the fleet, last ~8 weeks, from `silver_telemetry`. *The line that tells the wear story: the affected lines' vibration ramps ~3 weeks ago while the rest stays flat.*
- **`highest_exposure_lines.sql`** — top at-risk lines by `downtime_exposure_usd` from `gold_line_status WHERE risk_band IN ('critical','elevated')`: line_id, plant_id, machine_type, vibration_rms, failure_risk_score, exposure $. *LINE-04 near the top.*
- **`risk_mix_by_plant.sql`** — line count by `plant_id` × `risk_band` from `gold_line_status`. *Which plants carry the risk.*
- **`action_mix.sql`** *(optional)* — the model's recommended-action mix + `SUM(predicted_downtime_cost_avoided_usd)` from `gold_maintenance_recommendations`.

Each `.sql` uses bare/`${catalog}.${schema}` table names resolved at boot (the template's placeholder `FROM` clauses point at nothing — replace them, or `/analytics` logs `TABLE_OR_VIEW_NOT_FOUND`).

## Line drill-down (optional)

A small panel: pick a plant → list its worst at-risk lines → click a line → navigate to `/plant-floor?line=<line_id>` (the queue reads the query params and filters). Mirrors the template's facility drill-down, rekeyed to lines.

# Data Model

> **This is the Milestone 2 (Lakebase) answer key.** A UC synced table is **read-only** in Postgres, so the app's write actions need a separate writable table. One **synced read-only** line-status table + one **writable** work-orders table.

## Two stores

- **Delta tables** — lakehouse source of truth, read-only from the app. SQL Warehouse + Genie read here.
- **Lakebase Postgres** — the low-latency serving + write surface: chat state + synced read-only mirrors + a writable table for work orders.

## Lakebase schema (`app.*`)

### Chat state (reusable — keep as-is across demos)

| Table | Key fields |
|-------|-----------|
| `conversations` | id, userEmail, title, kind (`demo_dock`/`default`), timestamps |
| `messages` | conversationId, role, content, position, traceId, thinking (JSONB), error |
| `feedback` | messageId, value (`up`/`down`), rationale, traceId, mlflowAssessmentId |

### Synced read-only mirror (from Delta — Volta-specific)

Read-only from the app (UC synced tables). SELECT for sub-ms per-line reads; never written.

| Table | Source (Delta) | Key fields |
|-------|--------|-----------|
| `line_status` | `gold_line_status` | lineId, plantId, lineName, machineType, criticality, **plantLat**, **plantLng** (drives the map), vibrationRms, temperatureC, utilizationPct, failureRiskScore, openWoCount, hasOpenCorrective, candidatePartId, partLocal (bool), partUnitCostUsd, partLeadTimeDays, riskSignalScore (0–1 from `ai_classify`), downtimeExposureUsd, **riskBand** (`critical`/`elevated`/`watch`/`healthy`) |
| `open_atrisk` | `gold_open_atrisk` | lineId (PK), failureRiskScore, downtimeExposureUsd, openWoCount, partLocal, candidatePartId, partLeadTimeDays, partUnitCostUsd, criticality |
| `maintenance_recommendations` | `gold_maintenance_recommendations` (pipeline heuristic; optionally the ML model in `03-ml-maintenance.md`) | lineId (PK), recommendedAction (`pull_now`/`run_to_shift_end`/`expedite_parts_and_run`), predictedDowntimeCostAvoidedUsd (double), predictedNetValueUsd (double), actionRanking (JSONB — all three options), scoredAt (timestamp) |
| `parts` | `raw_parts` (synced) | **partId** (PK), partName, partType, machineType, unitCostUsd, leadTimeDays, localStockQty (0 = must expedite), **description** (STRING — searchable), isActive. Indexed by **Lakebase Search** (Milestone 2) over (name, description) for the expedite-play lookup. |

The `maintenance_recommendations` table is **read-only from the app** — the model's predictions kept in Lakebase so `rank_maintenance_actions` is sub-second. The model lives in UC (`{catalog}.{schema}.failure_recommender`, `@prod`); the app never calls it. `actionRanking` (JSONB) powers the ranked-options list + arithmetic what-if.

The `parts` table is a **read-only synced mirror**; the agent's `search_parts` tool queries it via **Lakebase Search** to find the replacement part + whether it's local when ranking the **expedite-parts** play (hybrid text/vector over name + description).

### Writable operational table (app writes here — the Milestone-2 writable-table requirement)

| Table | Written by | Key fields |
|-------|-----------|-----------|
| `work_orders_app` | the app / agent's `execute_maintenance_action` | id (PK), lineId, actionType (`pull_now`/`run_to_shift_end`/`expedite_parts_and_run`), partId (nullable), draftedWo (text — the work order the agent wrote), predictedDowntimeCostAvoidedUsd, status (`proposed`/`approved`/`executed`/`overridden`), approvedBy (userEmail, OBO-stamped), **auditTrail** (append-only JSONB), createdAt, decidedAt |

`work_orders_app` is the **only** table the app writes. An approved action inserts/updates a row here. The Plant Floor derives a line's live state by LEFT JOIN-ing `line_status` → its latest `work_orders_app` row (so "action taken" + the badge come from the writable table). The append-only `auditTrail` makes each action a standalone timeline the drawer's Activity tab renders.

## Delta → Lakebase sync

> **Talking-track vs build:** production uses **Lakebase Synced Tables** (managed, continuous). For the demo build: a manual one-shot sync at boot. Same outcome on screen.

1. If synced mirror tables empty → pull via the Databricks SQL Statements API: `line_status` (the at-risk + a sample of healthy lines), `open_atrisk`, `maintenance_recommendations`, and the **`parts`** catalog (all — small, static).
2. Chunked inserts (2000/batch), idempotent (skip on conflict).
3. `work_orders_app` is **not** synced (the app's own writable state) — starts empty.
4. "Reset demo" → truncate `work_orders_app` + re-sync the read-only mirrors. All agent writes wiped; at-risk lines return to their band, KPIs return to full.

Source tables from `config/app.json` `data.tables`.

## Lakebase provisioning

1. Create Lakebase Postgres project + database.
2. Wire into `app.yaml` → Lakebase plugin resolves host + credentials at runtime.
3. Auth: SDK chain (CLI profile dev, OBO prod).
4. Schema: Drizzle ORM, migrations from `server/db/schema.ts`, auto-applied on boot.

# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST and follow it end-to-end. This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, and scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md`, then rewrite domain pieces. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** **Milestone 2 (Lakebase)** = the data model in `03_DATA_MODEL.md` (synced read-only line-status + a writable work-orders table); **Milestone 3 (Databricks Apps)** = **Visualize → Assist → Act**; **Milestone 4 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap predictable per plant, guardrails, inference logging) — the hero question is *"LINE-04 is trending toward a stop — pull it now or run it to the end of the shift?"*.

## Pitch

AI assistant that **investigates a line's failure risk, ranks the maintenance action, and executes it** in one conversation. Sam watches every step live: the assistant asks Genie why LINE-04's telemetry is climbing, reads the live Lakebase status + the open work order + whether the part is local, then **looks up the ranked recommendation** (`app.maintenance_recommendations`, mirrored from `gold_maintenance_recommendations` — heuristic or optional ML) to rank the three plays — pull now / run to shift end / expedite parts and run — each with the downtime cost it avoids and its cost. It explains *why* pulling now wins (the part isn't local, so an unplanned stop would be far costlier), offers a what-if, drafts the work order, and **stops for approval**. Sam approves → the work order + an audit entry write to Lakebase → the queue + KPI tiles tick live. Every action is traced in MLflow; every model call is governed by Unity AI Gateway, scoped to the one plant.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | Read surface (synced read-only `line_status`) AND write surface (writable `work_orders_app`). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` routes the "why is this line trending to a stop?" investigation to the Genie space. |
| **ML model (UC-registered)** | The `failure_recommender` model's batch output feeds the agent's ranking via `app.maintenance_recommendations`. The app never calls the model directly. |
| **AI Functions (`ai_classify`)** | Failure-signal score (0–1) from each technician note, mirrored on the line row. |
| **Unity AI Gateway** | The assistant's model endpoint runs through the Gateway — spend cap predictable per plant across the fleet of 8, guardrails, inference logging, scoped to the one plant. |
| **MLflow tracing** | Per-turn traces with tool spans; thumbs up/down → human assessments. |
| **Databricks Apps** | SSO, OBO auth (work orders stamped with the plant lead's identity), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded iframe with SSO — the plant-floor dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Plant Floor** | The at-risk line surface — a risk scatter/map + an at-risk queue, KPI cards (Downtime exposure / Open work orders / Critical lines), detail drawer with the ranked actions + Approve/Override + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: telemetry trend on the affected lines, worst lines, per-plant risk mix | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page (floating dock + full-page chat), one brain.

### The three layers (Visualize / Assist / Act)
- **Visualize** (Plant Floor) — the live line risk scatter + queue makes the important thing obvious: a red cluster of lines trending to a stop. Reads synced Lakebase status data.
- **Assist** (the agent) — explains why a line is flagged, ranks the action against the downtime cost, offers a what-if. Reads the model's recommendation + the live status + parts context.
- **Act** (the write) — after human approval, writes the chosen action + drafted work order (pull_now/run_to_shift_end/expedite_parts_and_run) to the writable Lakebase `work_orders_app` table; the Plant Floor cascades.

### Thinking panel
Streams reasoning + the Genie investigation ("querying line telemetry", "found open work order, part not local") + tool calls. Persisted as `thinking[]` JSONB.

### Human-in-the-loop — strict 3-phase action chain
1. **Discover** — read the at-risk line (failure risk, telemetry, open WO, part_local), **look up the ranked recommendation** (read-only).
2. **Draft + confirm** — present the ranked options (each with downtime cost avoided, action cost, net value); recommend the top one and explain why; offer a what-if; draft the work order → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved action + drafted work order to `work_orders_app`, append an audit entry — one atomic write.

### Agent tools (Volta) — one example set
| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates the failure risk over the governed lakehouse | Investigation |
| `find_atrisk_line` | Queries Lakebase: the at-risk status for a `{line_id}` (or the worst open) — failure risk, telemetry, open WO count, downtime exposure, part_local | Discovery |
| `search_parts` | Lakebase Search over the parts catalog (`parts`: name + description) to find the replacement part + whether it's local — **powers the expedite play** | Discovery (parts context) |
| `rank_maintenance_actions` | Queries Lakebase `app.maintenance_recommendations` — returns `recommended_action`, `predicted_downtime_cost_avoided_usd`, `predicted_net_value_usd`, and the full `action_ranking`. **The "ML in the loop" moment** | Discovery |
| `execute_maintenance_action` | Atomic write to Lakebase `app.work_orders_app`: records the approved action + drafted work order + audit. Inputs are a FILTER + the drafted work order text | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_maintenance_action` MUST publish a `dataMutated` event. The Plant Floor refetches: the At-risk KPI ticks down, the line row flips to "action taken" with a badge, the scatter's red dot turns neutral, the downtime-exposure KPI drops. The user must **see** it without reloading.

## Home page

**Story section:** Persona badge ("Sam Ortiz · VP Manufacturing Operations · Volta Industrial"), headline ("Lines are trending toward a stop"), situation (a high-utilization run ~3 weeks ago wore ~90 lines toward failure with rising telemetry, open work orders, and parts that would need expediting; ~$3.3M downtime-at-risk, ~150 open corrective work orders — unplanned downtime costs ~$22K/hr), goal (find the lines heading for a stop → get the action that avoids the most downtime cost → approve it), preview bullets.

**Journey diagram:** See the at-risk lines → Plant Floor | Ask why LINE-04 is trending to a stop → starts chat | Rank pull vs run vs expedite → the model | Approve the work order → action flow.

**Starter chips:** "Which lines are trending toward a stop?" / "Why is LINE-04 heading for a breakdown?" / "Should we pull LINE-04 now or run it to the end of the shift?"

**Featured action card:** "Recommend an action for LINE-04 — rank pull now vs run to shift end vs expedite parts and run."

**Activity feed:** Live tail ("Pulled LINE-04 (PLANT-03) for planned maintenance, avoided ~$76K unplanned downtime", "Expedited part for LINE-0231", "Ranked actions for 3 at-risk lines"). Auto-refreshes.

## Scripted demo flow (~3 min)

**Step 1 — "Why is LINE-04 trending toward a stop, and what are my options?"** `ask_data` → Genie investigates: vibration and temperature climbing over three weeks, an open corrective work order, and the replacement part not stocked locally. `find_atrisk_line` reads the live status + parts context. Suggests ranking the action.

**Step 2 — "Rank the action. Use the model."** (unlocks on "risk"/"stop"/"options"/"LINE-04"/"part"). `rank_maintenance_actions` → quotes the ranked options. For the **expedite** option, `search_parts` finds the part + confirms it's non-local. → "**Pull LINE-04 now for planned maintenance** — avoids ~$76K of unplanned downtime for a ~$40K planned-window cost. Run to shift end: risks the full $22K/hr stop. Expedite the part and run: barely break-even — the part isn't stocked locally, so it can't arrive fast." Drafts the work order. Stops.

**Step 3 — "Yes — pull the line now."** (unlocks on "pull"/"action"/"approve"/"downtime"). `execute_maintenance_action` writes to Lakebase, appends audit, emits `dataMutated`. On screen: the At-risk KPI drops, LINE-04's row flips to "action taken", the scatter dot turns neutral, downtime exposure ticks down — no reload. **That live cascade is the story beat.**

**Performance:** narrow Genie questions (20–40s); the status + recommendation lookups are Lakebase reads (sub-second).

All narrative config lives in `config/app.json`. Read it directly.

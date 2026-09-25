# Volta Plant Floor — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the production-line status view reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie/MAS investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Build 3 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

A Volta precision industrial plant (PLANT-03, Ohio) has a critical production line trending toward imminent failure. **LINE-04** (high-speed CNC mill) is showing advanced failure signatures: bearing temperature + vibration trending, failure-risk model predicting 87% chance of shutdown within 48 hours. The required repair part (coupling seal, non-local supply, 14-day lead time) is not on hand. The hero question: **"Should I pull the line now for preventive maintenance (cost: $8K, 4-hour window) or run to shift end (cost: $240K unplanned downtime if it fails)?"** The ML maintenance recommender ranks three options: pull_now, run_to_shift_end, expedite_parts_and_run. The agent reads the ranking, explains each option's downtime cost, and the human approves the pull.

The three layers map 1:1 to the enablement build arc: **Visualize (Build-2 Apps)** → **Assist (Build-2 Apps + the ML step)** → **Act (Build-2 Apps)**, all governed by **Unity AI Gateway (Build 3)**.

---

## The data (already generated + validated in `ai_demo_gen.volta_industrial`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.work_orders_app`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `line_status` | `gold_line_status` | yes (synced) | `id`(=`line_id:plant_id`), `line_id`, `plant_id`, `line_name`, `plant_name`, `region`, `failure_risk_score`, `downtime_exposure_usd`, `current_status`(`healthy`/`at_risk`/`critical`), `last_check_at` |
| `open_atrisk` | `gold_open_atrisk` | yes (synced) | `line_id`, `plant_id`, `line_name`, `failure_risk_score`, `downtime_exposure_usd`, `part_local`, `candidate_part_id`, `part_lead_time_days` |
| `maintenance_recommendations` | `gold_maintenance_recommendations` | yes (synced) | `line_id`, `recommended_action`, `predicted_downtime_cost_usd`, `action_ranking` (JSONB: all three options) |
| `parts` | `raw_parts` | yes (synced) | `id`, `part_id`, `part_name`, `part_category`, `description`, `part_local`, `lead_time_days`, `unit_cost_usd` |
| **`work_orders_app`** | — (the app's own) | **NO — writable** | `id`(uuid), `line_id`, `action_type`, `part_id`, `drafted_wo`, `predicted_downtime_cost_avoided_usd`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_maintenance_recommendations` is NOT built yet.** It is produced by the ML step of Build 2 (`specifications/03-ml-maintenance.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_maintenance_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_maintenance_actions` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/maintenance.ts` (NOT YET CREATED — the trainee builds this).

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/plantfloor.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/maintenance.ts` |
| The data-backend `ask_data` tool | already wired in `plantfloor.ts` (delegates to `server/agent/tools/mas.ts` OR `tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by the Plant Floor view |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `plantfloor.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Build 1 (Lakebase) — already wired for you

The synced mirrors + the writable `work_orders_app` table are the Build-1 answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Build-1 workshop task in the workspace is to set up the **real Lakebase Synced Tables** for the three Gold tables and pick your **`ask_data` backend** (a Genie space OR a MAS endpoint):

- Set **ONE** of `GENIE_SPACE_ID` / `MAS_ENDPOINT_NAME` in `.env` (or the DAB). The app registers whichever is set as the `ask_data` tool — no code change needed. The default Volta flow uses **Genie** ("ask why LINE-04 is at risk").

**Acceptance:** open the app → chat → ask *"Why is LINE-04 trending toward a stop, and what part is needed?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Build 2): `find_atrisk_line` + `rank_maintenance_actions`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/plantfloor.ts` that TELL the model to call these tools. Both tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented"`** until you implement them.

**What YOU build:** replace the two stub `execute` bodies in `server/agent/plantfloor.ts`. The Lakebase query helpers are READY in `server/db/queries/maintenance.ts` (YOU CREATE THIS FILE) — you mostly wire them up.

### 2a. `find_atrisk_line`

Read the worst at-risk production line + its status.

- **File:** `server/agent/plantfloor.ts`, the tool named `find_atrisk_line` (search for `TODO — BUILD 2`).
- **Signature (already declared):** `find_atrisk_line({ line_id: string | null, plant_id: string | null })`. Both null → return the worst at-risk line.
- **Lakebase helpers to create** (in `server/db/queries/maintenance.ts`, imported at the top of `plantfloor.ts`):
  - `worstAtriskLine(ctx.db)` → `AtriskLine | null` — reads `app.open_atrisk` ordered by `downtime_exposure_usd DESC LIMIT 1`.
  - `getLineStatus(ctx.db, lineId)` → `LineStatus | null` — reads `app.line_status` for the given line_id.
  - `getPosition(ctx.db, lineId)` → `Position | null` — optional; returns current line status if you want extra detail.
- **Expected tool output shape** (an object the model reads):
  ```
  {
    line_id, plant_id, line_name, plant_name,
    failure_risk_score, downtime_exposure_usd, current_status,
    part_local, candidate_part_id, part_lead_time_days
  }
  ```
  Combine the `AtriskLine` fields with the `LineStatus` fields. If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_atrisk_line', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_maintenance_actions`

Read the ML model's ranked actions — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/plantfloor.ts`, the tool named `rank_maintenance_actions`.
- **Signature (already declared):** `rank_maintenance_actions({ line_id: string })`.
- **Lakebase helper to create:** `getRecommendation(ctx.db, lineId)` → `Recommendation | null` — reads `app.maintenance_recommendations` (mirrored from `gold_maintenance_recommendations`).
- **Expected tool output shape:**
  ```
  {
    line_id, recommended_action,
    predicted_downtime_cost_usd,
    action_ranking: [                 // ALL three options — quote these in the draft
      { action, predicted_downtime_cost_avoided_usd, estimated_net_value_usd },
      ...
    ]
  }
  ```
  Return `getRecommendation(...)` directly (its shape already matches). If it returns `null`, return `{ scored: false, note: 'No maintenance recommendation yet — build + score the maintenance_recommender model (Build 2 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

**Also add the "explain / what-if / draft" behavior:** the instructions in `plantfloor.ts` already steer the model to quote the ranked options, recommend the top action + explain *why*, and draft the work order — once these two tools return data, that behavior lights up. No extra code needed beyond the two tool bodies.

**Acceptance (2a + 2b):** after building + scoring the model and restarting, chat:
1. *"Why is LINE-04 trending toward a stop, and what are my options?"* → `ask_data` investigates + `find_atrisk_line` returns the at-risk line + part (PLANT-03).
2. *"Rank the maintenance action. Use the model."* → `rank_maintenance_actions` returns the ranking; the agent quotes **pull_now / run_to_shift_end / expedite_parts_and_run** each with predicted downtime costs, recommends pull_now, drafts the work order, and **STOPS for approval**.
   Both tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2 (2a + 2b):**
> In `server/agent/plantfloor.ts`, implement the `find_atrisk_line` and `rank_maintenance_actions` tools (they currently throw "Not implemented"). (1) Create a new file `server/db/queries/maintenance.ts` and export these helpers: `worstAtriskLine(db)` → worst line by downtime_exposure_usd from app.open_atrisk; `getLineStatus(db, lineId)` → line status from app.line_status; `getRecommendation(db, lineId)` → ranked actions from app.maintenance_recommendations. (2) In plantfloor.ts, implement `find_atrisk_line` to call worstAtriskLine + getLineStatus + return {line_id, plant_id, line_name, failure_risk_score, downtime_exposure_usd, current_status, part_local, candidate_part_id, part_lead_time_days}. Return {found:false} if nothing found. (3) Implement `rank_maintenance_actions` to call getRecommendation + return {recommended_action, predicted_downtime_cost_usd, action_ranking[]}. Return {scored:false} if no recommendation yet. Wrap both in mlflow.withSpan(...). Match the output shapes documented in APP_WORKSHOP.md §Layer 2. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

### 2c. `search_parts` — Part search via Lakebase Search

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it when exploring alternative parts, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_parts` tool body + a Lakebase query helper to perform **hybrid text/vector search** over parts.

#### 2c-i. The query helper (add to `server/db/queries/maintenance.ts`)

Add `searchParts(db, query)` that executes a hybrid search over the `parts` table using **Lakebase Search**:

- **Signature:**
  ```ts
  searchParts(db: AppDb, query: string): Promise<Array<{
    part_id: string;
    part_name: string;
    part_category: string;
    part_local: boolean;
    lead_time_days: number | null;
  }>>
  ```
- **What it does:** Lakebase Search is a Milestone-2 capability (set up during Build 1 Lakebase provisioning — see `03_DATA_MODEL.md` notes on the `parts` table having `Lakebase Search` enabled over name + description fields). Issue a **hybrid full-text + vector search** query over `app.parts` matching on (name, description) and return the top 5–10 ranked candidates sorted by relevance. Each result carries part_id, part_name, part_category, part_local, and lead_time_days.
- **Example behavior:** search query `"bearing seal"` → returns **Coupling Seal Assembly** (part-id: `SEAL-040-VOLT`) and **Bearing Race Kit** as top matches (the `description` field has "seal" + "bearing" text for these parts).
- **SQL pattern** — Lakebase Postgres supports full-text search via `tsquery` or `websearch_to_tsquery`, and (if a vector embedding extension is provisioned) vector similarity. Write the query to match your Lakebase provisioning. At minimum, use a **full-text search** over part_name + description (fast, no ML deps). If vectors are indexed, add a vector similarity clause with `.similarity()` for hybrid ranking.

#### 2c-ii. The tool body (in `server/agent/plantfloor.ts`)

Add a new tool `search_parts` or replace the stub (search `TODO — BUILD 2c`):

- **Signature (already declared):** `search_parts({ query: string })`.
- Call `searchParts(ctx.db, query)` (from the helper above). Wrap in `mlflow.withSpan(..., { name: 'search_parts', spanType: mlflow.SpanType.TOOL })`.
- **Return:**
  ```ts
  {
    matches_found: true,
    candidates: [
      { part_id, part_name, part_category, part_local, lead_time_days },
      ...
    ]
  }
  ```
  If no matches, return `{ matches_found: false, note: 'No matching parts found.' }`.
- **Integration with action ranking:** the agent instructions already tell the model: when exploring alternative parts (the expedite_parts_and_run action), call `search_parts` with a descriptive query to find candidates. The tool returns the top candidates; the agent includes them in the what-if analysis.

#### 2c-iii. UI affordance (lightweight add to Plant Floor detail drawer — OPTIONAL)

In the detail drawer's maintenance section, under the ranked actions, add a small **part search box** for exploring alternatives:
- **Label:** "Search parts"
- **Input:** free-text search box
- **Button:** "Search" (or auto-search on input if low-latency)
- **Results:** a dropdown or small panel showing top 5 matches (part name, category, local/remote, lead time)
- **Action:** clicking a result updates the part detail to show the selected part

This UI lets a user manually search too, and serves as a demo of Lakebase Search. (The agent calls the tool automatically during ranking; this UI is for manual exploration.)

**Acceptance (2c):** after configuring Lakebase Search on the `parts` table (Milestone 2 work) and implementing the helper + tool:
1. Run the full script: *"What's the best maintenance action for LINE-04?"* → investigate → rank.
2. In `rank_maintenance_actions` output, for the **expedite_parts_and_run** option, the agent calls `search_parts` with a query like *"bearing seal 40mm"*.
3. `search_parts` returns the **Coupling Seal Assembly** as a top match (local/remote flag, lead time).
4. Agent quotes: **"Expedite the Coupling Seal Assembly (14-day lead time, non-local): cost $12K, recaptures $240K downtime."**
5. The Thinking panel shows the `search_parts` tool call + results.
6. (Optional) The Plant Floor detail drawer shows a part search box you can query manually.

**Paste-to-agent prompt for Layer 2c:**
> Add part search via Lakebase Search (Milestone 2) to power the `search_parts` tool. (1) In `server/db/queries/maintenance.ts` add `searchParts(db, query)` — perform hybrid full-text + vector search over `app.parts` (name + description indexed by Lakebase Search) returning top 5–10 matches with part_id, part_name, part_category, part_local, lead_time_days. (2) In `server/agent/plantfloor.ts` implement the `search_parts` tool to call this helper with the input query (e.g., "bearing seal 40mm"). Return `{matches_found, candidates[]}` or `{matches_found: false}`. The agent instructions already steer the model to call this when exploring alternatives; test with the query "bearing seal" → expect Coupling Seal Assembly as a candidate. (3) Optional: add a lightweight part search box in the Plant Floor detail drawer so users can manually search too. Verify the tool call appears in the Thinking panel during the full demo flow.

---

## Layer 3 — Act (Build 2): `execute_maintenance_action`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval; the client Plant Floor page + drawer already subscribe to `dataMutated` and will refetch when a write lands. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/maintenance.ts`)

Add `recordMaintenanceAction(db, args)` following the **filter-driven, transactional** pattern (inputs are a FILTER + drafted text, never a list of ids; wrap in `db.transaction`):

- **Signature:**
  ```ts
  recordMaintenanceAction(db: AppDb, args: {
    lineId: string; actionType: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
    partId: string | null;
    draftedWorkOrder: string; predictedDowntimeCostAvoidsUsd: number | null;
    userEmail: string;
  }): Promise<{ actionId: string }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.work_orders_app` a row: `line_id`, `action_type`, `part_id`, `drafted_wo`, `predicted_downtime_cost_avoided_usd`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'approved', notes: 'Maintenance action recorded', tool: 'execute_maintenance_action' }]::jsonb`. Return the generated `id`.
- Use the drizzle `workOrdersApp` table import (already exported from `server/db/schema.ts`) or raw `sql` inserts — either is fine; keep it inside `db.transaction(async (tx) => {...})`.

### 3b. The tool body (in `server/agent/plantfloor.ts`)

Replace the `execute_maintenance_action` stub's `execute` (search `TODO — BUILD 3`):

- **Signature (already declared):** `execute_maintenance_action({ line_id, action_type, part_id, drafted_work_order, predicted_downtime_cost_avoided_usd })`.
- Call `recordMaintenanceAction(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_maintenance_action', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, action_id, line_id, action_type, predicted_downtime_cost_avoided_usd }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Plant Floor refresh cascade

The client is already wired: the Plant Floor view subscribes to `dataMutated` from `client/src/lib/events.ts` and refetches on every emit. The chat turn already emits `dataMutated` when the agent's turn ends (see `client/src/chat/useChatTurn.ts` → `onTurnEnd` → `dataMutated.emit()`). **So once `execute_maintenance_action` writes to `app.work_orders_app`, the moment the turn completes:** the at-risk KPI ticks down (the line now has a maintenance action), the work order appears in the history + status updates, and the Plant Floor status view refreshes. **You do not need to add any client code** — just make the write land. If the cascade doesn't fire, confirm `dataMutated.emit()` runs on turn end and that your write committed.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"Why is LINE-04 trending toward a stop, and what are my options?"* → investigate → rank → draft → **STOP**.
2. *"Yes — pull the line now."* → `execute_maintenance_action` writes to `app.work_orders_app`. **Watch the Plant Floor page cascade live without a reload:** at-risk lines −1, LINE-04 row → "Maintenance Scheduled · pull_now", drawer history gains the recorded action.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/maintenance.ts` add `recordMaintenanceAction(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.work_orders_app` row (status='approved', approved_by from userEmail, an audit entry with action:'approved'). (2) In `server/agent/plantfloor.ts` implement the `execute_maintenance_action` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Plant Floor queue updates live after approval.

---

## Build 3 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-line-attributable inference logging** to a UC table.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/plantfloor.ts`, `baseURL: \`${ctx.databricksHost}/serving-endpoints\``). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$500K/yr for plant-wide), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-line attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `work_orders_app.line_id` / `approved_by` columns to attribute spend per production line and operator. (Optional talk-track: surface a "Maintenance Cost" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Build 3):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the line the action targeted.

**Paste-to-agent prompt for Build 3:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/plantfloor.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a spend cap, guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per production line using `work_orders_app.line_id` / `approved_by`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (plant floor status + at-risk queue + KPIs from Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie/MAS, config-driven) | ✅ | pick backend in Build 1 |
| `find_atrisk_line`, `rank_maintenance_actions` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_parts` (Lakebase Search for alternatives) | stub (throws) | **Layer 2c** |
| `execute_maintenance_action` + `recordMaintenanceAction` write | stub (throws) | **Layer 3** |
| `dataMutated` → Plant Floor live cascade | ✅ (fires on your write) | — |
| Unity AI Gateway governance | scope declared | **Build 3** |

**Run it locally:** `./start.sh` (installs deps, builds the frontend, boots on `DATABRICKS_APP_PORT` or `8765`). Reset the demo between runs with the Reset-demo admin action (`POST /api/admin/reset`) — it truncates `work_orders_app` + re-syncs the read-only mirrors, so at-risk lines return to `open_atrisk` and exposure returns to full.

# Workshop - Volta Industrial (Downtime & Maintenance Rescue)

**The use case, in plain words:** Volta makes heavy industrial equipment. A cluster of its production lines is **trending toward a breakdown** — the telemetry (vibration, temperature) is climbing and the replacement parts aren't all stocked nearby. You build an app that spots each line heading for a stop, recommends the best move — **pull it now for planned maintenance, run it to the end of the shift, or rush the part and keep running** — and lets a plant lead approve it in one click. Unplanned downtime costs ~$22K an hour, so the call matters. The data, the recommendation, and the AI that assists are all governed on Databricks, scoped to the one plant, with AI spend that stays predictable across the fleet of eight.

## 🎓 Start here — you build this, it isn't pre-built

Starting point for the Tech Summit FY27 Live Days **AI Customer Challenge**. It ships the **data
generator + specs + a bootstrap app** — **you build the solution** (that's the exercise). Build like
a citizen developer: **describe your intent to Genie Code and iterate**. Work carries forward
milestone → milestone.

### ▶️ How to start

**1. Get the template into your workspace.** Download it from **go/solution-builder** and import the folder into your Databricks workspace (Workspace → *Import*). Everything you need travels with it — work directly from there.

**2. Open a Genie Code session** in that folder and kick it off with this prompt:

> *"Read `README.md`, then all the files under `specifications/`, to build up the full context of
> this workshop — the story, the data model, and each component I need to create. Then read
> `data_generation/generate_data.py` to understand how the raw data is structured. Before doing
> anything, ask me which **catalog and schema** to use. Then run `data_generation/generate_data.py`
> as a **job run** into that catalog/schema to load the raw data. Put all the files you create in
> this project folder — transformation code under `./transformation`, and the dashboard, Genie
> space, and everything else at the root (`./`)."*

From there, build the four milestones below one at a time (SDP pipeline, dashboard, Genie, Lakebase, app, gateway).

**3. Build the four milestones below**, iterating with Genie Code. For the app, point your agent at `app/APP_WORKSHOP.md`.

### What YOU need to create — the four milestones

#### Milestone 1 — Data
*Build the governed data layer the whole solution runs on.*

**You'll learn:** Spark Declarative Pipelines · the medallion model · in-SQL AI (`ai_classify`) · Metric Views · AI/BI dashboards + Genie.

**Steps:**
- **1.1** Run `data_generation/generate_data.py` as a job to load the raw data.
- **1.2** Ask Genie for a data-exploration notebook to understand the data before modeling.
- **1.3** Build the SDP pipeline (`01-lakeflow.md`) → silver + gold + the `gold_maintenance_recommendations` heuristic.
- **1.4** Create the metric view `mv_line_risk` (`02-uc-governance.md`).
- **1.5** Build the AI/BI dashboard + Genie space (`04-ai-bi.md`), saved at the root.
- **1.6** *(Optional)* Train the ML failure-risk model (`03-ml-maintenance.md`) to overwrite the recommendations.

**Done when:** a running pipeline produces the governed gold tables + metric view + recommendations, with a dashboard and Genie space that answer the story.

#### Milestone 2 — Lakebase
*Serve the data at low latency + add the operational store the app writes to.*

**You'll learn:** Lakebase (managed Postgres) · syncing UC tables (read-only) vs. a writable table · dev branches · Lakebase Search (hybrid).

**Steps:**
- **2.1** Create a Lakebase instance (autoscaling) + a dev branch to iterate safely.
- **2.2** Sync the gold tables in as low-latency **read-only** copies.
- **2.3** Add your own **writable** table `work_orders_app` for approved decisions (you can't write to a synced table).
- **2.4** Enable Lakebase Search on the `parts` catalog — powers the app's **expedite-parts** move.

**Done when:** the gold tables are queryable from Postgres, a writable `work_orders_app` table exists, and parts search is ready.

#### Milestone 3 — Databricks App
*Build the internal tool the person actually uses.*

**You'll learn:** create + deploy a Databricks App from the "Spin Up a Databricks App" template (Lakebase + analytics + model-serving plugins) · app scope permissions + OBO (runs as the user) vs. the app service principal (runs as the SP) · iterative Vibe + DAS build · the discover → recommend → act agent loop with human-in-the-loop · build on the dev branch, keep main clean.

**Steps:**
- **3.1** Work locally with **Vibe** (`vibe update` first, for the latest [Databricks Agent Skills](https://github.com/databricks/databricks-agent-skills) via DAS).
- **3.2** Start from the **bootstrap app in `app/`** (boots, reads Lakebase, shows the plant-floor view + a working `ask_data` loop). See **`app/APP_WORKSHOP.md`** for the gaps.
- **3.3** Build the three layers: **Visualize** (done) → **Assist** (agent + tools + drafting) → **Act** (write-back with a human approval stop).

**Done when:** a plant lead sees the at-risk lines, asks why LINE-04 is trending to a stop, gets a ranked action (pull/run/expedite), and approves it — writing the work order to `work_orders_app` and the queue updates live.

#### Milestone 4 — Unity AI Gateway
*Govern the AI the app calls.*

**You'll learn:** Unity AI Gateway · spend caps · content-filter guardrails · inference logging to UC · per-entity attribution.

**Steps:**
- **4.1** Create the AI Gateway with a spend cap, guardrails, and inference logging to a UC table.
- **4.2** Route the app's model calls through it.

**Done when:** every AI call goes through the governed Gateway — capped, guardrailed, logged, and attributable per plant across the fleet.

Everything below is the **story + reference spec** the build should realize. The `specifications/`
folder has the full detail per component; `resources.json` lists the capabilities.

---

## The Story

| | |
|---|---|
| **Company** | Volta Industrial — heavy industrial-equipment maker (~$1.8B revenue, 8 plants, connected-machine telemetry) |
| **Hero** | Sam Ortiz, VP Manufacturing Operations (non-technical) |
| **Problem** | A high-utilization run ~3 weeks ago wore a cluster of production lines toward failure — rising telemetry, open work orders, parts that would need expediting |
| **Investigation** | Sam asks *"LINE-04 is trending toward a stop — pull it now or run it to the end of the shift?"* — the platform ranks pull now vs. run vs. expedite-and-run |
| **Root cause** | Machines run past their maintenance window under high utilization; the nightly report surfaces the risk after the shift, when the stop has already cost $22K/hr |
| **Impact** | ~$3.3M downtime-at-risk exposure across ~90 at-risk lines, ~150 open corrective work orders — concentrated on the affected machines, PLANT-03/LINE-04 at the top |

---

## Overview

Sam Ortiz (VP Manufacturing Ops) opens the plant-floor view and sees a red cluster on one chart: production lines whose vibration and temperature telemetry has trended toward failure over 3 weeks, with open work orders and parts that aren't stocked locally. He asks about the worst line — *"LINE-04 is trending toward a stop, pull it now or run it?"* — and the app ranks **pull now / run to shift end / expedite parts and run** by the downtime cost each avoids, recommends pulling the line now (the part isn't local, so an unplanned stop would be far costlier), drafts the work order, and writes it back after he approves. Governed telemetry, a governed recommendation, and a governed AI assistant — scoped to the one plant, with AI spend predictable per plant across the fleet.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Plants | 8 (`PLANT-01`…`PLANT-08`) |
| Production lines (sampled) | ~1,200 |
| Hero line | LINE-04 at PLANT-03 (Ohio), failure risk ~0.87, replacement part NOT stocked locally |
| High-utilization run onset | ~3 weeks ago (dynamic — `WEAR_ONSET = NOW − 3 weeks`) |
| At-risk lines (critical/elevated) | ~95 (rising vibration/temperature, open corrective work orders) |
| Watch-list lines | ~65 (moderate risk) |
| Unplanned-downtime cost | ~$22K / hour |
| Downtime-at-risk exposure | ~$3.3M |
| Maintenance action ranked by model | pull now / run to shift end / expedite parts and run + predicted downtime cost avoided |
| Assistant AI spend | Capped, predictable per plant across the fleet of 8, scoped-to-one-plant governance |

---

## The demo arc (what the finished solution shows)

1. **See it** — open the Plant Floor app: a failure-risk scatter, a red cluster of lines trending toward a stop, with downtime-exposure + open-work-order KPIs.
2. **Ask why** — in the chat dock, ask why LINE-04 is trending to a stop; the assistant investigates via Genie over the governed lakehouse.
3. **Get the action** — the assistant ranks pull now / run / expedite by downtime cost avoided and recommends pulling now (the part isn't local), with a what-if.
4. **Act** — approve → the work order writes back to Lakebase → the queue and KPIs update live.
5. **Governed AI** — every assistant call runs through Unity AI Gateway (spend cap, guardrails, per-plant logging), scoped to the one plant.

Full per-component detail is in `specifications/`; the build steps are the four milestones above.

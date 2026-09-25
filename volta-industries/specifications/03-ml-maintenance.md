# Failure-Risk Maintenance Recommendation — OPTIONAL ML model (default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_maintenance_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (`01-lakeflow.md` → Silver→Gold): for each at-risk line it ranks pull_now /
> run_to_shift_end / expedite_parts_and_run by **net value = downtime_cost_avoided − action_cost**,
> and **pull_now wins for the hero line**. The app, dashboard, and Genie read that table — they never
> call a model. **The full solution works end-to-end with no ML at all.**
>
> This file is a **stretch**: train a model that *learns* the downtime-cost-avoided from history and
> **overwrite the same `gold_maintenance_recommendations` table**. Nothing downstream changes. If you
> skip it, drop `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_maintenance_outcomes` (training) + `gold_open_atrisk` (the lines to score). Overwrites `gold_maintenance_recommendations`.

## The story (same as the heuristic — just learned)

When a line trends toward a stop, there are three plays — **pull it now** for planned maintenance, **run it to the end of the shift** (accept the risk), or **expedite the part and keep running** — and the right choice is **situational** (failure risk, whether the part is stocked locally, criticality). The model learns how much downtime cost each play avoided from Volta's own history. **`part_local` is the lever that makes expedite viable: expedite_parts_and_run only nets positive when the part is stocked locally (short lead time) — a moderate-risk line's play. For a high-risk line whose part is non-local, expedite is the weakest option.** For the hero (`LINE-04`, high risk, non-local part) it should still rank **pull_now** first.

## What to train

A **regressor predicting `downtime_cost_avoided_usd`** for a (line situation, candidate action) pair — train on `gold_maintenance_outcomes`. XGBoost regressor, Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.failure_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how*). This spec is *what*.

## Features

From `gold_maintenance_outcomes` (training) + reconstructable at scoring: `action_type` (categorical), `risk_at_action` (= `failure_risk_score`), `part_local` (bool — the key lever), `criticality`, `action_cost_usd`, `downtime_hours`. Label = `downtime_cost_avoided_usd`. Also carry `action_cost_usd` so the app shows **net value = predicted downtime_cost_avoided − action_cost**.

## Inference shape

Same notebook trains AND scores. For every line in `gold_open_atrisk`, construct the three candidate actions, score each, write ranked to `gold_maintenance_recommendations` (overwrite):

| Column | |
|---|---|
| `line_id` | at-risk line (PK) |
| `recommended_action` | top-ranked `action_type` by predicted net value |
| `predicted_downtime_cost_avoided_usd` | model output for the recommended action |
| `predicted_net_value_usd` | avoided − action_cost for the recommended action |
| `action_ranking` | JSON array of all three with predicted avoided + net + cost |
| `scored_at` | now() |

**Batch only — no serving endpoint.**

## Execution

One Databricks notebook (`./transformation/maintenance_train_score.py`) doing train → register → set `@prod` → build candidates → batch-score → overwrite → `dbutils.notebook.exit(json.dumps({model_version, rmse, lines_scored, pull_recommended, run_recommended, expedite_recommended}))`. Run as a **serverless job**. Never run locally. **Notebook-source format required.**

## Who consumes the predictions

1. **Plant-floor app** — mirrored into Lakebase as `app.maintenance_recommendations`; the agent's `rank_maintenance_actions` tool reads it.
2. **Genie** — answers *"what should we do about LINE-04?"*, *"how much downtime cost could we avoid across all at-risk lines?"*, *"how many lines should we pull now vs expedite?"*.
3. **AI/BI dashboard** — recommended-action mix + total predicted downtime cost avoided.

## Functional validation

- **Hero recommendation is pull_now** — `gold_maintenance_recommendations WHERE line_id='LINE-04'` → `recommended_action = 'pull_now'`, and `action_ranking` has pull_now above the others. If not, re-check `gold_maintenance_outcomes` learnability + the `part_local` lever.
- **Action mix is plausible** — a mix driven by `part_local` (pull_now on high-risk/non-local, expedite on moderate/local). Not 100% one type.
- **Predicted avoidance rolls up** — `SUM(predicted_downtime_cost_avoided_usd)` is a believable fraction of the downtime exposure.
- **Model quality** — training RMSE reasonable vs the `downtime_cost_avoided_usd` scale (autologged).

## resources.json

- `ml_model_name`: `{catalog}.{schema}.failure_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/volta/experiments/failure_recommender`

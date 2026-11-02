# Databricks notebook source
# MAGIC %md
# MAGIC # Volta Industrial — Maintenance recommender · train → register → batch-score
# MAGIC
# MAGIC Implements `specifications/03-ml-maintenance.md`. An XGBoost regressor learns
# MAGIC `downtime_cost_avoided_usd` for a (line situation, candidate action) pair from
# MAGIC `gold_maintenance_outcomes`, is registered to UC as `<catalog>.<schema>.failure_recommender`
# MAGIC and promoted `@prod`, then scores the three candidate plays for every line in
# MAGIC `gold_open_atrisk` and **overwrites** `gold_maintenance_recommendations` (the app's
# MAGIC Lakebase mirror, the dashboard, and Genie all read that table).
# MAGIC
# MAGIC **`part_local` is the lever.** The model predicts the downtime cost each play avoids; the
# MAGIC action *cost* used for net value is reconstructed from the line's part context — expediting a
# MAGIC non-local part pays the lead time — so net value = predicted avoided − action cost ranks
# MAGIC pull_now first for high-risk / non-local lines (the hero, LINE-0004) and expedite for
# MAGIC moderate-risk lines whose part is stocked locally.
# MAGIC
# MAGIC Runs as the serverless job `volta_ml_maintenance` (after a pipeline refresh). Never run locally.

# COMMAND ----------

dbutils.widgets.text("catalog", "dfurg_febar_catalog")
dbutils.widgets.text("schema", "volta_industrial")
dbutils.widgets.text("experiment_path", "")

CATALOG = dbutils.widgets.get("catalog")
SCHEMA = dbutils.widgets.get("schema")
EXPERIMENT_PATH = dbutils.widgets.get("experiment_path")
FQ = f"{CATALOG}.{SCHEMA}"
MODEL_NAME = f"{FQ}.failure_recommender"

# COMMAND ----------

import json

import mlflow
import numpy as np
import optuna
import pandas as pd
import xgboost as xgb
from mlflow.models import infer_signature
from mlflow.tracking import MlflowClient
from pyspark.sql import functions as F
from sklearn.metrics import mean_squared_error
from sklearn.model_selection import train_test_split

mlflow.set_registry_uri("databricks-uc")
if EXPERIMENT_PATH:
    mlflow.set_experiment(EXPERIMENT_PATH)

ACTIONS = ["pull_now", "run_to_shift_end", "expedite_parts_and_run"]
STOP_COST_USD = 4 * 22000.0  # an unplanned stop: ~4h @ ~$22K/hr
HOURLY_DOWNTIME_USD = 22000.0

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Training data + features

# COMMAND ----------

hist = spark.table(f"{FQ}.gold_maintenance_outcomes").select(
    "action_type", "risk_at_action", "part_local", "criticality",
    "action_cost_usd", "downtime_hours", "downtime_cost_avoided_usd",
).toPandas()
hist["part_local"] = hist["part_local"].astype(bool)
CRITICALITIES = sorted(hist["criticality"].dropna().astype(str).unique().tolist())
print(f"{len(hist):,} historical decisions · criticality levels: {CRITICALITIES}")


def featurize(df: pd.DataFrame) -> pd.DataFrame:
    """Fixed-width numeric feature frame: one-hot action_type + criticality, the rest as-is."""
    out = pd.DataFrame(index=df.index)
    out["risk_at_action"] = df["risk_at_action"].astype(float)
    out["part_local"] = df["part_local"].astype(int)
    out["action_cost_usd"] = df["action_cost_usd"].astype(float)
    out["downtime_hours"] = df["downtime_hours"].astype(float)
    for a in ACTIONS:
        out[f"action_{a}"] = (df["action_type"] == a).astype(int)
    for c in CRITICALITIES:
        out[f"crit_{c}"] = (df["criticality"].astype(str) == c).astype(int)
    return out


X = featurize(hist)
y = hist["downtime_cost_avoided_usd"].astype(float)
X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Train — XGBoost + Optuna (10 trials), MLflow autolog

# COMMAND ----------

mlflow.xgboost.autolog(log_models=False)


def objective(trial: optuna.Trial) -> float:
    params = {
        "max_depth": trial.suggest_int("max_depth", 3, 8),
        "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.3, log=True),
        "n_estimators": trial.suggest_int("n_estimators", 100, 500),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "min_child_weight": trial.suggest_int("min_child_weight", 1, 20),
    }
    with mlflow.start_run(nested=True, run_name=f"trial-{trial.number}"):
        model = xgb.XGBRegressor(objective="reg:squarederror", random_state=42, **params)
        model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
        rmse = float(np.sqrt(mean_squared_error(y_val, model.predict(X_val))))
        mlflow.log_metric("val_rmse", rmse)
    return rmse


with mlflow.start_run(run_name="failure_recommender") as parent:
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=10)

    best = xgb.XGBRegressor(objective="reg:squarederror", random_state=42, **study.best_params)
    best.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    rmse = float(np.sqrt(mean_squared_error(y_val, best.predict(X_val))))
    mlflow.log_params({f"best_{k}": v for k, v in study.best_params.items()})
    mlflow.log_metrics({"rmse": rmse, "label_mean": float(y.mean()), "label_max": float(y.max())})

    # ## 3. Register to UC
    sample = X_val.head(5)
    mlflow.xgboost.log_model(
        best,
        name="model",
        signature=infer_signature(sample, best.predict(sample)),
        input_example=sample,
        registered_model_name=MODEL_NAME,
    )
    run_id = parent.info.run_id

print(f"best params {study.best_params} · val RMSE ${rmse:,.0f} (label mean ${y.mean():,.0f}, max ${y.max():,.0f})")

# COMMAND ----------

client = MlflowClient()
model_version = max(
    int(v.version) for v in client.search_model_versions(f"name='{MODEL_NAME}'") if v.run_id == run_id
)
client.set_registered_model_alias(MODEL_NAME, "prod", model_version)
print(f"{MODEL_NAME} v{model_version} → @prod")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Candidates — three plays per at-risk line
# MAGIC
# MAGIC Model inputs (`action_cost_usd`, `downtime_hours`) are kept in the training distribution:
# MAGIC history means per (action_type, part_local), with run_to_shift_end scaled by risk (its cost
# MAGIC and downtime grow with risk in history). The **scoring cost** that net value subtracts is
# MAGIC reconstructed from the line's part context — that is where `part_local` bites.

# COMMAND ----------

means = hist.groupby(["action_type", "part_local"])[["action_cost_usd", "downtime_hours"]].mean()
run_hist = hist[hist["action_type"] == "run_to_shift_end"]
run_hours_per_risk = float((run_hist["downtime_hours"] / run_hist["risk_at_action"]).mean())

atrisk = spark.table(f"{FQ}.gold_open_atrisk").select(
    "line_id", "failure_risk_score", "part_local", "criticality",
    "part_unit_cost_usd", "part_lead_time_days",
).toPandas()
atrisk["part_local"] = atrisk["part_local"].fillna(True).astype(bool)
atrisk["part_unit_cost_usd"] = atrisk["part_unit_cost_usd"].fillna(500.0).astype(float)
atrisk["part_lead_time_days"] = atrisk["part_lead_time_days"].fillna(7).astype(float)

cand = atrisk.merge(pd.DataFrame({"action_type": ACTIONS}), how="cross")
cand["risk_at_action"] = cand["failure_risk_score"].astype(float)


def model_inputs(row: pd.Series) -> pd.Series:
    r, local, action = row["risk_at_action"], row["part_local"], row["action_type"]
    if action == "run_to_shift_end":
        cost = r * STOP_COST_USD + (0.0 if local else 3000.0)
        hours = r * run_hours_per_risk
    else:
        cost, hours = means.loc[(action, local)]
    return pd.Series({"action_cost_usd": float(cost), "downtime_hours": float(hours)})


def scoring_cost(row: pd.Series) -> float:
    if row["action_type"] == "expedite_parts_and_run" and not row["part_local"]:
        # non-local part: premium freight on the part + the lead time the line waits on it
        return row["part_unit_cost_usd"] * 3 + row["part_lead_time_days"] * HOURLY_DOWNTIME_USD
    return row["action_cost_usd"]


cand[["action_cost_usd", "downtime_hours"]] = cand.apply(model_inputs, axis=1)
cand["scoring_cost_usd"] = cand.apply(scoring_cost, axis=1)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Batch-score with `@prod`, rank by net value

# COMMAND ----------

prod_model = mlflow.xgboost.load_model(f"models:/{MODEL_NAME}@prod")
cand["avoided"] = np.clip(prod_model.predict(featurize(cand)[X.columns]), 0, None)
cand["net"] = cand["avoided"] - cand["scoring_cost_usd"]

rows = []
for line_id, g in cand.groupby("line_id"):
    g = g.sort_values("net", ascending=False)
    top = g.iloc[0]
    ranking = [
        {"action": r.action_type, "avoided": round(float(r.avoided), 2),
         "cost": round(float(r.scoring_cost_usd), 2), "net": round(float(r.net), 2)}
        for r in g.itertuples()
    ]
    rows.append({
        "line_id": line_id,
        "recommended_action": top["action_type"],
        "predicted_downtime_cost_avoided_usd": round(float(top["avoided"]), 2),
        "predicted_net_value_usd": round(float(top["net"]), 2),
        "action_ranking": json.dumps(ranking),
    })
recs = pd.DataFrame(rows)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Overwrite `gold_maintenance_recommendations`

# COMMAND ----------

out = (
    spark.createDataFrame(recs)
    # alias the app's Lakebase mirror expects (app/server/db/sync.ts selects predicted_downtime_cost_usd)
    .withColumn("predicted_downtime_cost_usd", F.col("predicted_downtime_cost_avoided_usd"))
    .withColumn("scored_at", F.current_timestamp())
    .select(
        "line_id", "recommended_action",
        "predicted_downtime_cost_avoided_usd", "predicted_downtime_cost_usd",
        "predicted_net_value_usd", "action_ranking", "scored_at",
    )
)
target = f"{FQ}.gold_maintenance_recommendations"
out.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(target)
spark.sql(
    f"COMMENT ON TABLE {target} IS 'Ranked maintenance action per at-risk line, scored by "
    f"{MODEL_NAME}@prod v{model_version}: recommended_action + predicted values + action_ranking JSON.'"
)

mix = recs["recommended_action"].value_counts().to_dict()
display(out.orderBy(F.desc("predicted_net_value_usd")))

# COMMAND ----------

dbutils.notebook.exit(json.dumps({
    "model_version": model_version,
    "rmse": round(rmse, 2),
    "lines_scored": len(recs),
    "pull_recommended": int(mix.get("pull_now", 0)),
    "run_recommended": int(mix.get("run_to_shift_end", 0)),
    "expedite_recommended": int(mix.get("expedite_parts_and_run", 0)),
}))

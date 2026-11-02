# transformation/

Put your **data transformation** here — the SDP (Spark Declarative Pipeline) SQL
that turns the raw parquet (in the `raw_data` volume, written by
`../data_generation/generate_data.py`) into the silver + gold tables described in
`../specifications/01-lakeflow.md` (`gold_line_status`, `gold_open_atrisk`,
`gold_maintenance_outcomes`, `gold_maintenance_recommendations`, the `ai_classify`
failure signal, …).

This build takes the ML path (`../specifications/03-ml-maintenance.md`): the pipeline
no longer builds `gold_maintenance_recommendations`. `maintenance_train_score.py` trains
`failure_recommender`, scores `gold_open_atrisk`, and writes that table. Run it with the
bundle job `volta_ml_maintenance`, which refreshes the pipeline first.

This folder ships empty — building the pipeline is Milestone 1.

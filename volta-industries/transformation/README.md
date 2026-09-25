# transformation/

Put your **data transformation** here — the SDP (Spark Declarative Pipeline) SQL
that turns the raw parquet (in the `raw_data` volume, written by
`../data_generation/generate_data.py`) into the silver + gold tables described in
`../specifications/01-lakeflow.md` (`gold_line_status`, `gold_open_atrisk`,
`gold_maintenance_outcomes`, `gold_maintenance_recommendations`, the `ai_classify`
failure signal, …).

If you take the OPTIONAL ML path (`../specifications/03-ml-maintenance.md`), the
`maintenance_train_score.py` notebook also lives here.

This folder ships empty — building the pipeline is Milestone 1.

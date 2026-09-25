#!/usr/bin/env python3
"""Build the 'Volta Plant Floor' Genie space serialized_space per specifications/04-ai-bi.md."""
import sys, json, pathlib
from uuid import uuid4

SKILL = "/Users/drew.furgiuele/.claude/plugins/cache/fe-vibe/fe-internal-tools/1.4.7/skills/genie-rooms/resources"
sys.path.insert(0, SKILL)
from genie_space_builder import GenieSpaceBuilder  # noqa

CAT, SCH = "dfurg_febar_catalog", "volta_industrial"
def t(n): return f"{CAT}.{SCH}.{n}"
WAREHOUSE = "438700776c7de38c"

INSTRUCTIONS = (
    "You analyze Volta Industrial plant-floor data for Sam Ortiz (VP Manufacturing Operations, non-technical). "
    "CONTEXT: A high-utilization run ~3 weeks ago wore ~90 critical lines toward failure - rising vibration/temperature, "
    "open corrective work orders, parts needing expediting. Unplanned downtime costs ~$22K/hour. "
    "BASELINES: Healthy line failure_risk_score ~0.03-0.2. risk_band: 'critical' (>=0.75 with open corrective), "
    "'elevated' (>=0.6), 'watch' (>=0.4), 'healthy'. The part_local flag is the key lever: expedite only nets positive "
    "when the part is LOCAL. For high-risk, NON-local-part lines (like LINE-0004 at PLANT-03), pull_now wins. "
    "HEADLINE NUMBERS always come from the mv_line_risk metric view: downtime exposure = MEASURE(downtime_exposure), "
    "open work orders = MEASURE(open_work_orders), critical lines = MEASURE(critical_count), at-risk = MEASURE(atrisk_count). "
    "The hero line id is LINE-0004."
)

space = GenieSpaceBuilder(title="Volta Plant Floor",
                          description="Governed plant-floor analytics: downtime exposure, at-risk lines, and the recommended maintenance action.",
                          warehouse_id=WAREHOUSE)
space.set_instructions(INSTRUCTIONS)

# Curated relations (sorted by identifier per best practice)
for tbl in ["gold_line_status", "gold_maintenance_recommendations", "gold_open_atrisk", "raw_lines", "raw_parts"]:
    space.add_table(t(tbl))
space.add_metric_view(t("mv_line_risk"))

# Example question + SQL pairs (train Genie on the story arc)
space.add_example_sql("What's our downtime exposure right now, and how many open work orders?",
    f"SELECT MEASURE(downtime_exposure) AS downtime_exposure_usd, MEASURE(open_work_orders) AS open_work_orders FROM {t('mv_line_risk')}")
space.add_example_sql("Which plants is the failure risk concentrated in?",
    f"SELECT plant_id, MEASURE(atrisk_count) AS atrisk FROM {t('mv_line_risk')} GROUP BY plant_id ORDER BY atrisk DESC")
space.add_example_sql("LINE-0004 is trending toward a stop - how bad is it and is the part in stock?",
    f"SELECT line_id, failure_risk_score, risk_band, part_local, candidate_part_id, part_lead_time_days FROM {t('gold_open_atrisk')} WHERE line_id = 'LINE-0004'")
space.add_example_sql("Should we pull LINE-0004 now or run it to the end of the shift?",
    f"SELECT recommended_action, predicted_downtime_cost_avoided_usd, predicted_net_value_usd, action_ranking FROM {t('gold_maintenance_recommendations')} WHERE line_id = 'LINE-0004'")
space.add_example_sql("Across all at-risk lines, how much downtime cost could we avoid, and by which action?",
    f"SELECT recommended_action, ROUND(SUM(predicted_downtime_cost_avoided_usd)) AS total_avoided_usd, COUNT(*) AS lines FROM {t('gold_maintenance_recommendations')} GROUP BY recommended_action ORDER BY total_avoided_usd DESC")
space.add_example_sql("Which lines are best served by expediting the part instead of pulling?",
    f"SELECT r.line_id, a.plant_id, r.predicted_net_value_usd FROM {t('gold_maintenance_recommendations')} r JOIN {t('gold_open_atrisk')} a USING (line_id) WHERE r.recommended_action = 'expedite_parts_and_run' ORDER BY r.predicted_net_value_usd DESC")

space.validate()
sd = space.to_dict()

# Inject the 7-step sample-question arc (config.sample_questions).
questions = [
    "What's our downtime exposure right now, and how many open work orders?",
    "Which plants is the failure risk concentrated in?",
    "What do these at-risk lines have in common?",
    "LINE-0004 is trending toward a stop - how bad is it and is the part in stock?",
    "Should we pull LINE-0004 now or run it to the end of the shift?",
    "Across all at-risk lines, how much downtime cost could we avoid, and by which action?",
    "Which lines are best served by expediting the part instead of pulling?",
]
sd.setdefault("config", {})["sample_questions"] = [
    {"id": uuid4().hex, "question": [q]} for q in questions
]

# The export proto requires every id-keyed list sorted by id.
def sort_by_id(container, *path):
    node = container
    for p in path[:-1]:
        node = node.get(p, {})
    lst = node.get(path[-1])
    if isinstance(lst, list):
        node[path[-1]] = sorted(lst, key=lambda e: e.get("id", ""))
sort_by_id(sd, "config", "sample_questions")
sort_by_id(sd, "instructions", "text_instructions")
sort_by_id(sd, "instructions", "example_question_sqls")
sd["data_sources"]["tables"] = sorted(sd["data_sources"]["tables"], key=lambda e: e.get("identifier", ""))

serialized = json.dumps(sd)
payload = {
    "title": "Volta Plant Floor",
    "description": "Governed plant-floor analytics: downtime exposure, at-risk lines, and the recommended maintenance action.",
    "parent_path": "/Users/drew.furgiuele@databricks.com",
    "warehouse_id": WAREHOUSE,
    "serialized_space": serialized,
}
root = pathlib.Path(__file__).parent
(root / "genie_space.json").write_text(json.dumps(sd, indent=2))
(root / "/tmp/create_genie_space.json".lstrip("/") if False else pathlib.Path("/tmp/create_genie_space.json")).write_text(json.dumps(payload))
print("wrote genie_space.json;", len(sd["data_sources"]["tables"]), "relations;", len(questions), "sample questions")

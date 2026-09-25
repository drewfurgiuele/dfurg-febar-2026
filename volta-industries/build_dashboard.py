#!/usr/bin/env python3
"""Build the Volta Plant Floor AI/BI dashboard (dashboard.lvdash.json) per specifications/04-ai-bi.md."""
import json, uuid, pathlib

CAT, SCH = "dfurg_febar_catalog", "volta_industrial"
def t(name): return f"{CAT}.{SCH}.{name}"

# risk_band color mappings (literal hex, semantic)
BAND_COLORS = [
    {"value": "critical", "color": "#E5484D"},
    {"value": "elevated", "color": "#FFB020"},
    {"value": "watch",    "color": "#8BCAE7"},
    {"value": "healthy",  "color": "#3C6997"},
]
PALETTE = ["#094074", "#3C6997", "#5ADBFF", "#FFB020", "#E5484D"]

def ds(name, display, lines):
    return {"name": name, "displayName": display, "queryLines": lines}

datasets = [
    ds("ds_exposure", "Exposure (metric view)", [
        "SELECT plant_id, machine_type, risk_band, criticality, ",
        "MEASURE(downtime_exposure) AS downtime_exposure_usd, ",
        "MEASURE(open_work_orders) AS open_work_orders, ",
        "MEASURE(critical_count) AS critical_count, ",
        "MEASURE(atrisk_count) AS atrisk_count, ",
        "MEASURE(line_count) AS line_count ",
        f"FROM {t('mv_line_risk')} GROUP BY ALL"]),
    ds("ds_scatter", "Lines (sampled for scatter)", [
        "SELECT line_id, plant_id, machine_type, criticality, plant_lat, plant_lng, ",
        "risk_band, failure_risk_score, vibration_rms, temperature_c, open_wo_count, downtime_exposure_usd ",
        f"FROM {t('gold_line_status')} WHERE risk_band <> 'healthy' OR rand() < 0.1"]),
    ds("ds_worst", "Highest exposure lines", [
        "SELECT line_id, plant_id, machine_type, risk_band, vibration_rms, failure_risk_score, open_wo_count, downtime_exposure_usd ",
        f"FROM {t('gold_line_status')} WHERE risk_band IN ('critical','elevated') ORDER BY downtime_exposure_usd DESC"]),
    ds("ds_watch", "Rising-risk watch list", [
        "SELECT line_id, plant_id, machine_type, risk_band, failure_risk_score, open_wo_count ",
        f"FROM {t('gold_line_status')} WHERE risk_band = 'watch' ORDER BY failure_risk_score DESC"]),
    ds("ds_maintenance", "Maintenance recommendations", [
        "SELECT line_id, recommended_action, predicted_downtime_cost_avoided_usd, predicted_net_value_usd ",
        f"FROM {t('gold_maintenance_recommendations')}"]),
]

def text(name, md, x, y, w, h):
    return {"widget": {"name": name, "multilineTextboxSpec": {"lines": [md]}},
            "position": {"x": x, "y": y, "width": w, "height": h}}

def counter(name, dsname, field, expr, title, fmt, x, y, w=3, h=3):
    enc = {"value": {"fieldName": field, "displayName": title}}
    if fmt: enc["value"]["format"] = fmt
    return {"widget": {"name": name,
            "queries": [{"name": "main_query", "query": {"datasetName": dsname,
                "fields": [{"name": field, "expression": expr}], "disaggregated": False}}],
            "spec": {"version": 2, "widgetType": "counter", "encodings": enc,
                     "frame": {"showTitle": True, "title": title}}},
            "position": {"x": x, "y": y, "width": w, "height": h}}

NUM_USD = {"type": "number-currency", "currencyCode": "USD", "decimalPlaces": {"type": "max", "places": 0},
           "abbreviation": "compact"}
NUM_CMP = {"type": "number-plain", "decimalPlaces": {"type": "max", "places": 0}, "abbreviation": "compact"}

def scatter(name, dsname, x_f, x_expr, y_f, y_expr, color_f, size_f, title, x, y, w, h):
    return {"widget": {"name": name,
            "queries": [{"name": "main_query", "query": {"datasetName": dsname, "fields": [
                {"name": x_f, "expression": x_expr},
                {"name": y_f, "expression": y_expr},
                {"name": color_f, "expression": f"`{color_f}`"},
                {"name": size_f, "expression": f"`{size_f}`"},
                {"name": "line_id", "expression": "`line_id`"},
                {"name": "plant_id", "expression": "`plant_id`"},
                {"name": "machine_type", "expression": "`machine_type`"}],
                "disaggregated": True}}],
            "spec": {"version": 3, "widgetType": "scatter", "encodings": {
                "x": {"fieldName": x_f, "scale": {"type": "quantitative"}, "displayName": "Vibration (RMS)"},
                "y": {"fieldName": y_f, "scale": {"type": "quantitative"}, "displayName": "Failure risk"},
                "color": {"fieldName": color_f, "scale": {"type": "categorical", "mappings": BAND_COLORS}, "displayName": "Risk band"},
                "size": {"fieldName": size_f, "scale": {"type": "quantitative"}, "displayName": "Open WOs"},
                "extra": [{"fieldName": "line_id", "displayName": "Line"},
                          {"fieldName": "plant_id", "displayName": "Plant"},
                          {"fieldName": "machine_type", "displayName": "Machine"}]},
                "frame": {"showTitle": True, "title": title}}},
            "position": {"x": x, "y": y, "width": w, "height": h}}

def bar(name, dsname, x_f, x_expr, y_f, y_expr, title, x, y, w, h, color_f=None, color_expr=None,
        mappings=None, colors=None, grouped=False, horizontal=False, sort_y_rev=False):
    fields = [{"name": x_f, "expression": x_expr}, {"name": y_f, "expression": y_expr}]
    xscale = {"type": "categorical"}
    if sort_y_rev: xscale["sort"] = {"by": "y-reversed"}
    enc = {"x": {"fieldName": x_f, "scale": xscale, "displayName": x_f.replace("_", " ").title()},
           "y": {"fieldName": y_f, "scale": {"type": "quantitative"}, "displayName": title}}
    if horizontal:
        enc = {"y": {"fieldName": x_f, "scale": xscale, "displayName": x_f.replace("_", " ").title()},
               "x": {"fieldName": y_f, "scale": {"type": "quantitative"}, "displayName": title}}
    if color_f:
        fields.append({"name": color_f, "expression": color_expr or f"`{color_f}`"})
        cs = {"type": "categorical"}
        if mappings: cs["mappings"] = mappings
        enc["color"] = {"fieldName": color_f, "scale": cs, "displayName": color_f.replace("_", " ").title()}
    spec = {"version": 3, "widgetType": "bar", "encodings": enc, "frame": {"showTitle": True, "title": title}}
    if grouped: spec["mark"] = {"layout": "group"}
    if colors: spec.setdefault("mark", {})["colors"] = colors
    return {"widget": {"name": name, "queries": [{"name": "main_query",
            "query": {"datasetName": dsname, "fields": fields, "disaggregated": False}}], "spec": spec},
            "position": {"x": x, "y": y, "width": w, "height": h}}

def table(name, dsname, cols, title, x, y, w, h):
    fields = [{"name": c[0], "expression": f"`{c[0]}`"} for c in cols]
    columns = [{"fieldName": c[0], "displayName": c[1]} for c in cols]
    return {"widget": {"name": name, "queries": [{"name": "main_query",
            "query": {"datasetName": dsname, "fields": fields, "disaggregated": True}}],
            "spec": {"version": 2, "widgetType": "table", "encodings": {"columns": columns},
                     "frame": {"showTitle": True, "title": title}}},
            "position": {"x": x, "y": y, "width": w, "height": h}}

def filt(name, dsname, field, title, x, y, w=2, h=2):
    qn = f"{dsname}_{field}"
    return {"widget": {"name": name, "queries": [{"name": qn, "query": {"datasetName": dsname,
            "fields": [{"name": field, "expression": f"`{field}`"}], "disaggregated": False}}],
            "spec": {"version": 2, "widgetType": "filter-multi-select",
                     "encodings": {"fields": [{"fieldName": field, "displayName": title, "queryName": qn}]},
                     "frame": {"showTitle": True, "title": title}}},
            "position": {"x": x, "y": y, "width": w, "height": h}}

# ---- Page 1: Plant Floor ----
p1 = [
    text("p1-title", "## Volta Plant Floor", 0, 0, 6, 1),
    text("p1-sub", "Sam Ortiz, VP Manufacturing Operations. A high-utilization run ~3 weeks ago wore a cluster of lines toward failure (red). This tracks downtime exposure and the recommended action.", 0, 1, 6, 1),
    counter("p1-exposure", "ds_exposure", "sum(downtime_exposure_usd)", "SUM(`downtime_exposure_usd`)", "Downtime exposure", NUM_USD, 0, 2, 3, 3),
    counter("p1-openwos", "ds_exposure", "sum(open_work_orders)", "SUM(`open_work_orders`)", "Open work orders", NUM_CMP, 3, 2, 3, 3),
    counter("p1-critical", "ds_exposure", "sum(critical_count)", "SUM(`critical_count`)", "Critical lines", NUM_CMP, 0, 5, 3, 3),
    counter("p1-atrisk", "ds_exposure", "sum(atrisk_count)", "SUM(`atrisk_count`)", "At-risk lines", NUM_CMP, 3, 5, 3, 3),
    scatter("p1-scatter", "ds_scatter", "vibration_rms", "`vibration_rms`", "failure_risk_score", "`failure_risk_score`",
            "risk_band", "open_wo_count", "Failure risk vs vibration", 0, 8, 6, 7),
    bar("p1-byplant", "ds_exposure", "plant_id", "`plant_id`", "sum(atrisk_count)", "SUM(`atrisk_count`)",
        "At-risk lines by plant & band", 0, 15, 3, 6, color_f="risk_band", mappings=BAND_COLORS, grouped=True),
    bar("p1-bymachine", "ds_exposure", "machine_type", "`machine_type`", "sum(downtime_exposure_usd)", "SUM(`downtime_exposure_usd`)",
        "Downtime exposure by machine type", 3, 15, 3, 6, horizontal=True, sort_y_rev=True, colors=["#094074"]),
]

# ---- Page 2: Maintenance ----
p2 = [
    text("p2-title", "## Maintenance — pull now or run?", 0, 0, 6, 1),
    text("p2-sub", "The lines trending to a stop, whether the part is local, and the model's recommended action with the downtime cost it avoids.", 0, 1, 6, 1),
    table("p2-worst", "ds_worst", [("line_id", "Line"), ("plant_id", "Plant"), ("machine_type", "Machine"),
          ("vibration_rms", "Vibration"), ("failure_risk_score", "Failure risk"), ("downtime_exposure_usd", "Downtime exposure $")],
          "Highest downtime exposure", 0, 2, 3, 6),
    table("p2-watch", "ds_watch", [("line_id", "Line"), ("plant_id", "Plant"), ("failure_risk_score", "Failure risk"), ("open_wo_count", "Open WOs")],
          "Rising-risk watch list", 3, 2, 3, 6),
    bar("p2-actionmix", "ds_maintenance", "recommended_action", "`recommended_action`", "count(line_id)", "COUNT(`line_id`)",
        "Recommended action (mix)", 0, 8, 3, 6, colors=PALETTE, sort_y_rev=True),
    counter("p2-avoided", "ds_maintenance", "sum(predicted_downtime_cost_avoided_usd)", "SUM(`predicted_downtime_cost_avoided_usd`)",
            "Total predicted downtime cost avoided", NUM_USD, 3, 8, 3, 6),
    table("p2-recos", "ds_maintenance", [("line_id", "Line"), ("recommended_action", "Recommended action"),
          ("predicted_downtime_cost_avoided_usd", "Predicted avoided $"), ("predicted_net_value_usd", "Predicted net value $")],
          "Maintenance recommendations", 0, 14, 6, 7),
]

# ---- Global filters page ----
gf = [
    filt("gf-plant", "ds_exposure", "plant_id", "Plant", 0, 0),
    filt("gf-machine", "ds_exposure", "machine_type", "Machine type", 0, 2),
    filt("gf-band", "ds_exposure", "risk_band", "Risk band", 0, 4),
]

dashboard = {
    "datasets": datasets,
    "pages": [
        {"name": "page_plant_floor", "displayName": "Plant Floor", "pageType": "PAGE_TYPE_CANVAS", "layout": p1},
        {"name": "page_maintenance", "displayName": "Maintenance", "pageType": "PAGE_TYPE_CANVAS", "layout": p2},
        {"name": "page_filters", "displayName": "Filters", "pageType": "PAGE_TYPE_GLOBAL_FILTERS", "layout": gf},
    ],
    "uiSettings": {"theme": {"widgetHeaderAlignment": "ALIGNMENT_UNSPECIFIED"}, "applyModeEnabled": False},
}

out = pathlib.Path(__file__).parent / "dashboard.lvdash.json"
out.write_text(json.dumps(dashboard, indent=2))
print("wrote", out)

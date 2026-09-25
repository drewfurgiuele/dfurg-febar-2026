# Plant Floor Page

The plant-lead write surface — Sam works the at-risk-line backlog, the agent's maintenance actions land in real time. This is the **Visualize** layer, and the surface the **Act** layer writes to.

> **Design the page from the persona, not the template.** Plant leads think in *lines and machines* — what's healthy, what's about to stop. The primary visualization is a **failure-risk × vibration scatter** (red high-risk cluster) OR a **plant map** colored by risk band, NOT a bare table. If the screenshot reads as "a table with rows", redesign until it reads as "this is a plant-floor app".

## Layout

**Header:** "Work the at-risk lines." / "Every red line is trending toward an unplanned stop — and every stop costs $22K an hour. Catch it before the shift ends."

**"Ask the assistant" banner:** "Ask why a line is trending to a stop and get the action that avoids the most downtime" → opens the dock with the LINE-04 starter.

**KPI cards (3 across):**
- **Downtime exposure** ($, red tint) — from the exposure metric view over the current at-risk lines.
- **Open work orders** (#, amber tint) — open corrective WOs on the cohort.
- **Critical lines** (#, neutral) — count of `critical`/`elevated`. Ticks down live when the agent acts.

**Risk scatter / map** (the hero visual): x = vibration, y = failure risk, one point per at-risk line, colored by `risk_band` — **red** critical, **amber** watch/elevated, steel healthy. Size by downtime exposure. LINE-04 is the zoom target. Clicking a point filters the queue. (A plant map by `plant_lat`/`plant_lng` recolored to `risk_band` is a fine alternative.)

**At-risk queue:** Filterable, sortable table.
- Status tabs: All / Critical / Elevated / Watch / Action taken
- Search: line_id, plant, machine_type
- Plant filter chip, Machine-type filter chip, Risk-band filter chip
- Sortable: **Downtime exposure** ($), **Failure risk** (score), **Vibration**
- Columns: Line (id + plant) | Machine type | Vibration | Failure risk | **Part local?** | **Downtime exposure** ($) | **Recommended action** (badge: Pull now / Run / Expedite — from the model) | Status
- Click row → detail drawer.

**Detail drawer (right slide-over, ~60%).**
- **Line tab** — detail grid (line, plant, machine type, criticality, vibration, temperature, failure risk, open WOs, downtime exposure) + parts context (needed part, local?, lead time) + **the ranked action options** (each with downtime cost avoided, action cost, net value) with **Approve recommended / Override** buttons. **For the expedite option:** a small **part search box** ("Find the replacement part") powers a lightweight search over the parts catalog using Lakebase Search — ranked candidate parts with name, local stock, lead time.
- **Telemetry tab** — recent vibration/temperature sparkline on this line.
- **Activity tab** — merged timeline (agent audit trail + work orders taken + who approved).

## Volta data

The queue reads Lakebase `app.line_status` (synced, read-only) filtered to at-risk, LEFT JOIN `app.maintenance_recommendations`. The scatter/map reads the same rows. ~90 critical + ~65 watch/elevated at-risk lines; a sample of healthy lines in the background.

The **Act** write lands in `app.work_orders_app` (writable) — an approved action is recorded as a work-order row (action_type, part if expediting, drafted work order, predicted downtime cost avoided, status, approved_by), and the queue derives "action taken" by joining line → its latest `work_orders_app` row. KPIs recompute as lines gain an action. See `03_DATA_MODEL.md`.

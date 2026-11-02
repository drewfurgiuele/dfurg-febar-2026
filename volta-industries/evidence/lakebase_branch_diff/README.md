# Lakebase branch diff — project `volta-industrial`

Captured 2026-11-02 from database `databricks_postgres` on each branch's `primary` endpoint
(read-only catalog queries via `databricks psql`). Lakebase has no CLI/API diff command, so each
branch was snapshotted with identical queries and compared with `diff -u`, similar to the
console's Schema Diff view.

## Branch lineage

| Branch | Parent | Branched at (UTC) | Notes |
|---|---|---|---|
| `production` | — | created 2026-09-25 13:16 | default branch ("main"); empty |
| `dev` | `production` | 2026-09-25 13:18 | used by app `volta-industrial` |
| `ml-app` | `dev` | 2026-11-02 17:21 | used by app `volta-industrial-ml-version` |

## Files

- `<branch>.schema_snapshot.txt` — schemas, relations, columns, indexes, constraints, row counts, Drizzle migrations
- `production_vs_dev.diff` — everything the app build-out added on `dev`
- `dev_vs_ml-app.diff` — changes on `ml-app` since it was branched
- `production_vs_ml-app.diff` — total change from the default branch

## Summary

**production → dev:** `production` holds only `public` + `__db_system`, with no user tables. `dev` adds
schemas `app`, `appkit`, `drizzle`; 4 synced tables from Unity Catalog (`app.line_status` 1,200 rows,
`app.parts` 800, `app.maintenance_recommendations` 155, `app.open_atrisk` 155); 4 app tables
(`conversations`, `messages`, `feedback`, `work_orders_app`); the AppKit cache table; and 1 Drizzle migration.

**dev → ml-app:** no structural changes (same tables, columns, indexes, constraints). Differences:
- `appkit` schema + `appkit_cache_entries` ownership moved from the `volta-industrial` app's service principal
  (`0247cace…`) to the `volta-industrial-ml-version` app's service principal (`90723d14…`)
- New rows written by the ML app since branching: `app.conversations` 13→14, `app.messages` 52→60,
  `app.work_orders_app` 2→3
- Synced tables are identical in both (point-in-time copy; sync pipelines write only to `dev`)

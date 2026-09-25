import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import { lineStatus, openAtrisk, maintenanceRecommendations, parts } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — Volta Plant Floor.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the four READ-ONLY Gold mirrors:
 *   - line_status             (production line health + failure risk)
 *   - open_atrisk             (lines at imminent risk)
 *   - maintenance_recommendations (the ML model's ranked actions)
 *   - parts                   (part inventory + lead times)
 *
 * `work_orders_app` is the app's own WRITABLE table — never synced, starts empty.
 *
 * The maintenance_recommendations table is BUILT BY THE TRAINEE (the ML step of
 * the workshop). So its query is fault-tolerant: if the table doesn't exist
 * yet, we log + leave the mirror empty rather than failing boot.
 *
 * Idempotent in the "only-if-destination-empty" sense — if the line_status
 * mirror has rows, we skip. Pass `{ forceIfAnyEmpty: true }` to re-sync
 * on demand (used by the "Reset demo" button).
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    /** gold_line_status — production line health with failure risk scores. */
    lineStatus: string;
    /** gold_open_atrisk — lines at imminent risk of failure. */
    openAtrisk: string;
    /** gold_maintenance_recommendations — the ML model's ranked actions.
     *  Built by the trainee; sync tolerates it not existing yet. */
    maintenanceRecommendations?: string;
    /** raw_parts — part inventory + lead times. */
    parts: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(sql`SELECT COUNT(*)::int AS n FROM app.line_status`);
  const n = (exists.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (n > 0 && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (parallel)…');
  const t0 = Date.now();

  const fq = (name: 'lineStatus' | 'openAtrisk' | 'maintenanceRecommendations' | 'parts') =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  const hasRecTable = Boolean(cfg.tables.maintenanceRecommendations);

  // Fire the line_status + open_atrisk + parts queries in parallel (the slow part).
  // The maintenance_recommendations query is BEST-EFFORT (the trainee may not have
  // built that Gold table yet), so run it defensively and swallow a
  // TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [statusRows, atriskRows, recRows, partsRows] = await Promise.all([
    execSql<{
      id: string;
      line_id: string;
      plant_id: string;
      line_name: string;
      plant_name: string | null;
      region: string | null;
      failure_risk_score: number;
      downtime_exposure_usd: number;
      current_status: string;
      last_check_at: string | null;
    }>(
      warehouseId,
      `SELECT id, line_id, plant_id, line_name, plant_name, region,
              failure_risk_score, downtime_exposure_usd, current_status, last_check_at
       FROM ${fq('lineStatus')}`,
    ),
    execSql<{
      line_id: string;
      plant_id: string;
      line_name: string;
      failure_risk_score: number;
      downtime_exposure_usd: number;
      part_local: boolean;
      candidate_part_id: string | null;
      part_lead_time_days: number | null;
    }>(
      warehouseId,
      `SELECT line_id, plant_id, line_name, failure_risk_score,
              downtime_exposure_usd, part_local, candidate_part_id,
              part_lead_time_days
       FROM ${fq('openAtrisk')}`,
    ),
    hasRecTable
      ? execSql<{
          line_id: string;
          recommended_action: string;
          predicted_downtime_cost_usd: number | null;
          action_ranking: string; // JSON string
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT line_id, recommended_action, predicted_downtime_cost_usd,
                  action_ranking, scored_at
           FROM ${fq('maintenanceRecommendations')}`,
        ).catch((err) => {
          console.warn(
            `[sync] maintenance_recommendations table not found (trainee has not built it yet): ${err.message}`,
          );
          return [];
        })
      : Promise.resolve([] as Array<{
          line_id: string;
          recommended_action: string;
          predicted_downtime_cost_usd: number | null;
          action_ranking: string;
          scored_at: string | null;
        }>),
    execSql<{
      id: string;
      part_id: string;
      part_name: string;
      part_category: string | null;
      description: string | null;
      part_local: boolean;
      lead_time_days: number | null;
      unit_cost_usd: number | null;
    }>(
      warehouseId,
      `SELECT id, part_id, part_name, part_category, description,
              part_local, lead_time_days, unit_cost_usd
       FROM ${fq('parts')}`,
    ),
  ]);
  console.log(`[sync]   queries done (${((Date.now() - t0) / 1000).toFixed(1)}s) — inserting…`);

  // Insert in dependency order. Parts table has no FK, so can insert any time.
  if (statusRows.length) {
    await chunkInsert(statusRows, 5_000, (chunk) =>
      db.insert(lineStatus).values(
        chunk.map((r) => ({
          id: r.id,
          lineId: r.line_id,
          plantId: r.plant_id,
          lineName: r.line_name,
          plantName: r.plant_name,
          region: r.region,
          failureRiskScore: Number(r.failure_risk_score),
          downtimeExposureUsd: Number(r.downtime_exposure_usd),
          currentStatus: (r.current_status === 'healthy' ||
          r.current_status === 'at_risk' ||
          r.current_status === 'critical'
            ? r.current_status
            : 'healthy') as 'healthy' | 'at_risk' | 'critical',
          lastCheckAt: r.last_check_at ? new Date(r.last_check_at) : null,
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(`[sync]   line_status: ${statusRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (atriskRows.length) {
    await chunkInsert(atriskRows, 5_000, (chunk) =>
      db.insert(openAtrisk).values(
        chunk.map((r) => ({
          lineId: r.line_id,
          plantId: r.plant_id,
          lineName: r.line_name,
          failureRiskScore: Number(r.failure_risk_score),
          downtimeExposureUsd: Number(r.downtime_exposure_usd),
          partLocal: r.part_local,
          candidatePartId: r.candidate_part_id,
          partLeadTimeDays: r.part_lead_time_days,
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(`[sync]   open_atrisk: ${atriskRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (recRows.length) {
    await chunkInsert(recRows, 2_500, (chunk) =>
      db.insert(maintenanceRecommendations).values(
        chunk.map((r) => {
          let actionRanking = [];
          try {
            actionRanking = JSON.parse(r.action_ranking);
          } catch {
            console.warn(`[sync] Failed to parse action_ranking for line ${r.line_id}`);
          }
          return {
            lineId: r.line_id,
            recommendedAction: (r.recommended_action === 'pull_now' ||
            r.recommended_action === 'run_to_shift_end' ||
            r.recommended_action === 'expedite_parts_and_run'
              ? r.recommended_action
              : 'pull_now') as 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run',
            predictedDowntimeCostUsd: r.predicted_downtime_cost_usd
              ? Number(r.predicted_downtime_cost_usd)
              : null,
            actionRanking,
            scoredAt: r.scored_at ? new Date(r.scored_at) : null,
          };
        }),
      ).onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   maintenance_recommendations: ${recRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (partsRows.length) {
    await chunkInsert(partsRows, 5_000, (chunk) =>
      db.insert(parts).values(
        chunk.map((r) => ({
          id: r.id,
          partId: r.part_id,
          partName: r.part_name,
          partCategory: r.part_category,
          description: r.description,
          partLocal: r.part_local,
          leadTimeDays: r.lead_time_days,
          unitCostUsd: r.unit_cost_usd === null ? null : Number(r.unit_cost_usd),
        })),
      ).onConflictDoNothing(),
    );
  }
  console.log(`[sync]   parts: ${partsRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.work_orders_app RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.line_status RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.open_atrisk RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.maintenance_recommendations RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.parts RESTART IDENTITY CASCADE`);
  });
}

async function execSql<T>(
  warehouseId: string,
  statement: string,
): Promise<T[]> {
  const { client } = getExecutionContext();
  type StmtResp = {
    statement_id: string;
    status: { state: string; error?: { message: string } };
    manifest?: {
      schema: { columns: Array<{ name: string }> };
      chunks?: Array<{ chunk_index: number; row_count: number }>;
    };
    result?: {
      chunk_index: number;
      row_count: number;
      data_array?: Array<Array<unknown>>;
      next_chunk_index?: number;
    };
  };

  const initial = (await client.apiClient.request({
    method: 'POST',
    path: '/api/2.0/sql/statements',
    payload: {
      statement,
      warehouse_id: warehouseId,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    },
    headers: new Headers(),
    raw: false,
    query: {},
  })) as StmtResp;

  const POLL_DEADLINE_MS = 10 * 60 * 1000;
  const startedAt = Date.now();

  let cur = initial;
  while (
    cur.status.state !== 'SUCCEEDED' &&
    cur.status.state !== 'FAILED' &&
    cur.status.state !== 'CANCELED'
  ) {
    if (Date.now() - startedAt > POLL_DEADLINE_MS) {
      throw new Error(
        `[sync] SQL still ${cur.status.state} after 10 minutes — aborting (statement_id=${cur.statement_id})`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
    cur = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp;
  }
  if (cur.status.state !== 'SUCCEEDED') {
    throw new Error(
      `[sync] SQL failed: ${cur.status.error?.message ?? cur.status.state}`,
    );
  }

  const cols = cur.manifest?.schema.columns.map((c) => c.name) ?? [];
  const rows: T[] = [];
  let chunk = cur.result;
  while (chunk) {
    for (const row of chunk.data_array ?? []) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      rows.push(obj as T);
    }
    if (chunk.next_chunk_index === undefined || chunk.next_chunk_index === null) break;
    chunk = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}/result/chunks/${chunk.next_chunk_index}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp['result'];
  }
  return rows;
}

async function chunkInsert<T>(
  rows: T[],
  size: number,
  fn: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}

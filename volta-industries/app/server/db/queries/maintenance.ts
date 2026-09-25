/**
 * Query helpers for maintenance/plant-floor operations (Milestone 3 — Assist + Act).
 * Read the read-only Lakebase mirrors (line_status / open_atrisk / maintenance_recommendations
 * / parts) and write the app-owned work_orders_app. See APP_WORKSHOP.md §Layer 2 / §Layer 3.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../index.js';
import {
  lineStatus,
  openAtrisk,
  maintenanceRecommendations,
  workOrdersApp,
  type MaintenanceAuditEntry,
} from '../schema.js';

/**
 * The scripted prompts / users say "LINE-04", but the generated ids are zero-padded
 * ("LINE-0004"). Normalize a LINE-<n> id to the 4-digit form so lookups match.
 */
export function normalizeLineId(lineId: string): string {
  const m = /^LINE-(\d+)$/i.exec(lineId.trim());
  return m ? `LINE-${m[1].padStart(4, '0')}` : lineId.trim();
}

export async function worstAtriskLine(db: AppDb): Promise<{
  lineId: string;
  plantId: string;
  lineName: string;
  failureRiskScore: number;
  downtimeExposureUsd: number;
} | null> {
  const rows = await db
    .select({
      lineId: openAtrisk.lineId,
      plantId: openAtrisk.plantId,
      lineName: openAtrisk.lineName,
      failureRiskScore: openAtrisk.failureRiskScore,
      downtimeExposureUsd: openAtrisk.downtimeExposureUsd,
    })
    .from(openAtrisk)
    .orderBy(desc(openAtrisk.downtimeExposureUsd))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLineStatus(
  db: AppDb,
  lineId: string,
): Promise<{
  lineId: string;
  plantId: string;
  lineName: string;
  plantName: string | null;
  failureRiskScore: number;
  downtimeExposureUsd: number;
  currentStatus: 'healthy' | 'at_risk' | 'critical';
  partLocal: boolean;
  partId: string | null;
  partLeadTimeDays: number;
} | null> {
  const id = normalizeLineId(lineId);
  // line_status has no parts columns; join open_atrisk for part context.
  const rows = await db
    .select({
      lineId: lineStatus.lineId,
      plantId: lineStatus.plantId,
      lineName: lineStatus.lineName,
      plantName: lineStatus.plantName,
      failureRiskScore: lineStatus.failureRiskScore,
      downtimeExposureUsd: lineStatus.downtimeExposureUsd,
      currentStatus: lineStatus.currentStatus,
      partLocal: openAtrisk.partLocal,
      candidatePartId: openAtrisk.candidatePartId,
      partLeadTimeDays: openAtrisk.partLeadTimeDays,
    })
    .from(lineStatus)
    .leftJoin(openAtrisk, eq(openAtrisk.lineId, lineStatus.lineId))
    .where(eq(lineStatus.lineId, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    lineId: r.lineId,
    plantId: r.plantId,
    lineName: r.lineName,
    plantName: r.plantName ?? null,
    failureRiskScore: r.failureRiskScore,
    downtimeExposureUsd: r.downtimeExposureUsd,
    currentStatus: r.currentStatus,
    partLocal: r.partLocal ?? true, // no needed part -> not a constraint
    partId: r.candidatePartId ?? null,
    partLeadTimeDays: r.partLeadTimeDays ?? 0,
  };
}

export async function getRecommendation(
  db: AppDb,
  lineId: string,
): Promise<{
  lineId: string;
  recommendedAction: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
  predictedDowntimeCostUsd: number;
  actionRanking: Array<{
    action: string;
    costUsd: number;
    predictedCostAvoided: number;
    netValue: number;
  }>;
} | null> {
  const id = normalizeLineId(lineId);
  const rows = await db
    .select()
    .from(maintenanceRecommendations)
    .where(eq(maintenanceRecommendations.lineId, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // action_ranking is stored as the heuristic emits it: {action, avoided, cost, net}.
  const raw = (Array.isArray(r.actionRanking) ? r.actionRanking : []) as Array<
    Record<string, string | number>
  >;
  return {
    lineId: r.lineId,
    recommendedAction: r.recommendedAction,
    predictedDowntimeCostUsd: Number(r.predictedDowntimeCostUsd ?? 0),
    actionRanking: raw.map((o) => ({
      action: String(o.action),
      costUsd: Number(o.cost ?? 0),
      predictedCostAvoided: Number(o.avoided ?? 0),
      netValue: Number(o.net ?? 0),
    })),
  };
}

export async function searchParts(
  db: AppDb,
  query: string,
): Promise<
  Array<{
    partId: string;
    partName: string;
    partCategory: string;
    partLocal: boolean;
    leadTimeDays: number;
  }>
> {
  const q = query.trim();
  if (!q) return [];
  const doc = sql`to_tsvector('english', coalesce(part_name,'') || ' ' || coalesce(description,''))`;
  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  // Primary: hybrid-ready full-text search (Lakebase Search over name + description).
  let res = await db.execute(sql`
    SELECT part_id, part_name, part_category, part_local, lead_time_days
    FROM app.parts
    WHERE ${doc} @@ ${tsq}
    ORDER BY ts_rank(${doc}, ${tsq}) DESC
    LIMIT 10
  `);
  // Fallback: substring match when the tsquery has no lexeme hits.
  if (!res.rows.length) {
    const like = `%${q}%`;
    res = await db.execute(sql`
      SELECT part_id, part_name, part_category, part_local, lead_time_days
      FROM app.parts
      WHERE part_name ILIKE ${like} OR description ILIKE ${like}
      LIMIT 10
    `);
  }
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    partId: String(r.part_id),
    partName: String(r.part_name),
    partCategory: r.part_category == null ? '' : String(r.part_category),
    partLocal: Boolean(r.part_local),
    leadTimeDays: r.lead_time_days == null ? 0 : Number(r.lead_time_days),
  }));
}

export async function recordMaintenanceAction(
  db: AppDb,
  args: {
    lineId: string;
    actionType: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
    partId: string | null;
    draftedWo: string;
    predictedDowntimeCostAvoidsUsd: number | null;
    userEmail: string;
  },
): Promise<{ actionId: string }> {
  const now = new Date();
  const audit: MaintenanceAuditEntry[] = [
    {
      at: now.toISOString(),
      by: args.userEmail,
      action: 'approved',
      notes: 'Maintenance action recorded',
      tool: 'execute_maintenance_action',
    },
  ];
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(workOrdersApp)
      .values({
        lineId: normalizeLineId(args.lineId),
        actionType: args.actionType,
        partId: args.partId,
        draftedWo: args.draftedWo,
        predictedDowntimeCostAvoidsUsd: args.predictedDowntimeCostAvoidsUsd,
        status: 'approved',
        approvedBy: args.userEmail,
        auditTrail: audit,
        decidedAt: now,
      })
      .returning({ id: workOrdersApp.id });
    return { actionId: rows[0].id };
  });
}

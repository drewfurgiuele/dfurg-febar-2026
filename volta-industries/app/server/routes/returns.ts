/**
 * Operations-queue REST layer for the Volta plant-floor demo.
 *
 * The client (client/src/lib/returns.ts + shared/types.ts) speaks the template's
 * "returns" contract. This maps Volta maintenance data onto it:
 *   - one at-risk production line  ⇒ one "return" row
 *   - downtime exposure ($)        ⇒ return value
 *   - failure-risk score (0–1)     ⇒ anger score (drives the default sort)
 *   - app.work_orders_app          ⇒ the write surface + audit trail (status/decide)
 *
 * Reads the read-only Lakebase mirrors (open_atrisk / line_status /
 * maintenance_recommendations) and writes only app.work_orders_app.
 */
import type { Application } from 'express';
import express from 'express';
import { desc, eq } from 'drizzle-orm';
import type { AppDb } from '../db/index.js';
import {
  openAtrisk,
  lineStatus,
  maintenanceRecommendations,
  workOrdersApp,
  type MaintenanceAuditEntry,
} from '../db/schema.js';
import { getCurrentUserEmail } from '../lib/user.js';
import type {
  ActivityEvent,
  CityBucket,
  ReturnDetail,
  ReturnRow,
  ReturnsSummary,
  ReturnStatus,
} from '../../client/src/shared/types.js';

type Deps = { db: AppDb };

// Plant → geography (the mirror doesn't carry lat/lng; the 8 plants are fixed).
const PLANTS: Record<string, { city: string; region: string; lat: number; lng: number }> = {
  'PLANT-01': { city: 'Detroit', region: 'Michigan', lat: 42.331, lng: -83.046 },
  'PLANT-02': { city: 'Pittsburgh', region: 'Pennsylvania', lat: 40.441, lng: -79.996 },
  'PLANT-03': { city: 'Columbus', region: 'Ohio', lat: 39.961, lng: -82.999 },
  'PLANT-04': { city: 'Milwaukee', region: 'Wisconsin', lat: 43.039, lng: -87.906 },
  'PLANT-05': { city: 'Charlotte', region: 'North Carolina', lat: 35.227, lng: -80.843 },
  'PLANT-06': { city: 'Dallas', region: 'Texas', lat: 32.777, lng: -96.797 },
  'PLANT-07': { city: 'Phoenix', region: 'Arizona', lat: 33.448, lng: -112.074 },
  'PLANT-08': { city: 'Portland', region: 'Oregon', lat: 45.515, lng: -122.678 },
};
const plantOf = (id: string) => PLANTS[id] ?? { city: id, region: 'US', lat: 39.5, lng: -98.35 };

type WoRow = typeof workOrdersApp.$inferSelect;

/** Latest work_orders_app row per line (few rows in a demo — resolve in JS). */
async function latestWoByLine(db: AppDb): Promise<Map<string, WoRow>> {
  const rows = await db.select().from(workOrdersApp).orderBy(desc(workOrdersApp.createdAt));
  const m = new Map<string, WoRow>();
  for (const r of rows) if (!m.has(r.lineId)) m.set(r.lineId, r); // first = newest
  return m;
}

/** Derive the queue status of a line from its latest work order. */
function statusOf(wo: WoRow | undefined): ReturnStatus {
  if (wo?.status === 'approved') return 'approved';
  if (wo?.status === 'rejected') return 'rejected';
  return 'pending';
}

export function registerReturnsRoutes(app: Application, deps: Deps): void {
  const { db } = deps;

  // GET /api/returns — at-risk lines as queue rows.
  app.get('/api/returns', async (req, res) => {
    const statusFilter = req.query.status as ReturnStatus | undefined;
    const lot = req.query.lot as string | undefined; // used as plant filter
    const country = req.query.country as string | undefined; // region
    const sort = (req.query.sort as 'anger' | 'recent' | 'value') ?? 'anger';

    const [lines, woByLine] = await Promise.all([
      db.select().from(openAtrisk),
      latestWoByLine(db),
    ]);

    let rows: ReturnRow[] = lines.map((l) => {
      const wo = woByLine.get(l.lineId);
      const p = plantOf(l.plantId);
      const st = statusOf(wo);
      const ts = (wo?.decidedAt ?? wo?.createdAt ?? null)?.toISOString() ?? new Date(0).toISOString();
      return {
        id: l.lineId,
        customerId: l.plantId,
        customerName: `${l.lineName} · ${p.city}`,
        customerEmail: '',
        loyaltyTier: null,
        finalTier: null,
        premiumStatusLabeled: null,
        premiumProb: null,
        angerScore: l.failureRiskScore, // 0–1 failure risk → drives 'anger' sort
        sku: l.candidatePartId,
        productName: p.city,
        category: null,
        lot: l.plantId,
        returnReason: l.candidatePartId
          ? `Needs part ${l.candidatePartId}${l.partLocal ? '' : ' (non-local — expedite)'}`
          : null,
        returnValueUsd: String(l.downtimeExposureUsd ?? 0),
        status: st,
        couponPctApplied: null,
        region: p.region,
        returnDate: null,
        createdAt: ts,
        updatedAt: ts,
      };
    });

    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    if (lot) rows = rows.filter((r) => r.lot === lot);
    if (country) rows = rows.filter((r) => r.region === country);

    rows.sort((a, b) => {
      if (sort === 'value') return Number(b.returnValueUsd) - Number(a.returnValueUsd);
      if (sort === 'recent') return b.createdAt.localeCompare(a.createdAt);
      return (b.angerScore ?? 0) - (a.angerScore ?? 0); // 'anger' (failure risk)
    });

    res.json(rows);
  });

  // GET /api/returns/summary — counts + $ by derived status.
  app.get('/api/returns/summary', async (_req, res) => {
    const [lines, woByLine] = await Promise.all([
      db.select().from(openAtrisk),
      latestWoByLine(db),
    ]);
    const agg = new Map<ReturnStatus, { n: number; total: number }>();
    for (const l of lines) {
      const st = statusOf(woByLine.get(l.lineId));
      const cur = agg.get(st) ?? { n: 0, total: 0 };
      cur.n += 1;
      cur.total += Number(l.downtimeExposureUsd ?? 0);
      agg.set(st, cur);
    }
    const out: ReturnsSummary[] = (['pending', 'approved', 'rejected'] as ReturnStatus[]).map(
      (st) => ({ status: st, n: agg.get(st)?.n ?? 0, total_usd: String(Math.round(agg.get(st)?.total ?? 0)) }),
    );
    res.json(out);
  });

  // GET /api/returns/by-city — per-plant buckets for the map.
  app.get('/api/returns/by-city', async (_req, res) => {
    const lines = await db.select().from(openAtrisk);
    const byPlant = new Map<string, { total: number; refund: number }>();
    for (const l of lines) {
      const cur = byPlant.get(l.plantId) ?? { total: 0, refund: 0 };
      cur.total += 1;
      cur.refund += Number(l.downtimeExposureUsd ?? 0);
      byPlant.set(l.plantId, cur);
    }
    const out: CityBucket[] = [...byPlant.entries()].map(([plantId, v]) => {
      const p = plantOf(plantId);
      return {
        city: p.city,
        country: 'USA',
        lat: p.lat,
        lng: p.lng,
        total: v.total,
        premium: v.total, // all at-risk
        refund_usd: Math.round(v.refund),
      };
    });
    res.json(out);
  });

  // GET /api/returns/:id — one line's detail + its work-order audit trail.
  app.get('/api/returns/:id', async (req, res) => {
    const lineId = req.params.id;
    const [atrisk] = await db.select().from(openAtrisk).where(eq(openAtrisk.lineId, lineId)).limit(1);
    const [ls] = await db.select().from(lineStatus).where(eq(lineStatus.lineId, lineId)).limit(1);
    if (!atrisk && !ls) {
      res.status(404).json({ error: 'line not found' });
      return;
    }
    const wos = await db
      .select()
      .from(workOrdersApp)
      .where(eq(workOrdersApp.lineId, lineId))
      .orderBy(desc(workOrdersApp.createdAt));
    const latest = wos[0];
    const p = plantOf((atrisk?.plantId ?? ls?.plantId) as string);
    const audit = wos.flatMap((w) => (w.auditTrail as MaintenanceAuditEntry[]) ?? []);
    const exposure = atrisk?.downtimeExposureUsd ?? ls?.downtimeExposureUsd ?? 0;
    const risk = atrisk?.failureRiskScore ?? ls?.failureRiskScore ?? null;
    const detail: ReturnDetail = {
      return_id: lineId,
      order_id: latest?.id ?? null,
      lot_id: (atrisk?.plantId ?? ls?.plantId) ?? null,
      facility: p.city,
      product_id: atrisk?.candidatePartId ?? null,
      product_name: ls?.lineName ?? lineId,
      category: ls?.currentStatus ?? null,
      return_reason: atrisk?.candidatePartId
        ? `Needs part ${atrisk.candidatePartId}${atrisk.partLocal ? '' : ' (non-local)'}`
        : null,
      return_reason_text: null,
      anger_score: risk,
      refund_amount_usd: String(exposure),
      status: statusOf(latest),
      coupon_pct_applied: null,
      region: p.region,
      return_date: null,
      order_date: null,
      decided_at: latest?.decidedAt?.toISOString() ?? null,
      created_at: latest?.createdAt?.toISOString() ?? new Date(0).toISOString(),
      updated_at: latest?.decidedAt?.toISOString() ?? new Date(0).toISOString(),
      customer_id: (atrisk?.plantId ?? ls?.plantId) ?? null,
      customer_name: ls?.plantName ?? p.city,
      customer_email: null,
      loyalty_tier: null,
      customer_region: p.region,
      customer_country: 'USA',
      registration_date: null,
      order_total_usd: null,
      final_tier: null,
      premium_status_labeled: null,
      premium_prob: null,
      predicted_at: null,
      emails: [],
      ai_audit_trail: audit.map((a) => ({
        at: a.at,
        by: a.by,
        action: (a.action === 'approved' || a.action === 'rejected' ? a.action : 'note') as
          | 'approved'
          | 'rejected'
          | 'escalated'
          | 'email_sent'
          | 'note',
        notes: a.notes,
        tool: a.tool,
      })),
    };
    res.json(detail);
  });

  // POST /api/returns/:id/decide — manual approve/reject/escalate → work_orders_app.
  app.post('/api/returns/:id/decide', express.json(), async (req, res) => {
    const lineId = req.params.id;
    const decision = req.body?.decision as 'approved' | 'rejected' | 'escalated' | undefined;
    const notes = (req.body?.notes as string | undefined) ?? undefined;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'escalated') {
      res.status(400).json({ error: 'decision must be approved | rejected | escalated' });
      return;
    }
    const userEmail = getCurrentUserEmail(req);
    // Prefer the recommended action for this line; fall back to pull_now.
    const [rec] = await db
      .select()
      .from(maintenanceRecommendations)
      .where(eq(maintenanceRecommendations.lineId, lineId))
      .limit(1);
    const actionType = rec?.recommendedAction ?? 'pull_now';
    const woStatus: 'approved' | 'rejected' = decision === 'approved' ? 'approved' : 'rejected';
    const now = new Date();
    const audit: MaintenanceAuditEntry[] = [
      {
        at: now.toISOString(),
        by: userEmail,
        action: decision === 'escalated' ? 'rejected' : decision,
        notes: decision === 'escalated' ? `Escalated to QA${notes ? ` — ${notes}` : ''}` : notes,
        tool: 'operations_decide',
      },
    ];
    await db.insert(workOrdersApp).values({
      lineId,
      actionType,
      partId: null,
      draftedWo: `Manual ${decision} for ${lineId} via Operations queue.`,
      predictedDowntimeCostAvoidsUsd: rec?.predictedDowntimeCostUsd ?? null,
      status: woStatus,
      approvedBy: userEmail,
      auditTrail: audit,
      decidedAt: now,
    });
    res.json({ ok: true });
  });

  // GET /api/customers/:id/orders — no per-customer orders in this domain.
  app.get('/api/customers/:id/orders', async (_req, res) => {
    res.json([]);
  });

  // GET /api/facilities/summary — per-plant rollup (used by the Analytics page).
  app.get('/api/facilities/summary', async (_req, res) => {
    const [lines, woByLine] = await Promise.all([
      db.select().from(openAtrisk),
      latestWoByLine(db),
    ]);
    const byPlant = new Map<string, { count: number; pending: number; refund: number }>();
    for (const l of lines) {
      const cur = byPlant.get(l.plantId) ?? { count: 0, pending: 0, refund: 0 };
      cur.count += 1;
      if (statusOf(woByLine.get(l.lineId)) === 'pending') cur.pending += 1;
      cur.refund += Number(l.downtimeExposureUsd ?? 0);
      byPlant.set(l.plantId, cur);
    }
    res.json(
      [...byPlant.entries()].map(([plantId, v]) => ({
        facility: plantOf(plantId).city,
        return_count: v.count,
        pending_count: v.pending,
        total_refund_usd: String(Math.round(v.refund)),
      })),
    );
  });

  // GET /api/facilities/:facility/lots — not modeled per-facility; empty.
  app.get('/api/facilities/:facility/lots', async (_req, res) => {
    res.json([]);
  });
}

export function registerActivityRoutes(app: Application, deps: Deps): void {
  const { db } = deps;

  // GET /api/activity/recent — flatten work-order audit trails into a feed.
  app.get('/api/activity/recent', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const wos = await db.select().from(workOrdersApp).orderBy(desc(workOrdersApp.createdAt));
    const events: ActivityEvent[] = [];
    for (const w of wos) {
      for (const a of (w.auditTrail as MaintenanceAuditEntry[]) ?? []) {
        events.push({
          kind: 'audit',
          return_id: w.lineId,
          at: a.at,
          by: a.by,
          action: a.action,
          notes: a.notes ?? null,
          tool: a.tool ?? null,
        });
      }
    }
    events.sort((x, y) => y.at.localeCompare(x.at));
    res.json(events.slice(0, limit));
  });
}

import {
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  pgSchema,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Lakebase schema, under `app.*`.
 *
 * Template shape — three groups:
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Delta mirror    (lineStatus, openAtrisk, maintenanceRecommendations, parts)
 *                      — REPLACE for your use case. These are the OLTP-friendly
 *                      copies of lakehouse Delta tables that `db/sync.ts` pulls
 *                      at boot. Rename + reshape for your domain.
 *   3. Write-surface   Domain-specific JSONB on the work_orders_app row.
 *                      `work_orders_app.audit_trail` is an append-only log the
 *                      agent writes through. This denormalized shape makes it
 *                      easy to render a full "what happened to this order"
 *                      timeline without joins. Mirror this pattern on whatever
 *                      your primary operations entity is.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the agent do real
 * transactional writes while the analytics layer still queries Delta.
 */
export const appSchema = pgSchema('app');

// ============================================================================
// Chat state
// ============================================================================

export const conversations = appSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userEmail: text('user_email').notNull(),
    title: text('title').notNull(),
    // 'default' for regular chats, 'demo_dock' for the floating dock's
    // persistent conversation (one per user).
    kind: text('kind', { enum: ['default', 'demo_dock'] })
      .notNull()
      .default('default'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userEmail, t.updatedAt),
    index('conversations_kind_idx').on(t.userEmail, t.kind),
  ],
);

export const messages = appSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull(),
    traceId: text('trace_id'),
    // Captured reasoning steps (tool calls, outputs, intermediate messages)
    // for assistant messages. Shape matches client's ThinkingEvent union.
    thinking: jsonb('thinking').$type<ThinkingEntry[]>().notNull().default([]),
    // If the agent run failed, the error message is persisted here so a
    // page reload still shows what went wrong (instead of an empty bubble).
    error: text('error'),
    // True when the turn was stopped by the user (Stop button or page
    // navigation away from an in-flight stream). The assistant's partial
    // streamed content is still kept in `content` for context; the UI
    // renders a "Canceled by the user" banner below it.
    canceled: boolean('canceled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Unique on (conversation_id, position) so the `SELECT MAX + 1` race in
    // appendMessage surfaces as a constraint error (caller retries) instead
    // of silently inserting two messages at the same position — which
    // would break the on-reload ordering. Doubles as the lookup index.
    uniqueIndex('messages_convo_pos_uq').on(t.conversationId, t.position),
  ],
);

export const feedback = appSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    value: text('value', { enum: ['up', 'down'] }).notNull(),
    rationale: text('rationale'),
    traceId: text('trace_id'),
    mlflowAssessmentId: text('mlflow_assessment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feedback_message_idx').on(t.messageId)],
);

// ============================================================================
// Delta mirror
// ============================================================================

// Read-only mirror of gold_line_status: production line health + failure signals.
export const lineStatus = appSchema.table(
  'line_status',
  {
    id: text('id').primaryKey(), // Composite: line_id:plant_id
    lineId: text('line_id').notNull(),
    plantId: text('plant_id').notNull(),
    lineName: text('line_name').notNull(),
    plantName: text('plant_name'),
    region: text('region'),
    failureRiskScore: doublePrecision('failure_risk_score').notNull(),
    downtimeExposureUsd: doublePrecision('downtime_exposure_usd').notNull(),
    currentStatus: text('current_status', {
      enum: ['healthy', 'at_risk', 'critical'],
    }).notNull(),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
  },
  (t) => [
    index('line_status_risk_idx').on(t.failureRiskScore),
    index('line_status_plant_idx').on(t.plantId),
  ],
);

// Read-only mirror of gold_open_atrisk: lines at imminent risk.
export const openAtrisk = appSchema.table(
  'open_atrisk',
  {
    lineId: text('line_id').primaryKey(),
    plantId: text('plant_id').notNull(),
    lineName: text('line_name').notNull(),
    failureRiskScore: doublePrecision('failure_risk_score').notNull(),
    downtimeExposureUsd: doublePrecision('downtime_exposure_usd').notNull(),
    partLocal: boolean('part_local').notNull(),
    candidatePartId: text('candidate_part_id'),
    partLeadTimeDays: integer('part_lead_time_days'),
  },
  (t) => [
    index('open_atrisk_risk_idx').on(t.failureRiskScore),
    index('open_atrisk_plant_idx').on(t.plantId),
  ],
);

// Read-only mirror of gold_maintenance_recommendations: ML model ranked actions.
export const maintenanceRecommendations = appSchema.table(
  'maintenance_recommendations',
  {
    lineId: text('line_id').primaryKey(),
    recommendedAction: text('recommended_action', {
      enum: ['pull_now', 'run_to_shift_end', 'expedite_parts_and_run'],
    }).notNull(),
    predictedDowntimeCostUsd: doublePrecision('predicted_downtime_cost_usd'),
    actionRanking: jsonb('action_ranking')
      .$type<MaintenanceActionOption[]>()
      .notNull()
      .default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
);

// Read-only mirror of raw_parts: part inventory + lead times.
export const parts = appSchema.table(
  'parts',
  {
    id: text('id').primaryKey(),
    partId: text('part_id').notNull(),
    partName: text('part_name').notNull(),
    partCategory: text('part_category'),
    description: text('description'),
    partLocal: boolean('part_local').notNull(),
    leadTimeDays: integer('lead_time_days'),
    unitCostUsd: doublePrecision('unit_cost_usd'),
  },
  (t) => [
    index('parts_part_id_idx').on(t.partId),
    index('parts_local_idx').on(t.partLocal),
  ],
);

// Application-owned table: maintenance work orders drafted and approved by the agent.
export const workOrdersApp = appSchema.table(
  'work_orders_app',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineId: text('line_id').notNull(),
    actionType: text('action_type', {
      enum: ['pull_now', 'run_to_shift_end', 'expedite_parts_and_run'],
    }).notNull(),
    partId: text('part_id'),
    draftedWo: text('drafted_wo').notNull(),
    predictedDowntimeCostAvoidsUsd: doublePrecision('predicted_downtime_cost_avoided_usd'),
    status: text('status', {
      enum: ['drafted', 'approved', 'rejected'],
    })
      .notNull()
      .default('drafted'),
    approvedBy: text('approved_by'),
    auditTrail: jsonb('audit_trail')
      .$type<MaintenanceAuditEntry[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('work_orders_line_idx').on(t.lineId, t.status),
    index('work_orders_status_idx').on(t.status),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

export type MaintenanceActionOption = {
  action: 'pull_now' | 'run_to_shift_end' | 'expedite_parts_and_run';
  predictedDowntimeCostAvoidsUsd?: number;
  estimatedNetValueUsd?: number;
  partId?: string;
  estimatedLeadTimeDays?: number;
};

export type MaintenanceAuditEntry = {
  at: string;
  by: string;
  action: 'approved' | 'rejected' | 'drafted' | 'maintenance_scheduled';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };

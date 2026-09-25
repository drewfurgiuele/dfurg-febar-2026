/**
 * The plant-floor agent — the DEMO'S DEFINING PIECE, and the
 * WORKSHOP'S main graded surface.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user (OBO).
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT SHIPS WORKING vs WHAT THE TRAINEE BUILDS  (see APP_WORKSHOP.md)
 * ════════════════════════════════════════════════════════════════════════
 * SHIPS WORKING:
 *   - The full agent loop (Responses API wiring, streaming, MLflow spans).
 *   - `ask_data` — the investigation tool. Config-driven MAS-OR-Genie:
 *     uses the MAS endpoint if `masEndpointName` is set, else the Genie
 *     space if `genieSpaceId` is set. This is the trainee's Build-1 choice
 *     (they wire ONE backend); the app registers whichever is configured.
 *
 * TRAINEE BUILDS (stubbed here — they THROW "not implemented" so the app
 * still compiles + boots, and the model knows the tools exist):
 *   - `find_atrisk_line`          → Build 2 (Assist): read at-risk line
 *   - `rank_maintenance_actions`  → Build 2 (Assist): read ML ranking
 *   - `execute_maintenance_action`→ Build 3 (Act):   the human-in-the-loop write
 *
 * The three-phase chain (Discover → Draft+confirm → Execute) is described in
 * the instructions below so the model attempts it — but Phases 2/3 depend on
 * the stubbed tools, which is the point: the trainee implements them and the
 * chain lights up. Until then, the model can still investigate via ask_data.
 *
 * KEEP `configureAgentsSdk()` as-is — it handles the Databricks Responses API
 * wiring, the `Connection: close` stale-socket workaround, and the 64-char
 * `input[*].id` strip.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// Data-backend helpers. Both are config-driven and share the same
// DataCallResult shape + ToolProgressEvent stream, so the `ask_data` tool
// below can delegate to EITHER without the UI caring which powers it. This
// preserves the template's MAS-OR-Genie flexibility exactly.
import { callMasEndpoint } from './tools/mas.js';
import { callGenieSpace } from './tools/genie.js';
export type { ToolProgressEvent } from './tools/types.js';

/** Captured detail of the last failing call to the model serving endpoint. */
export type ModelErrorDetail = {
  status: number;
  url: string;
  bodyText: string;
  code?: string;
  message?: string;
};

export type AgentContext = {
  db: AppDb;
  userEmail: string;
  req: Request;
  /** MAS serving-endpoint name the `ask_data` tool talks to WHEN SET. Set in
   * `config/app.json` as `masEndpointName` (env `MAS_ENDPOINT_NAME`). Leave
   * empty to use Genie instead. This is the trainee's Build-1 backend choice
   * — the app registers whichever of MAS/Genie is configured. */
  masEndpointName: string;
  /** Genie space id the `ask_data` tool talks to WHEN `masEndpointName` is
   * empty. Set as `genieSpaceId` (env `GENIE_SPACE_ID`). */
  genieSpaceId: string;
  databricksHost: string;
  model: string;
  /** Called by long-running tools to surface progress to the UI. */
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  /** Mutated by the OpenAI fetch shim on any non-2xx. */
  modelError?: { current: ModelErrorDetail | null };
};

// ────────────────────────────────────────────────────────────────────────────
// Adding / editing tools — READ THIS before touching `parameters: z.object(...)`.
//
// The Agents SDK ships every tool's zod schema to the Responses API with
// `strict: true`. Strict mode requires EVERY property in `required`. So use
// `.nullable()`, NOT `.optional()`:
//   ❌  reason: z.string().optional()   // breaks with strict:true (masked 502)
//   ✅  reason: z.string().nullable()   // field required, value may be null
// Every field needs a `.describe(...)`. Keep property names snake_case.
// Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.
// ────────────────────────────────────────────────────────────────────────────
function makeTools(ctx: AgentContext): Tool[] {
  // ── ask_data — SHIPS WORKING. Config-driven MAS-OR-Genie. ─────────────────
  // Delegates to the MAS endpoint if one is configured, else the Genie space.
  // Both helpers return {answer, trace_id} and stream progress via
  // ctx.onToolProgress → the Thinking panel. Registered ONLY when a backend
  // is configured (otherwise the tool would 404 confusingly).
  const askData = tool({
    name: 'ask_data',
    description:
      'Investigate the governed lakehouse with a natural-language question — the tool generates SQL / retrieves knowledge and returns a synthesized answer. Use for any "why" / "what happened" / investigative question about production lines, failure trends, maintenance history, or parts availability. Prefer ONE narrow, well-formed question over many small ones.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'A clear, focused English question about the data. Narrow questions finish in 20–40s; broad multi-part questions take longer.',
        ),
    }),
    execute: async ({ question }) =>
      mlflow.withSpan(
        async () =>
          ctx.masEndpointName
            ? callMasEndpoint(ctx, ctx.masEndpointName, question)
            : callGenieSpace(ctx, ctx.genieSpaceId, question),
        {
          name: 'ask_data',
          spanType: mlflow.SpanType.TOOL,
          inputs: { question },
        },
      ),
  });

  // ── find_atrisk_line — TRAINEE BUILDS (Build 2 · Assist). STUB. ──────────
  // TODO — BUILD 2 (trainee): implement this. Read the at-risk line with the
  // worst downtime_exposure_usd from Lakebase app.open_atrisk, plus its status
  // from app.line_status: line_id, plant_id, line_name, failure_risk_score,
  // downtime_exposure_usd, part_local, candidate_part_id, part_lead_time_days.
  // Helper queries are READY in server/db/queries/maintenance.ts: `worstAtriskLine`,
  // `getLineStatus`, `getPosition`. See APP_WORKSHOP.md → "Layer 2 — Assist".
  const findAtriskLine = tool({
    name: 'find_atrisk_line',
    description:
      'Read the worst at-risk production line from Lakebase: line_id, plant_id, line_name, failure_risk_score, downtime_exposure_usd, and the candidate part (part_local flag, part_id, lead_time_days). Read-only. Also return the line\'s current_status from app.line_status.',
    parameters: z.object({
      line_id: z
        .string()
        .nullable()
        .describe('Line id, e.g. LINE-04. Null → return the worst at-risk line.'),
      plant_id: z
        .string()
        .nullable()
        .describe('Plant id, e.g. PLANT-03. Null if line_id is also null.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── rank_maintenance_actions — TRAINEE BUILDS (Build 2 · Assist). STUB. ───
  // TODO — BUILD 2 (trainee): implement this. Read app.maintenance_recommendations
  // for the line_id and return the model's recommended_action,
  // predicted_downtime_cost_usd, and the full action_ranking (all three options
  // with predicted costs + net $ + part lead times). This is the demo's
  // "ML in the loop" moment — the agent quotes the ranked options +
  // recommends the top action in the draft. Helper query READY: `getRecommendation`
  // in maintenance.ts. See APP_WORKSHOP.md → "Layer 2 — Assist".
  const rankMaintenanceActions = tool({
    name: 'rank_maintenance_actions',
    description:
      "Read the ML maintenance model's ranked actions for a line from Lakebase app.maintenance_recommendations: the recommended action, its predicted downtime cost avoided, and the full ranking of all three options (pull_now / run_to_shift_end / expedite_parts_and_run) with each option's downtime cost and net value. Read-only. Quote these in the draft; do the what-if arithmetically from the ranking.",
    parameters: z.object({
      line_id: z.string().describe('Line id, e.g. LINE-04.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── search_parts — TRAINEE BUILDS (Build 2c · Search). STUB. ──────────────
  // TODO — BUILD 2c (trainee): implement this. Search app.parts (Lakebase Search)
  // for parts matching the query (description field). Return top 5–10 matches.
  const searchParts = tool({
    name: 'search_parts',
    description:
      'Search the parts catalog via Lakebase Search over part names + descriptions. Returns top matches with part_id, part_name, part_category, part_local, lead_time_days. Use when exploring alternatives or verifying part availability.',
    parameters: z.object({
      query: z
        .string()
        .describe('Free-text search query, e.g. "bearing seal 40mm" or "hydraulic pump".'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2c Search task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── execute_maintenance_action — TRAINEE BUILDS (Build 3 · Act). STUB. ────
  // TODO — BUILD 3 (trainee): implement this — the human-in-the-loop WRITE.
  // ONLY call this AFTER the user has explicitly approved. Write the approved
  // action to Lakebase app.work_orders_app (action_type, line_id, part_id,
  // drafted_wo, predicted_downtime_cost_avoided_usd, status='approved',
  // approved_by=ctx.userEmail, an appended audit entry). Inputs are a FILTER
  // (line_id, action_type, part_id?) + the drafted WO text — NEVER a list of ids.
  // Wrap the write in db.transaction(...). On commit the caller emits dataMutated
  // so the Plant Floor page cascades. See APP_WORKSHOP.md → "Layer 3 — Act".
  const executeMaintenanceAction = tool({
    name: 'execute_maintenance_action',
    description:
      'WRITE (requires prior user approval): record the approved maintenance action to Lakebase app.work_orders_app — action_type, line_id, part_id, the drafted work order, predicted downtime cost avoided — append an audit entry, and set status to approved. Inputs are a FILTER + the drafted WO text, never a list of ids. Use ONLY after the user says yes.',
    parameters: z.object({
      line_id: z.string().describe('Production line id, e.g. LINE-04.'),
      action_type: z
        .enum(['pull_now', 'run_to_shift_end', 'expedite_parts_and_run'])
        .describe('The approved maintenance action.'),
      part_id: z
        .string()
        .nullable()
        .describe('Part id if the action involves expediting parts, else null.'),
      drafted_work_order: z
        .string()
        .describe('The full drafted work order text (the maintenance ticket).'),
      predicted_downtime_cost_avoided_usd: z
        .number()
        .nullable()
        .describe('Predicted $ of downtime cost avoided by this action.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 3 Act task; see APP_WORKSHOP.md',
      );
    },
  });

  // Config-driven data-backend tool registration. Register ONLY when a backend
  // is configured (otherwise the tool would 404 confusingly).
  const tools: Tool[] = [findAtriskLine, rankMaintenanceActions, searchParts, executeMaintenanceAction];
  if (ctx.masEndpointName) {
    tools.push(askData);
  } else if (ctx.genieSpaceId) {
    tools.push(askData);
  }
  return tools;
}

export async function configureAgentsSdk(ctx: AgentContext): Promise<void> {
  // Build a fresh auth header each configure; OpenAI SDK holds the key at
  // client construction time, so we reconfigure per request to pick up a
  // fresh bearer. (setDefaultOpenAIClient is idempotent.)
  const headers = await authHeaders(ctx.req);
  const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  // NOTE: we used to wrap with mlflow-openai's `tracedOpenAI()`, but its
  // wrapper `await`s the response to snapshot outputs — which breaks
  // streaming responses. Skip it; we still get agent-level spans via the
  // root `plantfloor.turn` and per-tool `withSpan` wrappers.
  //
  // Use a custom fetch that forces a fresh TCP connection per call and
  // disables keep-alive. Without this, after a long-running tool call
  // (ask_data → MAS takes ~90s), the second Responses API call reuses a
  // stale socket that the Databricks gateway has half-closed, which
  // surfaces as a bare 502 (no headers/body) ~3s into the call. Also bump
  // maxRetries since 502s are transient gateway failures.
  // ──────────────────────────────────────────────────────────────────
  // 64-char input[*].id workaround for Databricks' Responses API
  // ──────────────────────────────────────────────────────────────────
  //
  // Problem:
  //   On the synthesis turn (after a tool output is fed back), the agent
  //   run fails with `502 status code (no body)` after ~3s. The failure
  //   is deterministic, not transient — retries don't help.
  //
  // Root cause:
  //   The @openai/agents SDK assigns long IDs (e.g. `fc_013bda62…` ~190
  //   chars) to `reasoning` and `function_call` items in the conversation
  //   history. On round 2, the SDK echoes those items back in `input[]`.
  //   Databricks' Responses API enforces a 64-char max on `input[*].id`
  //   and returns `400 Invalid 'input[N].id': string too long`. The
  //   streaming gateway then masks that 400 as a bare 502. (Reproduced
  //   by flipping `stream: true` → `stream: false` in `scripts/repro-502.ts`:
  //   the 502 becomes a clean 400 with the real message.)
  //
  // Fix:
  //   Intercept outgoing request bodies and delete any `input[i].id`
  //   longer than 64 chars. Databricks treats missing ids as freshly
  //   generated, so this is safe — the conversation continuity is
  //   carried by `call_id` (short) for function calls, not `id`.
  //
  // Remove this wrapper once Databricks lifts the 64-char limit.
  // ──────────────────────────────────────────────────────────────────
  const client = new OpenAI({
    apiKey: bearer,
    baseURL: `${ctx.databricksHost}/serving-endpoints`,
    maxRetries: 4,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Connection', 'close');
      let body = init?.body;
      if (typeof body === 'string' && body.startsWith('{')) {
        try {
          const parsed = JSON.parse(body) as {
            input?: Array<Record<string, unknown>>;
            messages?: Array<Record<string, unknown>>;
          };
          // Responses-API: strip long opaque ids the SDK echoes back.
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input) {
              const id = item.id;
              if (typeof id === 'string' && id.length > 64) {
                delete item.id;
              }
            }
          }
          // Chat-completions: Anthropic-via-Bedrock rejects unknown keys
          // on assistant message content parts. The SDK adds
          // `annotations: []` to text parts when replaying assistant
          // history (turn 2+ of an agent loop). Strip them.
          //   400: "messages.N.content.0.text.annotations: Extra inputs are not permitted"
          if (Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              const content = (m as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                  if (part && typeof part === 'object') {
                    delete part.annotations;
                  }
                }
              }
            }
          }
          body = JSON.stringify(parsed);
        } catch {
          /* not JSON — pass through */
        }
      }
      // Always log the URL + status so failures show up in server logs.
      // The OpenAI SDK rethrows non-2xx as `APIError(... no body)` because
      // it consumes the body for retry decisions before we see it. Tee a
      // clone of the body on error so we can log Databricks' actual reason.
      const url =
        typeof input === 'string'
          ? input
          : (input as URL | Request).toString?.() ?? String(input);
      // Log every outgoing request — URL + payload preview. Without this
      // a "200 OK but empty stream" looks indistinguishable from "we never
      // called the model at all" in the logs. DEBUG-level (silent by
      // default) — set LOG_LEVEL=debug to see per-request payloads.
      console.debug(
        `[openai-shim] → ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 2000) : '(non-string)'}`,
      );
      const tShim = Date.now();
      let resp: Response;
      try {
        resp = await fetch(input as Parameters<typeof fetch>[0], {
          ...init,
          headers,
          body,
          keepalive: false,
        });
      } catch (e) {
        console.error('[openai-shim] fetch threw', { url, error: e });
        throw e;
      }
      console.debug(
        `[openai-shim] ← ${resp.status} ${resp.statusText} from ${url} in ${Date.now() - tShim}ms (content-type: ${resp.headers.get('content-type') ?? '?'})`,
      );
      if (!resp.ok) {
        try {
          const text = await resp.clone().text();
          let code: string | undefined;
          let message: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error_code?: string; message?: string };
            code = parsed.error_code;
            message = parsed.message;
          } catch {
            /* body wasn't JSON — keep raw text */
          }
          if (ctx.modelError) {
            ctx.modelError.current = {
              status: resp.status,
              url,
              bodyText: text,
              code,
              message,
            };
          }
          console.error(
            `[openai-shim] ${resp.status} from ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 4000) : '(non-string)'}\n  response_body: ${text.slice(0, 4000)}`,
          );
        } catch (e) {
          console.error('[openai-shim] failed to clone error response', e);
        }
      }
      return resp;
    },
  });
  setDefaultOpenAIClient(client);
  // Use the Responses API (the SDK's default — we leave setOpenAIAPI alone).
  // This template ships with `databricks-gpt-5-4` as the baseline agent model
  // because it supports both the Responses API passthrough AND the SDK-native
  // `response.reasoning_summary_text.*` event stream (which the UI subscribes to
  // for the live "thinking" panel). A newer GPT endpoint with `/responses`
  // enabled works too — the requirement is the Responses API, not this version.
  setTracingDisabled(true); // disable OpenAI's tracing backend; we use MLflow
}

export function buildAgent(ctx: AgentContext): Agent {
  return new Agent({
    name: 'PlantFloor',
    model: ctx.model,
    modelSettings: {
      // Enable reasoning summaries so the UI can show live "thinking"
      // (response.reasoning_summary_text.delta events). `effort: 'low'`
      // keeps time-to-first-token snappy for the demo; bump to 'medium'
      // or 'high' if the model needs more deliberation.
      reasoning: { effort: 'low', summary: 'auto' },
      // `store: false` disables the Responses API's server-side
      // conversation state. Databricks' gateway doesn't fully support the
      // state backend; leaving this on causes the second round-trip (after
      // the tool output) to hit a bare 502. Stateless runs work fine.
      store: false,
    },
    instructions: `
You are the AI assistant to Sam Ortiz, VP of Manufacturing Operations at Volta,
a precision industrial equipment firm. Your user is a busy operations exec. Be
decisive, concise, and always lead with the number.

════════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════════

ask_data(question) — delegates to the multi-agent supervisor. Use for any
  WHY / WHAT HAPPENED / investigative question about production lines,
  failure trends, maintenance history, or parts availability.
  Prefer ONE well-formed question over many small ones.

find_atrisk_line(line_id?, plant_id?) — read the worst at-risk production line
  from Lakebase: line_id, plant_id, line_name, failure_risk_score,
  downtime_exposure_usd, and the candidate part (part_local flag, part_id,
  lead_time_days). If both null, returns the worst at-risk line.

rank_maintenance_actions(line_id) — THE ML RANKING TOOL. Read app.maintenance_recommendations
  for the line and return the model's recommended_action, predicted_downtime_cost_usd,
  and the full action_ranking (all three options: pull_now / run_to_shift_end /
  expedite_parts_and_run). Quote all three in the draft; the agent picks which to
  recommend.

search_parts(query) — search the parts catalog via Lakebase Search over names +
  descriptions. Returns top matches with part_id, part_name, part_category,
  part_local, lead_time_days. Use when exploring parts or verifying availability.

execute_maintenance_action(line_id, action_type, part_id?, drafted_work_order,
  predicted_downtime_cost_avoided_usd?) — THE WRITE TOOL, APPROVAL-GATED.
  Record the approved action to app.work_orders_app: action_type, line_id,
  part_id, drafted_wo, predicted_downtime_cost_avoided_usd, status='approved',
  approved_by from userEmail, plus an audit entry. Inputs are a FILTER + drafted
  text, never a list of ids. **This is how you execute phase 3.** Do NOT call
  until the user has explicitly approved.

THERE ARE NO OTHER TOOLS. There is no manual_override, no single-part search,
no "add notes". Everything you can do is in the tools above.

════════════════════════════════════════════════════════════
OPERATING MODES
════════════════════════════════════════════════════════════

MODE A — INVESTIGATION
If the user asks "why", "what", "who", "when", or anything that requires
reading data or documents → call ask_data EXACTLY ONCE with a SHORT,
targeted question. Then synthesize for the user. Do NOT use the action
tools unless the user explicitly asks you to fix something.

**Critical for latency**: ask_data calls out to a multi-agent supervisor
that spawns sub-agents per sub-question. Broad questions trigger 4+ sub-agent
hops and take >90s. Narrow questions finish in 20-40s.

Prefer ONE of these shapes over the broad "tell me everything":
  - "Which production line is at highest failure risk right now, and why?"
  - "What is the recommended action for LINE-04, and what's the cost of delay?"

Avoid: asking for all at-risk lines + all recommended actions + all recent
incidents in a single question. The supervisor will hop 4 times.

MODE B — ACTION CHAIN (HUMAN-IN-THE-LOOP, RANKED BY ML)
If the user asks you to HANDLE / FIX / SCHEDULE / EXECUTE something, you
run a three-phase chain with a confirmation step in the middle. The defining
move: **you rank the recovery options by the ML model's predicted value**.

**The story beat that lands the model**: The maintenance recommender model
(trained on 5 years of plant logs) ranks pull_now / run_to_shift_end /
expedite_parts_and_run by net downtime cost avoided. For LINE-04's imminent
failure (risk score 0.87), the model recommends *pull_now* because the part is
non-local (14-day lead time), and delaying is more costly than stopping the line
now. You don't call the model; you read the ranked options from app.maintenance_recommendations.
ALWAYS quote the full ranking (predicted $ for each option) so the user sees the
model's logic before approving.

**Frame expedite honestly — it is NOT co-equal.** expedite_parts_and_run only nets
positive value when the part is stocked LOCALLY (part_local = true, short lead time),
which happens on moderate-risk lines. For a high-risk line whose part is non-local
(like LINE-04's ~14-day lead time), expedite is the weakest play and pull_now wins —
the part_local flag decides which options are even viable. Never present the three as
equal choices; let the ranking + part locality drive the recommendation.

Phase 1 and 2 are "prepare + show the user what will happen". Phase 3
is the write tool. NEVER run phase 3 (execute_maintenance_action) until the
user has explicitly approved.

--- Phase 1 · Discover (read-only) ---

  1. If you don't already know the target line, call ask_data with a
     precise question: "Which production line is at highest failure risk
     right now, and what is the candidate part?". Extract the line_id
     and plant_id from the answer. If ask_data cannot produce a clear line,
     ask the user once — do not guess.

  2. Call find_atrisk_line(line_id, plant_id). Output: line_name,
     failure_risk_score, downtime_exposure_usd, part_local, candidate_part_id,
     part_lead_time_days, current_status. Remember these — you quote them in
     Phase 2.

  3. Call rank_maintenance_actions(line_id). Output: recommended_action,
     predicted_downtime_cost_usd, action_ranking (all three options with
     predicted downtime costs + net $). Remember the full ranking — you
     quote ALL THREE options in Phase 2 because the story beat is "here's
     what the model ranked".

--- Phase 2 · Draft + ASK FOR CONFIRMATION ---

  4. Draft a ONE-PAGE work order for the recommended action. Use this shape:
       - Header: Line name + risk score + plant id + immediate downtime exposure.
       - Problem: one-paragraph summary of why this line is at risk
         (failure predictors, what fails if delayed).
       - Recommendation: quote the ML-ranked options (all three with $ costs),
         bold the recommended one, explain why.
       - Action: detailed work order steps for the recommended action.
       - Impact: predicted downtime cost avoided + schedule impact.

  5. Reply to the user with:
       - A bold headline: "LINE-{id} (PLANT-{pid}) is trending toward failure.
         Risk score {X}%. Recommended action: {action}. Downtime exposure: $\{Y\}."
       - The drafted work order in a fenced markdown block.
       - The full ranked options as a markdown table:
         | Action | Predicted Cost Avoided | Est. Net Value |
         showing pull_now / run_to_shift_end / expedite_parts_and_run.
       - A single-sentence CTA:
           "Reply **pull the line** to approve the recommended action —
            or ask me to reconsider."

     STOP HERE. Do not proceed until the user's next message.

--- Phase 3 · Execute the action (on approval) ---

  Triggered only when the user's NEXT message is an approval (any form:
  "pull", "go", "ok", "approved", "ship it", "do it", "yes", "proceed",
  "looks good", "execute"). Anything that looks like a revision
  ("make it safer", "add more detail", "how long will it take") means →
  revise ONLY the affected section of the work order and go back to phase 2
  step 5 (STOP for confirmation again). Do NOT re-rank options on revision.

  On approval:

    A. Call execute_maintenance_action exactly ONCE with:
         line_id: the line id from phase 1 step 1
         action_type: the recommended_action from rank_maintenance_actions
         part_id: the candidate_part_id (or null if action doesn't need parts)
         drafted_work_order: the full work order text from phase 2 step 4
         predicted_downtime_cost_avoided_usd: from rank_maintenance_actions

    B. Final summary — see "SUMMARY FORMAT" below. Use counts + values
       returned by the tool, not your own memory.

If execute_maintenance_action errors, surface the error plainly. Never
pretend a tool ran.

════════════════════════════════════════════════════════════
WORK ORDER CRAFT
════════════════════════════════════════════════════════════

Tone: direct, professional, actionable. This is a safety-critical ticket.
Length: ~200 words — enough detail for the maintenance crew.

Include:
  - Line id + plant location
  - Reason for the action (what fails if delayed)
  - Exact steps (pull procedure / run-to-shift procedure / expedite vendor call)
  - Part id + lead time if applicable
  - Verification steps (how to confirm the action was effective)

Never use jargon without context — translate "cavitation risk" to "pump
failure due to internal pressure collapse".

--- TEMPLATE EXAMPLE (use this shape, rewrite the prose if you want) ---

  **Volta Production Line: Preventive Maintenance Work Order**

  **Line:** LINE-04 (Plant 3, Ohio) | **Status:** Critical (Failure Risk 87%)
  **Part:** Coupling Seal Assembly (non-local, 14-day lead time)

  **Why Now:** Advanced sensor fusion (bearing temperature trending + vibration
  amplitude) predicts imminent seal failure within 48 hours. Delay costs $240K
  unplanned downtime; immediate pull costs $8K scheduled maintenance.

  **Action:** Pull the line immediately. Scheduled maintenance window: 4 hours.
  Disconnect drive coupling, replace seal assembly (pre-order via expedite if
  not on-hand), verify bearing temperature drop <5°C post-run, resume production.

  **Expected Outcome:** Line returns to normal duty cycle. No throughput loss if
  completed before next shift.

  **Follow-up:** Monitor bearing temperature daily × 7 days. Escalate if
  temperature rises >2°C from baseline.

--- END TEMPLATE ---

When you show the draft in phase 2, include the work order inside a
fenced markdown code block (triple backticks) so the user can see it clearly.

════════════════════════════════════════════════════════════
SUMMARY FORMAT (final assistant message)
════════════════════════════════════════════════════════════

ALWAYS end an action chain with a markdown summary the ops exec can
read in 10 seconds. Example:

**Done — LINE-04 maintenance scheduled.**

- **Line:** LINE-04 (PLANT-03, Ohio) | Risk score 87% → controlled
- **Action:** Pull the line immediately (4-hour window)
  - Reason: Coupling seal failure predicted within 48 hours
  - Cost avoided: $240K downtime vs $8K maintenance
- **Part:** Coupling Seal Assembly (non-local, expedite ordered)
  - Lead time: 14 days (waiting on expedite vendor call)
  - Status: Pre-order confirmed
- **Next Step:** Monitor bearing temperature daily × 7 days

Rules:
- Markdown-bold the headline stat on line 1.
- Numbers come from your tool calls (rank_maintenance_actions returns
  predicted_downtime_cost_avoided_usd; find_atrisk_line returns part_lead_time_days)
  — NOT from memory.
- Quote the full ML ranking from rank_maintenance_actions — all three options
  with $ values. That's the load-bearing model-value moment.
- Close with ONE concrete "next step" only.

════════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════════

The user is busy. Lead with the answer. No preamble like "Sure, I'll
help!". No questions-about-your-question unless something is genuinely
ambiguous. When investigating, synthesize — don't dump raw data. On the
plant floor, speed and clarity matter.
`.trim(),
    tools: makeTools(ctx),
  });
}

export { run };

import {
  ACTIVE_BATCH_STATES,
  ACTIVE_JOB_STATES,
  BATCH_STATES,
  ERROR_ACTIONS,
  ERROR_CODES,
  JOB_SET_STATES,
  JOB_SOURCES,
  JOB_STATES,
  OPS,
  SPEED_IDS,
} from "@openfield/core/constants";
import type { BatchHandle, JobHandle, NormalizedRequest } from "@openfield/core/schemas";
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { flag, json, oneOf } from "./_helpers";
import { canvases, canvasRuns } from "./canvas";
import { providers } from "./providers";

// A job set is one submit (one Generate click, edit commit or canvas node run) with N outputs.
// A job is one output and one feed tile (§0.1).
export const jobSets = sqliteTable(
  "job_sets",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").unique(), // client ULID, one per job set (§0.2)
    op: text("op", { enum: OPS }).notNull(),
    modality: text("modality").notNull().default("image"),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    modelId: text("model_id").notNull(),
    prompt: text("prompt").notNull().default(""), // as submitted: after enhance, after preset
    promptOriginal: text("prompt_original"), // what the person typed, when the enhancer rewrote it
    negativePrompt: text("negative_prompt"),
    // The frozen request. Recreate replays this, never the current UI or manifest (§0.11).
    requestJson: json<NormalizedRequest>("request_json").notNull(),
    batchSize: integer("batch_size").notNull().default(1),
    priority: integer("priority").notNull().default(10), // composer and single node 10, run-all 5 (§0.12)
    status: text("status", { enum: JOB_SET_STATES }).notNull().default("pending"),
    source: text("source", { enum: JOB_SOURCES }).notNull().default("composer"),
    canvasId: text("canvas_id").references(() => canvases.id, { onDelete: "set null" }),
    canvasNodeId: text("canvas_node_id"),
    canvasRunId: text("canvas_run_id").references(() => canvasRuns.id, { onDelete: "set null" }),
    costEstimateUsd: real("cost_estimate_usd"),
    costActualUsd: real("cost_actual_usd"),
    errorCode: text("error_code", { enum: ERROR_CODES }),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    // The speed resolved for this model at submit (§0.3), a copy of request_json.speed so tiles and
    // queries needn't parse JSON. Added in 0003.
    speed: text("speed", { enum: SPEED_IDS }).notNull().default("standard"),
  },
  (t) => [
    check("job_sets_op_check", oneOf("op", OPS)),
    // UI cap is 4 (observed parity); raising it requires a migration and a manifest change.
    check("job_sets_batch_size_check", sql`batch_size BETWEEN 1 AND 4`),
    check("job_sets_status_check", oneOf("status", JOB_SET_STATES)),
    check("job_sets_source_check", oneOf("source", JOB_SOURCES)),
    check("job_sets_speed_check", oneOf("speed", SPEED_IDS)),
    index("idx_job_sets_created").on(sql`created_at DESC`),
    // Scheduler order (§0.12): priority DESC, then created_at, then jobs.idx.
    index("idx_job_sets_sched").on(sql`priority DESC`, t.createdAt).where(oneOf("status", ACTIVE_JOB_STATES)),
    index("idx_job_sets_canvas").on(t.canvasId, t.canvasNodeId),
    index("idx_job_sets_run").on(t.canvasRunId),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    jobSetId: text("job_set_id")
      .notNull()
      .references(() => jobSets.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(), // 0..batch_size-1, placeholder order
    providerJobId: text("provider_job_id"),
    idempotencyKey: text("idempotency_key"), // `${jobSet.idempotency_key}:${idx}`, same on every attempt
    status: text("status", { enum: JOB_STATES }).notNull().default("pending"),
    progress: real("progress"), // 0..1 when the provider reports it
    seed: integer("seed"), // NULL unless the model supports seeds (§0.11)
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    errorCode: text("error_code", { enum: ERROR_CODES }),
    errorMessage: text("error_message"), // detail for the error log, never shown
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    // Added in 0002, so it sits last. Our copy for the tile, when it says more than the code does.
    errorReason: text("error_reason"),
    // The speed the company says it served (§0.13). NULL until the job ends. Added in 0003.
    speedUsed: text("speed_used", { enum: SPEED_IDS }),
    // The failed tile's button when it isn't the code's usual one, such as Try again on a Batch
    // image (§0.5). NULL: the code's own. Added in 0004.
    errorAction: text("error_action", { enum: ERROR_ACTIONS }),
    // Restarts (§0.4, §6.7). Added in 0005.
    // The adapter's resume data, written the moment submit() returns for a resumable call and
    // before the first poll. Never sent to the browser.
    handle: json<JobHandle>("handle"),
    // Sent at a speed in the model's resumableSpeeds (§6.3). Written when the call is sent.
    resumable: flag("resumable", 0),
    // Picked up by the company's id after a restart: "Picking up where it left off".
    resumedAt: text("resumed_at"),
    // Sent again at boot because it couldn't resume. Set once, so a job runs again at most once.
    rerunAt: text("rerun_at"),
  },
  (t) => [
    unique("jobs_job_set_id_idx_unique").on(t.jobSetId, t.idx),
    check("jobs_status_check", oneOf("status", JOB_STATES)),
    // NULL passes: NULL IN (…) is not false.
    check("jobs_speed_used_check", oneOf("speed_used", SPEED_IDS)),
    // Queue scan and crash recovery: a tiny partial index, always hot.
    index("idx_jobs_active").on(t.status, t.nextAttemptAt).where(oneOf("status", ACTIVE_JOB_STATES)),
    index("idx_jobs_job_set").on(t.jobSetId, t.idx),
  ],
);

// One row per job set that runs at the Batch speed: the provider batch carrying its N requests
// (§0.4, §6.7). Written in state 'submitting' before the create call, so a crash mid-call is
// recovered by display name instead of resent: creating a batch is not idempotent.
export const providerBatches = sqliteTable(
  "provider_batches",
  {
    id: text("id").primaryKey(),
    jobSetId: text("job_set_id")
      .notNull()
      .unique()
      .references(() => jobSets.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    modelId: text("model_id").notNull(),
    remoteId: text("remote_id"), // the company's id; NULL until the create call returns
    displayName: text("display_name").notNull(), // 'openfield-<jobSetId>', what batch.find() matches
    state: text("state", { enum: BATCH_STATES }).notNull().default("submitting"),
    handle: json<BatchHandle>("handle"), // the adapter's resume data (§6.7)
    itemCount: integer("item_count").notNull(),
    // Last 4 of the key it was sent with: a batch belongs to that key's project.
    credentialHint: text("credential_hint"),
    submittedAt: text("submitted_at"),
    expiresAt: text("expires_at"), // from the company (Google: create + 48 h)
    lastPolledAt: text("last_polled_at"),
    nextPollAt: text("next_poll_at"), // the §0.12 schedule, kept across restarts
    finishedAt: text("finished_at"),
    notifiedAt: text("notified_at"), // finish toast and notification sent once (§2.4)
    cleanedAt: text("cleaned_at"), // batch.cleanup() done at the company
    errorCode: text("error_code", { enum: ERROR_CODES }), // a whole-batch failure
    errorMessage: text("error_message"), // detail for the error log, never shown
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("provider_batches_state_check", oneOf("state", BATCH_STATES)),
    // The watcher's scan: active batches by next poll. Tiny, always hot.
    index("idx_provider_batches_active").on(t.state, t.nextPollAt).where(oneOf("state", ACTIVE_BATCH_STATES)),
  ],
);

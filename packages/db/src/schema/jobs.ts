import {
  ACTIVE_JOB_STATES,
  ERROR_CODES,
  JOB_SET_STATES,
  JOB_SOURCES,
  JOB_STATES,
  OPS,
} from "@openfield/core/constants";
import type { NormalizedRequest } from "@openfield/core/schemas";
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { json, oneOf } from "./_helpers";
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
  },
  (t) => [
    check("job_sets_op_check", oneOf("op", OPS)),
    // UI cap is 4 (observed parity); raising it requires a migration and a manifest change.
    check("job_sets_batch_size_check", sql`batch_size BETWEEN 1 AND 4`),
    check("job_sets_status_check", oneOf("status", JOB_SET_STATES)),
    check("job_sets_source_check", oneOf("source", JOB_SOURCES)),
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
  },
  (t) => [
    unique("jobs_job_set_id_idx_unique").on(t.jobSetId, t.idx),
    check("jobs_status_check", oneOf("status", JOB_STATES)),
    // Queue scan and crash recovery: a tiny partial index, always hot.
    index("idx_jobs_active").on(t.status, t.nextAttemptAt).where(oneOf("status", ACTIVE_JOB_STATES)),
    index("idx_jobs_job_set").on(t.jobSetId, t.idx),
  ],
);

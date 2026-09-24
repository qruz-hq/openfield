import { z } from "zod";
import {
  batchStateSchema,
  cursorSchema,
  errorActionSchema,
  errorCodeSchema,
  jobSetStateSchema,
  jobSourceSchema,
  jobStateSchema,
  modelKeySchema,
  opSchema,
  providerIdSchema,
  queryLimitSchema,
  speedIdSchema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";

// Job sets and jobs on the wire (§0.1, §8.3.1). A job set is one submit; a job is one image.

/**
 * What an adapter needs to find its work again after a restart (§6.7). For a resumable call it is
 * stored whole on jobs.handle the moment submit() returns, before the first poll. Never sent to the
 * browser.
 */
export const jobHandleSchema = z.object({
  jobId: ulidSchema,
  /** The company's id: request id, prediction id, response id. Copied to jobs.provider_job_id. */
  providerRef: z.string().optional(),
  statusUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
  resume: z.record(z.string(), z.unknown()).optional(),
  attempt: z.int().nonnegative(),
});

/**
 * What a provider batch needs to be found again after a restart (§6.7). Stored whole on
 * provider_batches.handle.
 */
export const batchHandleSchema = z.object({
  /** The company's id: "batches/abc", "batch_abc". */
  remoteId: z.string().min(1),
  /** "openfield-<jobSetId>", what batch.find() matches. */
  displayName: z.string().min(1),
  /** From the company: Google expires a batch 48 hours after it's created. */
  expiresAt: timestampSchema,
  /** What poll, cancel and cleanup need, such as uploaded file ids. */
  resume: z.record(z.string(), z.unknown()).optional(),
});

export const batchCountsSchema = z.object({
  total: z.int().nonnegative(),
  succeeded: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  pending: z.int().nonnegative(),
});

/** A Batch run's provider batch, as tiles and GET /api/job-sets/:id show it. */
export const batchSummarySchema = z.object({
  state: batchStateSchema,
  /** Null while the create call is in flight. */
  submittedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  counts: batchCountsSchema.optional(),
  /** A cancel was sent and the company hasn't stopped yet: the tiles stop offering Cancel. */
  stopping: z.boolean().optional(),
});

/** The batch.updated frame, and each entry of snapshot.batches (§0.6). */
export const batchUpdatedSchema = batchSummarySchema.extend({
  jobSetId: ulidSchema,
  providerId: providerIdSchema,
  /** So the finish notice can name the model even when the run isn't loaded in the tab. */
  modelKey: modelKeySchema,
  /** The frame the browser turns into the finish toast and system notification. */
  finished: z.boolean(),
});

export const jobSchema = z.object({
  id: ulidSchema,
  jobSetId: ulidSchema,
  idx: z.int().nonnegative(),
  status: jobStateSchema,
  /** Resolved before any provider call so placeholders reserve the right shape. */
  width: z.int().positive(),
  height: z.int().positive(),
  /** 0 to 1, when the provider reports it. */
  progress: z.number().min(0).max(1).nullable(),
  seed: z.int().nullable(),
  attempt: z.int().nonnegative(),
  assetId: ulidSchema.nullable(),
  errorCode: errorCodeSchema.nullable(),
  /** Detail for the error log. Never shown. */
  errorMessage: z.string().nullable(),
  /** Our tile reason, when it says more than the code's usual words. Shown as is. */
  errorReason: z.string().nullable(),
  /** The failed tile's button, when it isn't the code's usual one (§0.5). */
  errorAction: errorActionSchema.nullish(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  /** The speed the company says it served, once the job ends. Cost follows it (§0.13). */
  speedUsed: speedIdSchema.nullish(),
  /** When a job waiting out a retry or a Flex busy answer goes again. */
  nextAttemptAt: timestampSchema.nullish(),
  /** Picked up by the company's id after a restart: "Picking up where it left off" (§0.4). */
  resumedAt: timestampSchema.nullish(),
  /** Sent again at boot because its call couldn't resume, so it may be charged twice (§0.4). */
  rerunAt: timestampSchema.nullish(),
});

export const jobSetSchema = z.object({
  id: ulidSchema,
  status: jobSetStateSchema,
  op: opSchema,
  model: modelKeySchema,
  batchSize: z.int().min(1),
  /** As sent, after enhance and presets. */
  prompt: z.string(),
  /** What the person typed, when the enhancer rewrote it. */
  promptOriginal: z.string().nullable(),
  source: jobSourceSchema,
  priority: z.int(),
  costEstimateUsd: usdSchema.nullable(),
  costActualUsd: usdSchema.nullable(),
  errorCode: errorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  canvasId: ulidSchema.nullable(),
  canvasNodeId: z.string().nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  /** The speed this run was resolved to at submit (§0.3). Picks the tile's variant (§2.4). */
  speed: speedIdSchema.default("standard"),
});

export const jobSetWithJobsSchema = z.object({
  jobSet: jobSetSchema,
  jobs: z.array(jobSchema),
  /** Only for a Batch run. */
  batch: batchSummarySchema.optional(),
});

/** 202 from POST /api/generate, /api/edit and /api/job-sets/:id/recreate. */
export const jobSetAcceptedSchema = jobSetWithJobsSchema;

/** GET /api/job-sets */
export const jobSetsListQuerySchema = z.object({
  status: z.enum(["active", "all"]).default("active"),
  cursor: cursorSchema.optional(),
  limit: queryLimitSchema.optional(),
});
export const jobSetsListResponseSchema = z.object({
  items: z.array(jobSetWithJobsSchema),
  nextCursor: cursorSchema.nullable(),
});

/** POST /api/job-sets/:id/cancel and /api/canvases/:id/runs/:runId/cancel */
export const cancelResponseSchema = z.object({
  canceled: z.array(ulidSchema),
  notCancelable: z.array(ulidSchema),
  /** Sent images of a Batch run: the company was asked to stop, and they end when it has. */
  stopping: z.array(ulidSchema).optional(),
});

/** POST /api/job-sets/:id/retry */
export const jobSetRetryBodySchema = z.object({ onlyFailed: z.boolean().optional() });

export type JobHandle = z.infer<typeof jobHandleSchema>;
export type BatchHandle = z.infer<typeof batchHandleSchema>;
export type BatchCounts = z.infer<typeof batchCountsSchema>;
export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchUpdated = z.infer<typeof batchUpdatedSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobSet = z.infer<typeof jobSetSchema>;
export type JobSetWithJobs = z.infer<typeof jobSetWithJobsSchema>;
export type JobSetAccepted = z.infer<typeof jobSetAcceptedSchema>;
export type JobSetsListResponse = z.infer<typeof jobSetsListResponseSchema>;
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

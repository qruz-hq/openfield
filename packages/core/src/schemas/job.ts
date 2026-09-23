import { z } from "zod";
import {
  cursorSchema,
  errorCodeSchema,
  jobSetStateSchema,
  jobSourceSchema,
  jobStateSchema,
  modelKeySchema,
  opSchema,
  queryLimitSchema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";

// Job sets and jobs on the wire (§0.1, §8.3.1). A job set is one submit; a job is one image.

/** What an adapter needs to find its work again after a restart. Stored as JSON. */
export const jobHandleSchema = z.object({
  jobId: ulidSchema,
  /** request_id, prediction id, … */
  providerRef: z.string().optional(),
  statusUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
  resume: z.record(z.string(), z.unknown()).optional(),
  attempt: z.int().nonnegative(),
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
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
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
});

export const jobSetWithJobsSchema = z.object({ jobSet: jobSetSchema, jobs: z.array(jobSchema) });

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
});

/** POST /api/job-sets/:id/retry */
export const jobSetRetryBodySchema = z.object({ onlyFailed: z.boolean().optional() });

export type JobHandle = z.infer<typeof jobHandleSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobSet = z.infer<typeof jobSetSchema>;
export type JobSetWithJobs = z.infer<typeof jobSetWithJobsSchema>;
export type JobSetAccepted = z.infer<typeof jobSetAcceptedSchema>;
export type JobSetsListResponse = z.infer<typeof jobSetsListResponseSchema>;
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

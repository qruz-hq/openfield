import { z } from "zod";
import type { SseEventType } from "../constants";
import { assetListItemSchema } from "./asset";
import { canvasRunStateSchema } from "./canvas";
import {
  jobSetStateSchema,
  modelKeySchema,
  providerIdSchema,
  timestampSchema,
  ulidSchema,
  usdSchema,
} from "./common";
import { jobErrorSchema } from "./errors";
import { batchUpdatedSchema, jobSetWithJobsSchema } from "./job";
import { maintenanceTaskSchema } from "./usage";

// One stream, GET /api/events (§0.6, §8.3.2). Each frame parses as { event, data }.

const jobRef = { jobSetId: ulidSchema, jobId: ulidSchema, idx: z.int().nonnegative() };

const frame = <E extends SseEventType, D extends z.ZodType>(event: E, data: D) =>
  z.object({ event: z.literal(event), data });

export const sseEventSchema = z.discriminatedUnion("event", [
  frame(
    "snapshot",
    z.object({
      activeJobSets: z.array(jobSetWithJobsSchema),
      serverTime: timestampSchema,
      /** Every active provider batch, plus finished ones no client has heard about yet. */
      batches: z.array(batchUpdatedSchema).default([]),
    }),
  ),
  frame("job_set.created", jobSetWithJobsSchema),
  frame(
    "job.queued",
    z.object({
      ...jobRef,
      /** How many runs are ahead of this one, starting at 1. */
      position: z.int().positive().optional(),
      /** When a job waiting out a retry or a busy answer goes again, for the countdown. */
      retryAt: timestampSchema.optional(),
      /** Waiting out a Flex busy answer, not an ordinary retry. */
      busy: z.literal(true).optional(),
    }),
  ),
  frame(
    "job.started",
    z.object({
      ...jobRef,
      startedAt: timestampSchema,
      /** Sent again after a restart because its call couldn't resume (§0.4). */
      rerun: z.literal(true).optional(),
    }),
  ),
  frame("job.progress", z.object({ ...jobRef, progress: z.number().min(0).max(1) })),
  /** A preview frame from tmp/. Never an asset; the final job.output replaces it. */
  frame(
    "job.partial",
    z.object({
      ...jobRef,
      partialIndex: z.int().nonnegative(),
      thumbUrl: z.string(),
      width: z.int().positive(),
      height: z.int().positive(),
    }),
  ),
  frame("job.output", z.object({ ...jobRef, asset: assetListItemSchema })),
  frame("job.failed", z.object({ ...jobRef, error: jobErrorSchema })),
  /** discarded: canceled after submit, so the provider may still bill it. */
  frame("job.canceled", z.object({ ...jobRef, discarded: z.boolean() })),
  frame(
    "job_set.completed",
    z.object({
      jobSetId: ulidSchema,
      status: jobSetStateSchema,
      costActualUsd: usdSchema.nullable(),
      durationMs: z.int().nonnegative(),
    }),
  ),
  /** A provider batch changed state. The one with finished: true drives the toast and notification. */
  frame("batch.updated", batchUpdatedSchema),
  frame("asset.updated", z.object({ asset: assetListItemSchema })),
  frame("asset.deleted", z.object({ assetIds: z.array(ulidSchema), hard: z.boolean() })),
  frame("folder.updated", z.object({ folderId: ulidSchema, deleted: z.boolean() })),
  frame(
    "models.updated",
    z.object({
      providerId: providerIdSchema.optional(),
      added: z.array(modelKeySchema),
      updated: z.array(modelKeySchema),
      removed: z.array(modelKeySchema),
    }),
  ),
  frame("usage.updated", z.object({ jobSetId: ulidSchema.optional() })),
  /** The whole run state, so a reloaded tab re-attaches from one frame. At most 10 a second per run. */
  frame("canvas_run.updated", canvasRunStateSchema),
  frame(
    "maintenance.progress",
    z.object({
      task: maintenanceTaskSchema,
      done: z.int().nonnegative(),
      total: z.int().nonnegative(),
      finished: z.boolean(),
    }),
  ),
]);

export type SseEvent = z.infer<typeof sseEventSchema>;
export type SsePayload<E extends SseEventType> = Extract<SseEvent, { event: E }>["data"];

/** Parse one EventSource message. Returns null for unknown or malformed frames. */
export function parseSseFrame(event: string, data: string): SseEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = sseEventSchema.safeParse({ event, data: json });
  return parsed.success ? parsed.data : null;
}

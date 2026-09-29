import {
  type BatchCounts,
  type BatchSummary,
  type BatchUpdated,
  isTerminalBatchState,
  isTerminalState,
  type Job,
  type JobSet,
  type JobSetWithJobs,
  type Modality,
  type NormalizedRequest,
  type PixelSize,
} from "@openfield/core";
import type { AssetRow, JobRow, JobSetRow, ProviderBatchRow } from "@openfield/db";
import { plannedVideoSize, resolveSize } from "@openfield/providers/manifest";
import { modelKeyOf } from "./asset";

// Job set and job rows to wire shapes (§8.3.1).

export function toJobSet(row: JobSetRow): JobSet {
  return {
    id: row.id,
    status: row.status,
    op: row.op,
    model: modelKeyOf(row.providerId, row.modelId),
    modality: row.modality as Modality,
    batchSize: row.batchSize,
    prompt: row.prompt,
    promptOriginal: row.promptOriginal,
    source: row.source,
    priority: row.priority,
    costEstimateUsd: row.costEstimateUsd,
    costActualUsd: row.costActualUsd,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    canvasId: row.canvasId,
    canvasNodeId: row.canvasNodeId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    speed: row.speed,
  };
}

/**
 * The size a placeholder reserves before any image exists, from the frozen request. normalize()
 * already filled the resolution tier when the model has one, so no manifest is needed here.
 */
export function plannedSize(request: NormalizedRequest): PixelSize {
  const size = request.size;
  if ("width" in size) return { width: size.width, height: size.height };
  // A video's shape at its own resolution: 720p is 1280×720 at 16:9, whatever image tiers say.
  if (request.video?.resolution) return plannedVideoSize(size.aspect, request.video.resolution);
  return resolveSize(size.aspect, request.resolution ?? "1K");
}

export function toJob(row: JobRow, planned: PixelSize, asset?: AssetRow): Job {
  return {
    id: row.id,
    jobSetId: row.jobSetId,
    idx: row.idx,
    status: row.status,
    width: asset?.width ?? planned.width,
    height: asset?.height ?? planned.height,
    progress: row.progress,
    seed: row.seed,
    attempt: row.attempt,
    assetId: asset?.id ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    errorReason: row.errorReason,
    errorAction: row.errorAction,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    speedUsed: row.speedUsed,
    nextAttemptAt: row.nextAttemptAt,
    // What a restart did, for the tile (§2.4). The stored handle itself never leaves the server.
    resumedAt: row.resumedAt,
    rerunAt: row.rerunAt,
  };
}

/** Counts from the run's own jobs, for a snapshot or a finished batch. */
export function batchCounts(batch: ProviderBatchRow, jobs: readonly JobRow[]): BatchCounts {
  const succeeded = jobs.filter((j) => j.status === "succeeded").length;
  const pending = jobs.filter((j) => !isTerminalState(j.status)).length;
  const total = Math.max(batch.itemCount, jobs.length);
  return { total, succeeded, failed: Math.max(0, total - succeeded - pending), pending };
}

export function toBatchSummary(batch: ProviderBatchRow, jobs: readonly JobRow[]): BatchSummary {
  return {
    state: batch.state,
    submittedAt: batch.submittedAt,
    expiresAt: batch.expiresAt,
    counts: batchCounts(batch, jobs),
    // Canceled here, and the company hasn't stopped yet.
    ...(batch.errorCode === "canceled" && batch.finishedAt === null && { stopping: true }),
  };
}

/**
 * The batch.updated frame and a snapshot entry (§0.6). `counts` overrides the jobs' own tally;
 * `canvasId` comes from the run's job set.
 */
export function toBatchUpdated(
  batch: ProviderBatchRow,
  jobs: readonly JobRow[],
  { counts, canvasId }: { counts?: BatchCounts | undefined; canvasId?: string | null | undefined } = {},
): BatchUpdated {
  return {
    ...toBatchSummary(batch, jobs),
    ...(counts && { counts }),
    jobSetId: batch.jobSetId,
    providerId: batch.providerId,
    modelKey: modelKeyOf(batch.providerId, batch.modelId),
    finished: isTerminalBatchState(batch.state),
    ...(canvasId && { canvasId }),
  };
}

export function toJobSetWithJobs(bundle: {
  jobSet: JobSetRow;
  jobs: JobRow[];
  assets?: AssetRow[];
  batch?: ProviderBatchRow | undefined;
}): JobSetWithJobs {
  const planned = plannedSize(bundle.jobSet.requestJson);
  return {
    jobSet: toJobSet(bundle.jobSet),
    jobs: bundle.jobs.map((job) =>
      toJob(
        job,
        planned,
        bundle.assets?.find((a) => a.jobId === job.id),
      ),
    ),
    ...(bundle.batch && { batch: toBatchSummary(bundle.batch, bundle.jobs) }),
  };
}

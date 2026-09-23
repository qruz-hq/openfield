import type { Job, JobSet, JobSetWithJobs, NormalizedRequest, PixelSize } from "@openfield/core";
import type { AssetRow, JobRow, JobSetRow } from "@openfield/db";
import { resolveSize } from "@openfield/providers/manifest";
import { modelKeyOf } from "./asset";

// Job set and job rows to wire shapes (§8.3.1).

export function toJobSet(row: JobSetRow): JobSet {
  return {
    id: row.id,
    status: row.status,
    op: row.op,
    model: modelKeyOf(row.providerId, row.modelId),
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
  };
}

/**
 * The size a placeholder reserves before any image exists, from the frozen request. normalize()
 * already filled the resolution tier when the model has one, so no manifest is needed here.
 */
export function plannedSize(request: NormalizedRequest): PixelSize {
  const size = request.size;
  if ("width" in size) return { width: size.width, height: size.height };
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
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function toJobSetWithJobs(bundle: {
  jobSet: JobSetRow;
  jobs: JobRow[];
  assets?: AssetRow[];
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
  };
}

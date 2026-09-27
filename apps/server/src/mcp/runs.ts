import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { ACTIVE_JOB_STATES, errorCopy, isTerminalState } from "@openfield/core";
import { getJobSetBundle } from "@openfield/db";
import { describeImages, type ImageInfo } from "./images";
import { Refusal, type ToolContext } from "./kit";

// A run (a job set: one request, one to four images) as an agent reads it.

const ACTIVE = new Set<string>(ACTIVE_JOB_STATES);

export interface RunSummary {
  runId: string;
  status: string;
  finished: boolean;
  model: string;
  modelName: string;
  prompt: string;
  speed: string;
  estimateUsd: number | null;
  spentUsd: number | null;
  images: (ImageInfo & { jobId: string })[];
  failed: { jobId: string; reason: string }[];
  /** Images not made yet. */
  waiting: number;
  next?: string;
}

export async function describeRun(
  ctx: ToolContext,
  runId: string,
  opts: { previews: boolean },
): Promise<{ summary: RunSummary; blocks: ImageContent[] }> {
  const bundle = getJobSetBundle(ctx.svc.db, runId);
  if (!bundle) throw new Refusal(`There's no run with the id ${runId}.`);
  const { jobSet, jobs, assets } = bundle;
  const made = jobs.flatMap((job) => {
    const asset = assets.find((a) => a.jobId === job.id);
    return asset ? [{ job, asset }] : [];
  });
  const { images, blocks } = await describeImages(
    ctx,
    made.map((m) => m.asset),
    { previews: opts.previews },
  );
  const key = `${jobSet.providerId}:${jobSet.modelId}`;
  const finished = isTerminalState(jobSet.status);
  const summary: RunSummary = {
    runId: jobSet.id,
    status: jobSet.status,
    finished,
    model: key,
    modelName: ctx.svc.models.get(key)?.displayName ?? jobSet.modelId,
    prompt: jobSet.prompt,
    speed: jobSet.speed,
    estimateUsd: jobSet.costEstimateUsd,
    spentUsd: jobSet.costActualUsd,
    images: images.map((image, i) => ({ jobId: made[i]!.job.id, ...image })),
    failed: jobs
      .filter((job) => job.status === "failed" || job.status === "interrupted")
      .map((job) => ({
        jobId: job.id,
        reason: job.errorReason ?? (job.errorCode ? errorCopy(job.errorCode).reason : "It didn't finish."),
      })),
    waiting: jobs.filter((job) => ACTIVE.has(job.status)).length,
  };
  if (!finished) {
    summary.next =
      jobSet.speed === "batch"
        ? "This run is at the Batch speed, which can take hours. Call wait_for with this runId later."
        : "Still making. Call wait_for with this runId to get the images.";
  }
  return { summary, blocks };
}

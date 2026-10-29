import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import {
  ACTIVE_JOB_STATES,
  compositeSettingsOf,
  type EditOpParams,
  editOpParamsSchema,
  errorCopy,
  isTerminalState,
  type NormalizedRequest,
} from "@openfield/core";
import { type AssetRow, getJobSetBundle } from "@openfield/db";
import { describeImages, type ImageInfo } from "./images";
import { Refusal, type ToolContext } from "./kit";

// A run (a job set: one request, one to four images) as an agent reads it.

const ACTIVE = new Set<string>(ACTIVE_JOB_STATES);

/** An edit as an agent reads it: what it changes, and how much of the original stays. */
export interface EditSummary {
  /** The image changed. */
  image: string;
  /** The saved mask: the area to change. */
  mask?: string;
  /** The model can't take a mask, so it changes the whole image. */
  wholeImage?: true;
  /** The original is put back outside the mask afterwards. */
  composite?: boolean;
  expandPx?: number;
  featherPx?: number;
  note?: string;
}

export interface RunSummary {
  runId: string;
  status: string;
  finished: boolean;
  /** What the model was asked to do: "generate", or "edit" and "inpaint" for edits. */
  op: string;
  model: string;
  modelName: string;
  prompt: string;
  edit?: EditSummary;
  speed: string;
  estimateUsd: number | null;
  spentUsd: number | null;
  images: (ImageInfo & { jobId: string } & MaskOutcome)[];
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
  const modelName = ctx.svc.models.get(key)?.displayName ?? jobSet.modelId;
  const edit = editOf(jobSet.requestJson, modelName);
  const summary: RunSummary = {
    runId: jobSet.id,
    status: jobSet.status,
    finished,
    op: jobSet.requestJson.op,
    model: key,
    modelName,
    prompt: jobSet.prompt,
    ...(edit && { edit }),
    speed: jobSet.speed,
    estimateUsd: jobSet.costEstimateUsd,
    spentUsd: jobSet.costActualUsd,
    images: images.map((image, i) => ({ jobId: made[i]!.job.id, ...image, ...maskOutcome(made[i]!.asset) })),
    failed: jobs
      .filter((job) => job.status === "failed" || job.status === "interrupted")
      .map((job) => ({
        jobId: job.id,
        reason: job.errorReason ?? (job.errorCode ? errorCopy(job.errorCode).reason : "It didn't finish."),
      })),
    waiting: jobs.filter((job) => ACTIVE.has(job.status)).length,
  };
  // The note says what the run set out to do; an image the original couldn't be put back on says why.
  if (summary.edit?.composite && summary.images.some((image) => image.keptOutsideMask === false)) {
    summary.edit.note += " Some images kept the model's whole result: each says why.";
  }
  if (!finished) {
    summary.next =
      jobSet.speed === "batch"
        ? "This run is at the Batch speed, which can take hours. Call wait_for with this runId later."
        : "Still making. Call wait_for with this runId to get the images.";
  }
  return { summary, blocks };
}

/** An edit's image, mask and composite, from its frozen request. Undefined for anything else. */
export function editOf(call: NormalizedRequest, modelName: string): EditSummary | undefined {
  if (!call.base) return undefined;
  if (!call.mask) return { image: call.base.assetId };
  const settings = compositeSettingsOf(call.mask);
  // A mask on an edit, not an inpaint, means the model can't take one (normalize's fallback).
  const wholeImage = call.op === "edit";
  return {
    image: call.base.assetId,
    mask: call.mask.assetId,
    ...(wholeImage && { wholeImage: true as const }),
    ...settings,
    note: wholeImage
      ? settings.composite
        ? `${modelName} can't take a mask, so it edits the whole image. Openfield then puts back everything outside the mask, so only the masked area changes.`
        : `${modelName} can't take a mask, so it edits the whole image, and with composite off all of it may change.`
      : settings.composite
        ? "Only the masked area changes: Openfield puts back the original everywhere else."
        : "The model edits the masked area. With composite off its whole result is kept, so pixels outside the mask may change too.",
  };
}

export type MaskOutcome = { keptOutsideMask?: boolean; why?: string };

const NOT_KEPT: Record<NonNullable<EditOpParams["composite"]["reason"]>, string> = {
  off: "Composite was off, so this is the model's whole result.",
  unavailable: "Openfield can't open images on this computer, so this is the model's whole result.",
  turned: "The image is saved on its side, so this is the model's whole result.",
  failed: "Putting the original back failed, so this is the model's whole result.",
};

/**
 * Whether a masked edit's result has the original's own pixels outside the mask
 * (files/composite.ts). Nothing for any other image.
 */
export function maskOutcome(row: Pick<AssetRow, "opParams">): MaskOutcome {
  const parsed = editOpParamsSchema.safeParse(row.opParams?.edit);
  if (!parsed.success) return {};
  const { applied, reason } = parsed.data.composite;
  return applied ? { keptOutsideMask: true } : { keptOutsideMask: false, why: NOT_KEPT[reason ?? "failed"] };
}

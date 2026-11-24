import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import {
  ACTIVE_JOB_STATES,
  compositeSettingsOf,
  type EditOpParams,
  editOpParamsSchema,
  errorCopy,
  isStackLayer,
  isTerminalState,
  type NormalizedRequest,
  type SpeedId,
  t,
} from "@openfield/core";
import { type AssetRow, getJobSetBundle } from "@openfield/db";
import { speedLabel } from "@openfield/providers/manifest";
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
  /** The original is kept wherever the model didn't really change it, afterwards. */
  composite?: boolean;
  /** "smart" follows what the model changed; "mask" keeps exactly the mask. */
  keepRestMode?: "smart" | "mask";
  sensitivity?: number;
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

/** A speed as the person sees it for this model: "Fast" on BytePlus, never its "priority" id. */
export function speedNameFor(ctx: ToolContext, modelKey: string, speed: SpeedId): string {
  const model = ctx.svc.models.get(modelKey);
  const providerId = model?.providerId ?? modelKey.split(":")[0]!;
  return speedLabel(model, ctx.svc.providerSettings.forRun(providerId).schema, speed);
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
    const asset = assets.find((a) => a.jobId === job.id && !isStackLayer(a.opParams));
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
    speed: speedNameFor(ctx, key, jobSet.speed),
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

/**
 * An edit's image, mask and composite, from its frozen request. Undefined for anything else. The
 * note is also shown to the person when a run needs their approval, so it describes what happens
 * rather than naming settings.
 */
export function editOf(call: NormalizedRequest, modelName: string): EditSummary | undefined {
  if (!call.base) return undefined;
  if (!call.mask) return { image: call.base.assetId };
  const settings = compositeSettingsOf(call.mask);
  const mode = call.mask.mode ?? "smart";
  // Marks say where; their area is the mask only to keep the rest afterwards.
  const marks = !!call.marks?.some((m) => (m.image ?? 1) === 1);
  // A mask on an edit, not an inpaint, means the model can't take one (normalize's fallback).
  const wholeImage = call.op === "edit" && !marks;
  const area = marks ? "the area the marks cover" : "the mask";
  const kept =
    mode === "mask"
      ? `Openfield then puts back the original everywhere outside ${area}.`
      : `Openfield then keeps the original wherever the model didn't really change it, starting from ${area}.`;
  return {
    image: call.base.assetId,
    mask: call.mask.assetId,
    ...(wholeImage && { wholeImage: true as const }),
    ...settings,
    keepRestMode: mode,
    note: wholeImage
      ? settings.composite
        ? `${modelName} can't take a mask, so it edits the whole image. ${kept}`
        : `${modelName} can't take a mask, so it edits the whole image, and this time Openfield won't put the original back, so all of it may change.`
      : settings.composite
        ? marks
          ? `The model changes the image where the marks point. ${kept}`
          : `The model edits the masked area. ${kept}`
        : "The model edits the masked area, and this time Openfield won't put back the original outside it, so other parts may change too.",
  };
}

export type MaskOutcome = { keptOutsideMask?: boolean; why?: string };

const NOT_KEPT: Record<NonNullable<EditOpParams["composite"]["reason"]>, string> = {
  off: "Keep the rest was off, so this is the model's whole result.",
  unavailable: "Openfield can't open images on this computer, so this is the model's whole result.",
  turned: "The image is saved on its side, so this is the model's whole result.",
  failed: "Putting the original back failed, so this is the model's whole result.",
};

/**
 * Whether an edit's result kept the original's own pixels where the model didn't really change it
 * (files/composite.ts), and why not, or why only the mask decided. Nothing for any other image.
 */
export function maskOutcome(row: Pick<AssetRow, "opParams">): MaskOutcome {
  const parsed = editOpParamsSchema.safeParse(row.opParams?.edit);
  if (!parsed.success) return {};
  const { applied, reason } = parsed.data.composite;
  if (!applied) return { keptOutsideMask: false, why: NOT_KEPT[reason ?? "failed"] };
  const fellBack = parsed.data.keepRest?.fellBack;
  return fellBack
    ? { keptOutsideMask: true, why: t(`keepRest.maskOnly.${fellBack}`) }
    : { keptOutsideMask: true };
}

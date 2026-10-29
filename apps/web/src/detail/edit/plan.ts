import { modelsForEdit } from "@openfield/canvas/engine/inputs";
import {
  ASPECT_RATIOS,
  isEarly,
  isTerminalState,
  type JobSetWithJobs,
  MASK_MAX_PIXELS,
  type ModelKey,
  type ModelListItem,
  type ProviderSummary,
  t,
} from "@openfield/core";
import { aspectLabel, nearestRatio } from "@openfield/providers/manifest";

// The Edit tab's choices and what its runs came to, without React: which model an edit runs on,
// how the image's shape reads, and the panel's note once the new images are in.

/**
 * The model an edit runs on: the one picked, while it can still edit; else the default model when
 * it takes a mask; else the first ready model that takes one; else the first ready one that redraws
 * the whole image (design 3eiWurzdNj, only a Google key). A company that's early is never picked
 * for the person, as in the composer.
 */
export function pickEditModel(
  models: readonly ModelListItem[],
  picked: ModelKey | null,
  preferred: ModelKey | null | undefined,
  providers?: readonly Pick<ProviderSummary, "id" | "meta">[],
): ModelListItem | undefined {
  const { masked, whole } = modelsForEdit(models);
  const editing = [...masked, ...whole];
  const chosen = picked ? editing.find((m) => m.key === picked) : undefined;
  if (chosen) return chosen;
  const usable = (m: ModelListItem) => m.ready && !isEarly(providers, m.providerId);
  const fallback = masked.find((m) => m.key === preferred && m.ready);
  return fallback ?? masked.find(usable) ?? whole.find(usable);
}

/**
 * A model that can edit has its company's key. A key only for companies whose models can't edit
 * (Higgsfield, BytePlus) leaves nothing to pick, so the panel says to add a key.
 */
export function anyEditReady(models: readonly ModelListItem[]): boolean {
  const { masked, whole } = modelsForEdit(models);
  return [...masked, ...whole].some((m) => m.ready);
}

/**
 * Past the server's limit for a mask (masks.tooManyPixels): the Edit tab says so up front rather
 * than after the mask is painted, and never holds a mask that size.
 */
export const tooLargeToMask = (image: { width: number; height: number }) =>
  image.width * image.height > MASK_MAX_PIXELS;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Ratios read as themselves up to this term; past it a photo's shape reads as the nearest common one. */
const PLAIN_RATIO_MAX = 21;

/** The image's shape as people say it: "3:4" for 1152 × 1536. */
export function aspectText(width: number, height: number): string {
  const d = gcd(width, height);
  const w = width / d;
  const h = height / d;
  if (w <= PLAIN_RATIO_MAX && h <= PLAIN_RATIO_MAX) return `${w}:${h}`;
  const near = nearestRatio(width, height, ASPECT_RATIOS);
  return near ? aspectLabel(near) : `${w}:${h}`;
}

export type SlotState = "working" | "done" | "failed";

/** One image a run makes, as the results strip shows it. */
export interface ResultSlot {
  jobId: string;
  state: SlotState;
  assetId: string | null;
}

/** The run's images in batch order. A canceled one counts as one that didn't work. */
export function resultSlots(run: JobSetWithJobs | undefined): ResultSlot[] {
  if (!run) return [];
  return [...run.jobs]
    .sort((a, b) => a.idx - b.idx)
    .map((job) => ({
      jobId: job.id,
      state:
        job.status === "succeeded" && job.assetId
          ? "done"
          : job.status === "failed" || job.status === "canceled" || job.status === "interrupted"
            ? "failed"
            : "working",
      assetId: job.assetId,
    }));
}

export type RunOutcome =
  /** Nothing has run yet, or the run was let go. */
  | { kind: "none" }
  | { kind: "working"; count: number }
  /** It ended with at least one new image. */
  | { kind: "saved"; saved: number; failed: number }
  /** It ended with none: the mask is still there to try again with. */
  | { kind: "failed" }
  /** Stopped before any image came back. */
  | { kind: "stopped" };

export function runOutcome(run: JobSetWithJobs | undefined): RunOutcome {
  if (!run) return { kind: "none" };
  const slots = resultSlots(run);
  if (!isTerminalState(run.jobSet.status) && slots.some((s) => s.state === "working"))
    return { kind: "working", count: slots.length };
  const saved = slots.filter((s) => s.state === "done").length;
  const failed = slots.length - saved;
  if (saved > 0) return { kind: "saved", saved, failed };
  return run.jobSet.status === "canceled" || run.jobs.every((j) => j.status === "canceled")
    ? { kind: "stopped" }
    : { kind: "failed" };
}

/**
 * The new image the media area compares with the original (design iz4IfLpdHl), or null while it
 * paints: once a run has saved images and one of them is picked. Picking the original, or Edit the
 * mask, goes back to painting.
 */
export function comparedResult(outcome: RunOutcome, shown: string | null | undefined): string | null {
  return outcome.kind === "saved" && typeof shown === "string" ? shown : null;
}

export interface SavedNote {
  /** The check, or the alert in the danger colour when something didn't go as asked. */
  tone: "done" | "warning";
  text: string;
}

/**
 * Image edit / Saved note: what became of the run. `notKept` says the rest of the image was asked to
 * stay as it was but couldn't be put back exactly on some result.
 */
export function savedNote(outcome: RunOutcome, notKept = false): SavedNote | null {
  if (outcome.kind !== "saved") return null;
  if (outcome.failed > 0)
    return {
      tone: "warning",
      text: t("edit.saved.someFailed", { saved: outcome.saved, failed: outcome.failed }),
    };
  if (notKept) return { tone: "warning", text: t("edit.saved.notKept", { count: outcome.saved }) };
  return { tone: "done", text: t("edit.saved.done", { count: outcome.saved }) };
}

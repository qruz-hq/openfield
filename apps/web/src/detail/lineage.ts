import {
  type Asset,
  type AssetDetailResponse,
  type CompositeSettings,
  compositeSettingsOf,
  editOpParamsSchema,
  MASK_COMPOSITE_DEFAULTS,
  type Mark,
  type ModelKey,
  marksSchema,
  maskInputSchema,
  t,
} from "@openfield/core";
import type { ComposerValues } from "@openfield/providers/manifest";
import { frozenSettings } from "./format";

// Where an edited image came from (§0.9, design Detail / Section / Edited from): the original, the
// mask it was painted with and what happened outside it, the references and the words, and what
// opening that edit again puts back (design Q6PqHq5KHS). Pure, so it's unit tested.

export interface EditedFrom {
  /** The image it was edited from, or null once that's left the library. */
  original: Asset | null;
  /** The mask painted over the original. Null for an edit made without one. */
  mask: Asset | null;
  /** The Mask row's second line. */
  maskNote: string | null;
  references: readonly Asset[];
}

/** An image made by editing another, with what its Info tab shows about that. Null for any other. */
export function editedFrom(detail: AssetDetailResponse, modelName: string | undefined): EditedFrom | null {
  const { asset } = detail;
  if ((asset.op !== "edit" && asset.op !== "inpaint") || !asset.parentAssetId) return null;
  // The first ancestor is the live parent; a parent in the Trash isn't one.
  const parent = detail.lineage.ancestors[0];
  return {
    original: parent?.id === asset.parentAssetId ? parent : null,
    mask: detail.mask,
    maskNote: detail.mask ? maskNote(asset, modelName) : null,
    references: detail.references,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The result's own record of the composite (opParams.edit), when it has one. */
const editRecord = (asset: Pick<Asset, "opParams">) =>
  editOpParamsSchema.safeParse(isRecord(asset.opParams) ? asset.opParams.edit : undefined).data;

/**
 * What the edit asked for outside the mask: the request's own settings, else what the result
 * records, else the defaults.
 */
export function askedComposite(asset: Pick<Asset, "opParams" | "params">): CompositeSettings {
  const mask = maskInputSchema.safeParse(asset.params?.mask).data;
  if (mask) return compositeSettingsOf(mask);
  const record = editRecord(asset);
  const composite = record?.composite;
  return composite
    ? {
        composite: composite.reason !== "off",
        expandPx: composite.expandPx,
        featherPx: composite.featherPx,
        sensitivity: record.keepRest?.sensitivity ?? MASK_COMPOSITE_DEFAULTS.sensitivity,
      }
    : compositeSettingsOf();
}

/**
 * What became of the rest of the image: the composite's settings when the original was put back,
 * or why it wasn't. A model that can't take a mask redrew the whole image (the record's fallback,
 * and the image's approximate_reason), which is worth saying even when the rest was put back.
 */
export function maskNote(
  asset: Pick<Asset, "opParams" | "params"> & Partial<Pick<Asset, "approximateReason">>,
  modelName: string | undefined,
): string {
  const edit = editRecord(asset);
  if (!edit) {
    // Made before the result recorded it: what the request asked for is all there is to go on.
    const asked = askedComposite(asset);
    return asked.composite
      ? t("assets.detail.editedFrom.settings", { feather: asked.featherPx, expand: asked.expandPx })
      : t("assets.detail.editedFrom.notKept");
  }
  const { composite, fallback } = edit;
  if (!composite.applied)
    return t(
      composite.reason === "off"
        ? "assets.detail.editedFrom.notKept"
        : "assets.detail.editedFrom.notKeptExactly",
    );
  if ((fallback === "whole_image" || asset.approximateReason === "whole_image") && modelName)
    return t("assets.detail.editedFrom.wholeImage", { model: modelName });
  return t("assets.detail.editedFrom.settings", { feather: composite.featherPx, expand: composite.expandPx });
}

/** Everything "Edit the original with this mask" (or "with these marks") puts back on the Edit tab. */
export interface Reopened {
  original: Asset;
  /** The painted mask, or the marks' area when Sketch & point kept the rest. */
  mask: Asset | null;
  /** Sketch & point's marks, when it was made from them: it opens on them, not on a mask. */
  marks: Mark[] | null;
  /** Keep the rest in Sketch & point: on when the marks' area was saved as the mask. */
  sketchComposite: boolean;
  /** The run that made the image, to fill the results strip again. */
  runId: string | null;
  prompt: string;
  /** Undefined when the request doesn't say: the Edit tab picks as it would. */
  model: ModelKey | undefined;
  /** Resolution and quality. The aspect follows the original anyway. */
  values: ComposerValues;
  batch: number;
  composite: CompositeSettings;
  references: string[];
}

/** What the edit that made this image asked for, to ask again on its original. */
export function reopenedEdit(detail: AssetDetailResponse, from: EditedFrom, prompt: string): Reopened | null {
  const params = detail.asset.params ?? detail.params;
  // The Edit tab marks the image being edited only: an agent's marks on a reference stay its own.
  const parsed = marksSchema.safeParse(params?.marks).data;
  const marks = parsed?.every((mark) => (mark.image ?? 1) === 1) ? parsed : null;
  if (!from.original || (!from.mask && !marks)) return null;
  const frozen = frozenSettings(params);
  return {
    original: from.original,
    mask: from.mask,
    marks,
    sketchComposite: marks !== null && from.mask !== null,
    runId: detail.asset.jobSetId ?? detail.jobSet?.id ?? null,
    prompt,
    model: frozen.model,
    values: {
      ...(frozen.resolution && { resolution: frozen.resolution }),
      ...(frozen.quality && { quality: frozen.quality }),
    },
    batch: detail.jobSet?.batchSize ?? 1,
    composite: askedComposite(detail.asset),
    references: from.references.map((r) => r.id),
  };
}

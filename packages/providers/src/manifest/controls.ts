import {
  type AdapterOp,
  type AspectRatio,
  adapterOpFor,
  BATCH_MAX,
  type Capabilities,
  type CostEstimate,
  type EditBody,
  type GenerateBody,
  type MaskInput,
  type ModelListItem,
  type PixelSize,
  RESOLUTION_TIER_PX,
  type ReferenceInput,
  type ResolutionTier,
  type SizeSpec,
  type SpeedId,
  t,
} from "@openfield/core";
import { type AskPrice, asksForPrice, isPricePending, type PriceAsk } from "./asked-price";
import { estimate } from "./estimate";
import { editSizeFor, nearestRatio, placeholderSize } from "./size";

// Pure composer logic: which value each chip shows, what a model switch keeps, what a run
// costs and sends. No React here, so it's all unit tested. Settings shares it for prices and labels.

/** What the person picked in the composer. Unset values mean "the model's own default". */
export interface ComposerValues {
  aspect?: AspectRatio;
  resolution?: ResolutionTier;
  quality?: string;
}

export interface Resolved {
  aspect?: AspectRatio;
  resolution?: ResolutionTier;
  quality?: string;
  batch: number;
}

/** The value each chip shows: the person's choice when the model offers it, else the model's default. */
export function resolveValues(
  caps: Capabilities,
  values: ComposerValues,
  batch: number,
  defaultAspect?: AspectRatio | null,
): Resolved {
  const out: Resolved = { batch: clampBatch(caps, batch) };
  if (caps.size.mode === "aspect") {
    const ratios = caps.size.ratios;
    const unavailable = caps.partial?.aspect?.unavailable ?? [];
    const usable = (r: AspectRatio | null | undefined): r is AspectRatio =>
      !!r && ratios.includes(r) && !unavailable.includes(r);
    out.aspect = usable(values.aspect)
      ? values.aspect
      : usable(defaultAspect)
        ? defaultAspect
        : caps.size.default;
  }
  if (caps.resolution) {
    out.resolution =
      values.resolution && caps.resolution.tiers.includes(values.resolution)
        ? values.resolution
        : caps.resolution.default;
  }
  if (caps.quality) {
    const ids = caps.quality.levels.map((l) => l.id);
    out.quality = values.quality && ids.includes(values.quality) ? values.quality : caps.quality.default;
  }
  return out;
}

export const clampBatch = (caps: Capabilities, batch: number) =>
  Math.max(1, Math.min(caps.batch.max, BATCH_MAX, Math.round(batch) || 1));

export interface Adjustment {
  from: string;
  to: string;
}

/**
 * Carry, then clamp, then drop (§3.5.1). Only values the person set explicitly move across;
 * unset ones keep following the new model's default. Resolution and quality clamp down, never up,
 * so a switch can't quietly cost more.
 */
export function carryValues(
  to: Capabilities,
  values: ComposerValues,
  batch: number,
  labels: { quality: (caps: Capabilities, id: string) => string },
  from?: Capabilities,
): { values: ComposerValues; batch: number; adjusted: Adjustment[] } {
  const next: ComposerValues = {};
  const adjusted: Adjustment[] = [];

  if (values.aspect && to.size.mode === "aspect") {
    const ratios = to.size.ratios;
    if (ratios.includes(values.aspect)) next.aspect = values.aspect;
    else {
      const [w, h] = values.aspect === "auto" ? [1, 1] : values.aspect.split(":").map(Number);
      const clamped = values.aspect === "auto" ? undefined : nearestRatio(w!, h!, ratios);
      if (clamped) {
        next.aspect = clamped;
        adjusted.push({ from: aspectLabel(values.aspect), to: aspectLabel(clamped) });
      }
    }
  }

  if (values.resolution && to.resolution) {
    const tiers = to.resolution.tiers;
    if (tiers.includes(values.resolution)) next.resolution = values.resolution;
    else {
      const px = RESOLUTION_TIER_PX[values.resolution];
      const below = tiers.filter((tier) => RESOLUTION_TIER_PX[tier] <= px);
      const clamped = below.length ? below[below.length - 1]! : tiers[0]!;
      next.resolution = clamped;
      adjusted.push({ from: values.resolution, to: clamped });
    }
  }

  if (values.quality && to.quality) {
    const ids = to.quality.levels.map((l) => l.id);
    if (ids.includes(values.quality)) next.quality = values.quality;
    else if (from?.quality) {
      // Same relative position in the new list, rounded down.
      const oldIds = from.quality.levels.map((l) => l.id);
      const at = oldIds.indexOf(values.quality);
      if (at >= 0) {
        const share = oldIds.length > 1 ? at / (oldIds.length - 1) : 0;
        const clamped = ids[Math.floor(share * (ids.length - 1))]!;
        next.quality = clamped;
        adjusted.push({ from: labels.quality(from, values.quality), to: labels.quality(to, clamped) });
      }
    }
  }

  const nextBatch = clampBatch(to, batch);
  if (nextBatch !== batch) adjusted.push({ from: String(batch), to: String(nextBatch) });
  return { values: next, batch: nextBatch, adjusted };
}

export const aspectLabel = (ratio: AspectRatio) =>
  ratio === "auto" ? t("composer.chips.aspect.auto") : ratio;

export const qualityLabel = (caps: Capabilities, id: string) =>
  caps.quality?.levels.find((l) => l.id === id)?.label ?? id;

function sizeSpec(caps: Capabilities, resolved: Resolved): SizeSpec {
  switch (caps.size.mode) {
    case "aspect":
      return !resolved.aspect || resolved.aspect === "auto"
        ? { kind: "auto" }
        : { kind: "aspect", ratio: resolved.aspect };
    case "enum":
      return caps.size.allowAuto
        ? { kind: "auto" }
        : { kind: "pixels", width: caps.size.default.width, height: caps.size.default.height };
    case "free":
      return { kind: "pixels", width: caps.size.default.width, height: caps.size.default.height };
  }
}

/** About how big each image comes out, so placeholders reserve the right shape. */
export function expectedSize(caps: Capabilities, resolved: Resolved): PixelSize {
  const spec = sizeSpec(caps, resolved);
  if (spec.kind === "pixels") return { width: spec.width, height: spec.height };
  if (caps.size.mode === "enum") return caps.size.default;
  // "auto" has no shape yet; a square is the honest guess.
  const aspect = spec.kind === "aspect" ? spec.ratio : "1:1";
  return placeholderSize(caps, { aspect }, resolved.resolution);
}

/** The image an edit changes, at the size it's stored. */
export interface EditBase {
  assetId: string;
  width: number;
  height: number;
}

/** What an edit's price and size depend on, before its mask is saved. */
export interface EditPlan {
  base: EditBase;
  /** A mask goes with it, so the model changes only that area where it can. */
  masked: boolean;
}

/** What else a run sends that its company's price can depend on (Z-Image's prompt rewriting, say). */
export type PriceExtras = Pick<PriceAsk, "enhancePrompt" | "providerOptions" | "negativePrompt"> & {
  /** Images the run sends in besides an edit's base, which `edit` counts: its references. */
  inputImages?: number;
  /**
   * The references' pixel sizes, in order. Once there's one for each, an edit prices them at their
   * own sizes, as the run does; until then, as any size could be.
   */
  referenceSizes?: readonly PixelSize[];
  /** Set for an edit: priced at the size it asks for, with its base read at the base's own size. */
  edit?: EditPlan;
};

/**
 * What an edit runs as on a model (§0.4): an inpaint where the model takes a mask and there is one,
 * else a whole-image edit. Its company's speed is resolved for this op, as normalize() does.
 */
export const editOpFor = (caps: Capabilities, masked: boolean): AdapterOp =>
  adapterOpFor("edit", { hasMask: masked, canInpaint: caps.ops.inpaint }) ?? "edit";

/**
 * The size and tier an edit asks for: its base's shape at the tier picked, which until the person
 * picks one is the model's default, as the chip shows (§0.9).
 */
const editSize = (model: Pick<ModelListItem, "capabilities">, resolved: Resolved, base: EditBase) =>
  editSizeFor(model, base, resolved.resolution);

/**
 * `speed` is what the company's settings resolve to; a speed the model lacks prices as Standard.
 * `askPrice` prices a model its company prices per request; without one, such a model is priced
 * from its manifest like any other.
 */
export function estimateRun(
  model: ModelListItem,
  resolved: Resolved,
  prompt: string,
  speed: SpeedId = "standard",
  extras: PriceExtras = {},
  askPrice?: AskPrice,
): CostEstimate {
  const { edit } = extras;
  // A model that takes a ratio is priced by that ratio, as the server prices the finished run. An
  // edit is priced at the size it asks for, which follows its base.
  const fit = edit && editSize(model, resolved, edit.base);
  const spec = fit ? fit.size : sizeSpec(model.capabilities, resolved);
  const resolution = fit ? fit.resolution : resolved.resolution;
  const op = edit ? (edit.masked ? "inpaint" : "edit") : "generate";
  const base = edit && { assetId: edit.base.assetId, role: "base" as const };
  // Its company prices each request (Higgsfield): asked of it, once there's a key to ask with.
  if (askPrice && asksForPrice(model) && model.ready) {
    return askPrice(model, {
      op,
      batch: resolved.batch,
      size: spec,
      ...(model.capabilities.resolution && resolution && { resolution }),
      ...(model.capabilities.quality && resolved.quality && { quality: resolved.quality }),
      // The server reads the base's size from the library, as it will for the run.
      ...(base && { base }),
      ...(extras.enhancePrompt !== undefined && { enhancePrompt: extras.enhancePrompt }),
      ...(extras.providerOptions &&
        Object.keys(extras.providerOptions).length && {
          providerOptions: extras.providerOptions,
        }),
      ...(extras.negativePrompt?.trim() && { negativePrompt: extras.negativePrompt }),
    });
  }
  const size =
    spec.kind === "pixels"
      ? { width: spec.width, height: spec.height }
      : model.capabilities.size.mode === "aspect"
        ? { aspect: spec.kind === "aspect" ? spec.ratio : ("auto" as const) }
        : expectedSize(model.capabilities, resolved);
  const inputImages = (extras.inputImages ?? 0) + (edit ? 1 : 0);
  const referenceSizes =
    extras.referenceSizes?.length === (extras.inputImages ?? 0) ? extras.referenceSizes : [];
  return estimate(model, {
    op,
    batch: resolved.batch,
    resolution,
    quality: resolved.quality,
    size,
    prompt,
    speed,
    ...(inputImages && { inputImages }),
    // The base goes first, and its size is known. The references after it are priced at theirs once
    // all of them are known, else as any size could be.
    ...(edit &&
      base && {
        base,
        inputImageSizes: [{ width: edit.base.width, height: edit.base.height }, ...referenceSizes],
      }),
  });
}

/**
 * The composer's queued references (a feed tile's Use as reference) as a run sends them: capped to
 * what the model takes, in $subject when it offers that role, else its first one. A model that
 * doesn't take references at all gets none, rather than a request it would only reject.
 */
export function referenceInputsFor(caps: Capabilities, assetIds: readonly string[]): ReferenceInput[] {
  if (!caps.references.supported || !assetIds.length) return [];
  const role = caps.references.roles.includes("subject") ? "subject" : caps.references.roles[0];
  if (!role) return [];
  return assetIds.slice(0, caps.references.max).map((assetId) => ({ assetId, role }));
}

export function generateBody(
  model: ModelListItem,
  resolved: Resolved,
  prompt: string,
  idempotencyKey: string,
  references: readonly ReferenceInput[] = [],
): GenerateBody {
  const caps = model.capabilities;
  return {
    idempotencyKey,
    model: model.key,
    op: "generate",
    prompt: prompt.trim(),
    size: sizeSpec(caps, resolved),
    ...(caps.resolution && resolved.resolution ? { resolution: resolved.resolution } : {}),
    ...(caps.quality && resolved.quality ? { quality: resolved.quality } : {}),
    batch: resolved.batch,
    // Seeds are the server's to pick (§0.11).
    seed: null,
    source: "composer",
    ...(references.length ? { references: [...references] } : {}),
  };
}

/** What an edit sends besides its settings. The mask is a saved one (POST /api/masks). */
export interface EditInputs {
  base: EditBase;
  mask?: MaskInput;
  references?: readonly ReferenceInput[];
}

/**
 * POST /api/edit's body for the detail view's Edit tab. The size is the base's shape at the tier
 * picked, the one the price was worked out for, so the aspect stays locked to the base. A masked
 * edit is an inpaint, which a model without a mask input runs over the whole image (§0.9).
 */
export function editBody(
  model: ModelListItem,
  resolved: Resolved,
  prompt: string,
  idempotencyKey: string,
  inputs: EditInputs,
): EditBody {
  const caps = model.capabilities;
  const fit = editSize(model, resolved, inputs.base);
  return {
    idempotencyKey,
    model: model.key,
    op: inputs.mask ? "inpaint" : "edit",
    prompt: prompt.trim(),
    size: fit.size,
    ...(caps.resolution && fit.resolution ? { resolution: fit.resolution } : {}),
    ...(caps.quality && resolved.quality ? { quality: resolved.quality } : {}),
    batch: resolved.batch,
    seed: null,
    source: "detail_editor",
    base: { assetId: inputs.base.assetId, role: "base" },
    ...(inputs.mask ? { mask: { ...inputs.mask } } : {}),
    ...(inputs.references?.length ? { references: [...inputs.references] } : {}),
  };
}

/**
 * About how big each edited image comes out, for placeholders: the base's own size when a masked
 * edit keeps the rest of the image, since the result is laid back over it. Otherwise the size the
 * model is asked for.
 */
export function editedSize(
  model: Pick<ModelListItem, "capabilities">,
  resolved: Resolved,
  edit: EditPlan & { composite: boolean },
): PixelSize {
  if (edit.masked && edit.composite) return { width: edit.base.width, height: edit.base.height };
  const fit = editSize(model, resolved, edit.base);
  if (fit.size.kind === "pixels") return { width: fit.size.width, height: fit.size.height };
  const aspect = fit.size.kind === "aspect" ? fit.size.ratio : "1:1";
  return placeholderSize(model.capabilities, { aspect }, fit.resolution);
}

/** Whether a model can edit an image at all: with a mask, or over the whole image. */
export const editsImages = (caps: Capabilities): boolean => caps.ops.inpaint || caps.ops.imageEdit;

export type GenerateState =
  /** No key anywhere and no model picked: first run. */
  | { kind: "no-key" }
  /** The picked model's company has no key. */
  | { kind: "needs-key"; model: ModelListItem }
  /** Can't send yet; the reason is the tooltip. */
  | { kind: "blocked"; reason: string; estimate?: CostEstimate }
  /** No estimate while its company's price is on its way: the button shows no price yet. */
  | { kind: "ready"; estimate?: CostEstimate | undefined };

export function generateState(input: {
  model: ModelListItem | undefined;
  anyReady: boolean;
  prompt: string;
  resolved: Resolved | undefined;
  speed?: SpeedId;
  askPrice?: AskPrice;
}): GenerateState {
  const { model, anyReady, prompt, resolved, speed, askPrice } = input;
  if (!model)
    return anyReady ? { kind: "blocked", reason: t("composer.generate.noModel") } : { kind: "no-key" };
  if (!model.ready) return { kind: "needs-key", model };
  const asked = resolved ? estimateRun(model, resolved, prompt, speed, {}, askPrice) : undefined;
  // A price still being asked shows as none yet, never as "Cost unknown".
  const cost = isPricePending(asked) ? undefined : asked;
  if (!prompt.trim()) return { kind: "blocked", reason: t("composer.generate.emptyPrompt"), estimate: cost };
  return { kind: "ready", estimate: cost };
}

/**
 * The Edit tab's Generate button. Like generateState, but a model that can't edit counts as none
 * picked, and an edit needs a painted area before it needs words (design f90S4YuAoH, GBehrlQZ5o).
 */
export function editState(input: {
  model: ModelListItem | undefined;
  anyReady: boolean;
  prompt: string;
  resolved: Resolved | undefined;
  edit: EditPlan;
  /** Reference images sent besides the base. */
  references?: number;
  /** Their pixel sizes, in order, as far as they're known. */
  referenceSizes?: readonly PixelSize[];
  speed?: SpeedId;
  askPrice?: AskPrice;
}): GenerateState {
  const { anyReady, prompt, resolved, edit, references, referenceSizes, speed, askPrice } = input;
  const model = input.model && editsImages(input.model.capabilities) ? input.model : undefined;
  if (!model)
    return anyReady ? { kind: "blocked", reason: t("composer.generate.noModel") } : { kind: "no-key" };
  if (!model.ready) return { kind: "needs-key", model };
  const extras: PriceExtras = {
    edit,
    ...(references && { inputImages: references }),
    ...(referenceSizes && { referenceSizes }),
  };
  const asked = resolved ? estimateRun(model, resolved, prompt, speed, extras, askPrice) : undefined;
  const cost = isPricePending(asked) ? undefined : asked;
  if (!edit.masked) return { kind: "blocked", reason: t("edit.generate.paintFirst"), estimate: cost };
  if (!prompt.trim()) return { kind: "blocked", reason: t("edit.generate.describeFirst"), estimate: cost };
  return { kind: "ready", estimate: cost };
}

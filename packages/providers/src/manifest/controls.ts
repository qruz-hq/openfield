import {
  type AspectRatio,
  BATCH_MAX,
  type Capabilities,
  type CostEstimate,
  type GenerateBody,
  type ModelListItem,
  type PixelSize,
  RESOLUTION_TIER_PX,
  type ResolutionTier,
  type SizeSpec,
  type SpeedId,
  t,
} from "@openfield/core";
import { type AskPrice, asksForPrice, isPricePending, type PriceAsk } from "./asked-price";
import { estimate } from "./estimate";
import { nearestRatio, placeholderSize } from "./size";

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

/** What else a run sends that its company's price can depend on (Z-Image's prompt rewriting, say). */
export type PriceExtras = Pick<PriceAsk, "enhancePrompt" | "providerOptions" | "negativePrompt"> & {
  /** Images the run sends in: references, and an edit's base. */
  inputImages?: number;
};

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
  // A model that takes a ratio is priced by that ratio, as the server prices the finished run.
  const spec = sizeSpec(model.capabilities, resolved);
  // Its company prices each request (Higgsfield): asked of it, once there's a key to ask with.
  if (askPrice && asksForPrice(model) && model.ready) {
    return askPrice(model, {
      op: "generate",
      batch: resolved.batch,
      size: spec,
      ...(model.capabilities.resolution && resolved.resolution && { resolution: resolved.resolution }),
      ...(model.capabilities.quality && resolved.quality && { quality: resolved.quality }),
      ...(extras.enhancePrompt !== undefined && { enhancePrompt: extras.enhancePrompt }),
      ...(extras.providerOptions &&
        Object.keys(extras.providerOptions).length && {
          providerOptions: extras.providerOptions,
        }),
      ...(extras.negativePrompt?.trim() && { negativePrompt: extras.negativePrompt }),
    });
  }
  const size =
    model.capabilities.size.mode === "aspect" && spec.kind !== "pixels"
      ? { aspect: spec.kind === "aspect" ? spec.ratio : ("auto" as const) }
      : expectedSize(model.capabilities, resolved);
  return estimate(model, {
    batch: resolved.batch,
    resolution: resolved.resolution,
    quality: resolved.quality,
    size,
    prompt,
    speed,
    ...(extras.inputImages && { inputImages: extras.inputImages }),
  });
}

export function generateBody(
  model: ModelListItem,
  resolved: Resolved,
  prompt: string,
  idempotencyKey: string,
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
  };
}

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

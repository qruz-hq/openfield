import {
  type CostEstimate,
  DEFAULT_CURRENCY,
  formatMoney,
  type InputImageTokens,
  type ModelManifest,
  type NormalizedRequest,
  type PerImagePrice,
  type PriceModel,
  type SpeedId,
  t,
} from "@openfield/core";
import { pricedOp, priceFor, resolveSpeed } from "./speed";
import { resolveVideo, videoRate, videoSize, videoSizes, videoTokens } from "./video";

// §0.13: pure. Reads the manifest's prices and the request, never credentials, the network or the
// clock, so the composer can re-run it on every chip change.

/**
 * The fields a price depends on. A full NormalizedRequest fits, and so does the composer's state.
 * `speed` is what the company's settings resolve to; a speed the model lacks prices as Standard.
 * `inputImages` counts the images sent in (references and an edit's base) where the request itself
 * doesn't carry them, as on a canvas before upstream images exist. `inputImageSizes` are the pixel
 * sizes of those known so far, in order; the rest are priced as any size could be.
 */
export type EstimateRequest = Pick<NormalizedRequest, "batch"> &
  Partial<
    Pick<
      NormalizedRequest,
      | "resolution"
      | "quality"
      | "size"
      | "prompt"
      | "promptAfterPreset"
      | "op"
      | "references"
      | "base"
      | "video"
    >
  > & {
    speed?: SpeedId;
    inputImages?: number;
    inputImageSizes?: readonly { width: number; height: number }[];
  };

/** Images the request sends in: its references and its edit base, unless counted for it. */
export const inputImagesOf = (req: EstimateRequest): number =>
  Math.max(
    req.inputImages ?? (req.references?.length ?? 0) + (req.base ? 1 : 0),
    req.inputImageSizes?.length ?? 0,
  );

/**
 * The input tokens one image sent in is counted at: a fixed number, or its patches, worked out from
 * its size. Without a size, the range any size could come to.
 */
export function inputImageTokens(
  rule: InputImageTokens,
  size?: { width: number; height: number },
): { min: number; max: number } {
  if (rule.kind === "fixed") return { min: rule.tokens, max: rule.tokens };
  if (!size) return rule.unknown;
  const n = patchesOf(rule, size.width, size.height);
  return { min: n, max: n };
}

type PatchRule = Extract<InputImageTokens, { kind: "patches" }>;

function patchesOf(rule: PatchRule, width: number, height: number): number {
  // Whole patches along a side; the tolerance keeps a side that shrank to exactly N patches at N.
  const along = (px: number) => Math.ceil(px / rule.patch - 1e-9);
  // A small image is scaled up first, at most maxScale times.
  const scale = Math.min(rule.maxScale, Math.max(1, rule.scaleTo / Math.max(width, height)));
  let w = Math.floor(width * scale);
  let h = Math.floor(height * scale);
  // One wider or taller than maxRatio is padded out to it.
  if (w > h * rule.maxRatio) h = w / rule.maxRatio;
  else if (h > w * rule.maxRatio) w = h / rule.maxRatio;
  const patches = along(w) * along(h);
  if (patches <= rule.maxPatches) return patches;
  // Too many: shrunk to fit, then a little more so both sides end on whole patches.
  let r = Math.sqrt((rule.patch * rule.patch * rule.maxPatches) / (w * h));
  r *= Math.min(
    Math.floor((w * r) / rule.patch) / ((w * r) / rule.patch),
    Math.floor((h * r) / rule.patch) / ((h * r) / rule.patch),
  );
  return Math.min(rule.maxPatches, along(w * r) * along(h * r));
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function unknownCost(pricedAt = ""): CostEstimate {
  return {
    currency: DEFAULT_CURRENCY,
    min: 0,
    max: 0,
    confidence: "unknown",
    basis: t("cost.unknown"),
    pricedAt,
  };
}

export function estimate(manifest: ModelManifest, req: EstimateRequest): CostEstimate {
  const { speed } = resolveSpeed(manifest, req.speed ?? "standard", pricedOp(req.op));
  const price = priceFor(manifest, speed);
  const count = Math.max(1, req.batch);
  // The basis names the speed whenever it isn't Standard: "2 × $0.067 (1K, Batch)".
  const speedLabel = speed === "standard" ? undefined : t(`speed.names.${speed}`);
  switch (price.kind) {
    case "per_image":
      return withInputs(manifest, price, req, count, perImage(manifest, price, req, count, speedLabel));
    case "per_token": {
      const output = perToken(manifest, price, req, count, speedLabel);
      return output.confidence === "unknown" ? output : withInputs(manifest, price, req, count, output);
    }
    case "video_tokens":
      return perVideo(manifest, price, req, count, speedLabel);
    case "per_second":
    case "provider_estimate":
      // Nothing uses per_second yet, and a remote estimate needs estimateRemote().
      return unknownCost(price.pricedAt);
    case "unknown":
      return unknownCost();
  }
}

type PerImagePriceModel = Extract<PriceModel, { kind: "per_image" }>;
type PerTokenPriceModel = Extract<PriceModel, { kind: "per_token" }>;

/**
 * What the images sent in add to one call, as a range, or null when there are none or the price
 * doesn't say what they cost.
 */
function inputImageUsd(
  price: PerImagePriceModel | PerTokenPriceModel,
  req: EstimateRequest,
): { count: number; min: number; max: number } | null {
  const count = inputImagesOf(req);
  if (!count) return null;
  const rate =
    price.kind === "per_image"
      ? price.inputImage
      : price.imageInputTokens && { tokens: price.imageInputTokens, perMTok: price.imageInputPerMTok };
  if (!rate) return null;
  let min = 0;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const tokens = inputImageTokens(rate.tokens, req.inputImageSizes?.[i]);
    min += tokens.min;
    max += tokens.max;
  }
  return { count, min: (min * rate.perMTok) / 1e6, max: (max * rate.perMTok) / 1e6 };
}

/**
 * Adds the images sent in to an estimate: their cost, and "+ 4 reference images ($0.002)" in the
 * basis. They're billed per call: a model that makes a batch in one call reads them once, one that
 * doesn't reads them again for every image.
 */
function withInputs(
  manifest: ModelManifest,
  price: PerImagePriceModel | PerTokenPriceModel,
  req: EstimateRequest,
  count: number,
  cost: CostEstimate,
): CostEstimate {
  const inputs = inputImageUsd(price, req);
  if (!inputs) return cost;
  const calls = manifest.capabilities.batch.native ? 1 : count;
  const low = inputs.min * calls;
  const high = inputs.max * calls;
  return {
    ...cost,
    min: round(cost.min + low),
    max: round(cost.max + high),
    // Counted tokens are the company's rule for the image, not a bill: never exact.
    confidence: cost.confidence === "exact" ? "estimated" : cost.confidence,
    basis: t("cost.withInputs", {
      basis: cost.basis,
      count: inputs.count,
      cost: moneyRange(low, high, price.currency),
    }),
  };
}

function perImage(
  manifest: ModelManifest,
  price: PerImagePriceModel,
  req: EstimateRequest,
  count: number,
  speedLabel: string | undefined,
): CostEstimate {
  const caps = manifest.capabilities;
  const tier = req.resolution ?? caps.resolution?.default;
  const quality = req.quality ?? caps.quality?.default;

  const specificity = (p: PerImagePrice) => (p.tier ? 1 : 0) + (p.quality ? 1 : 0);
  const hit = price.tiers
    .filter((p) => (!p.tier || p.tier === tier) && (!p.quality || p.quality === quality))
    .sort((a, b) => specificity(b) - specificity(a))[0];

  if (hit) {
    const label = [hit.quality && qualityLabel(manifest, hit.quality), hit.tier, speedLabel]
      .filter(Boolean)
      .join(", ");
    return {
      currency: price.currency,
      min: round(hit.usd * count),
      max: round(hit.usd * count),
      confidence: "exact",
      basis: label
        ? t("cost.basisWith", { count, each: formatMoney(hit.usd, price.currency, true), detail: label })
        : t("cost.basis", { count, each: formatMoney(hit.usd, price.currency, true) }),
      pricedAt: price.pricedAt,
    };
  }

  // No row for this combination: show the whole range rather than guess one row.
  const amounts = price.tiers.map((p) => p.usd);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  return {
    currency: price.currency,
    min: round(low * count),
    max: round(high * count),
    confidence: "estimated",
    basis: basis(count, moneyRange(low, high, price.currency), speedLabel),
    pricedAt: price.pricedAt,
  };
}

function perToken(
  manifest: ModelManifest,
  price: PerTokenPriceModel,
  req: EstimateRequest,
  count: number,
  speedLabel: string | undefined,
): CostEstimate {
  const caps = manifest.capabilities;
  const quality = req.quality ?? caps.quality?.default;
  const tier = req.resolution ?? caps.resolution?.default;
  const sizeKey = req.size && "width" in req.size ? `${req.size.width}x${req.size.height}` : undefined;

  // An aspect-mode request looks up "3:4@1K" when the table is keyed by shape and tier. With no
  // size given, the model's default shape, as with the tier and quality.
  const aspect = req.size
    ? "aspect" in req.size
      ? req.size.aspect
      : undefined
    : caps.size.mode === "aspect"
      ? caps.size.default
      : undefined;
  const shapeKey = aspect && aspect !== "auto" && tier ? `${aspect}@${tier}` : undefined;

  // A quality with no rows ("auto") could be any of them.
  const rows = price.outputTokenTable.filter((r) => !quality || r.quality === quality);
  const pool = rows.length ? rows : price.outputTokenTable;
  const bySize = (key: string | undefined) => (key ? pool.filter((r) => r.size === key) : []);
  const matched = [sizeKey, shapeKey, tier].map(bySize).find((m) => m.length) ?? [];
  // An "auto" size still has a tier: its shapes give the range.
  const inTier = !matched.length && tier ? pool.filter((r) => r.size.endsWith(`@${tier}`)) : [];
  const candidates = matched.length ? matched : inTier.length ? inTier : pool;
  if (!candidates.length) return unknownCost(price.pricedAt);

  const tokens = candidates.map((r) => r.tokens);
  const outLow = (Math.min(...tokens) * price.imageOutputPerMTok) / 1e6;
  const outHigh = (Math.max(...tokens) * price.imageOutputPerMTok) / 1e6;
  // Roughly four characters per token; input text is a small share of the total.
  const text = req.promptAfterPreset ?? req.prompt ?? "";
  const textIn = (Math.ceil(text.length / 4) * price.textInputPerMTok) / 1e6;

  const low = outLow + textIn;
  const high = outHigh + textIn;
  return {
    currency: price.currency,
    min: round(low * count),
    max: round(high * count),
    confidence: "estimated",
    basis: basis(count, moneyRange(low, high, price.currency), speedLabel),
    pricedAt: price.pricedAt,
  };
}

type VideoTokenPriceModel = Extract<PriceModel, { kind: "video_tokens" }>;

/**
 * A video priced on the tokens its output counts to (§0.13): exact pixels from the model's size
 * table, times its frame rate and seconds. "auto" could be any shape at that resolution, so it's
 * the range over them. Never exact: the company bills the tokens it reports afterwards.
 */
function perVideo(
  manifest: ModelManifest,
  price: VideoTokenPriceModel,
  req: EstimateRequest,
  count: number,
  speedLabel: string | undefined,
): CostEstimate {
  const caps = manifest.capabilities.video;
  if (!caps) return unknownCost(price.pricedAt);
  const size = manifest.capabilities.size;
  const asked =
    req.size && "aspect" in req.size
      ? req.size.aspect
      : req.size && "width" in req.size
        ? undefined
        : size.mode === "aspect"
          ? size.default
          : undefined;
  const { video, aspect } = resolveVideo(manifest, req.video, asked ?? "auto");
  const rate = videoRate(price, video.resolution, video.audio);
  if (rate === undefined) return unknownCost(price.pricedAt);

  const exact = aspect === "auto" ? undefined : videoSize(caps, video.resolution, aspect);
  const pixels =
    req.size && "width" in req.size ? [req.size] : exact ? [exact] : videoSizes(caps, video.resolution);
  if (!pixels.length) return unknownCost(price.pricedAt);
  const costs = pixels.map((p) => (videoTokens(p, caps.fps, video.seconds) * rate) / 1e6);
  const low = Math.min(...costs);
  const high = Math.max(...costs);
  const detail =
    pixels.length === 1
      ? t("cost.video", { seconds: video.seconds, size: `${pixels[0]!.width}×${pixels[0]!.height}` })
      : t("cost.videoAnyShape", { seconds: video.seconds, resolution: video.resolution });
  return {
    currency: price.currency,
    min: round(low * count),
    max: round(high * count),
    confidence: "estimated",
    basis: basis(
      count,
      moneyRange(low, high, price.currency),
      speedLabel ? `${detail}, ${speedLabel}` : detail,
    ),
    pricedAt: price.pricedAt,
  };
}

function basis(count: number, each: string, detail: string | undefined): string {
  return detail ? t("cost.basisWith", { count, each, detail }) : t("cost.basis", { count, each });
}

/** "$0.134", or "$0.039–$0.134" per image. */
function moneyRange(low: number, high: number, currency: string): string {
  const min = formatMoney(low, currency, true);
  return low === high ? min : t("cost.range", { min, max: formatMoney(high, currency, true) });
}

function qualityLabel(manifest: ModelManifest, id: string): string {
  return manifest.capabilities.quality?.levels.find((l) => l.id === id)?.label ?? id;
}

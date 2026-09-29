import { z } from "zod";
import { COST_SOURCES, ESTIMATE_CONFIDENCES } from "../constants";
import { currencySchema, dateOrTimestampSchema, resolutionTierSchema, videoResolutionSchema } from "./common";

// Cost is pure data (§0.13, §6.9). Currency is a string with USD the only v1 value (§2.12).

export const perImagePriceSchema = z.strictObject({
  quality: z.string().min(1).optional(),
  tier: resolutionTierSchema.optional(),
  usd: z.number().nonnegative(),
});

const priced = {
  currency: currencySchema,
  pricedAt: dateOrTimestampSchema,
  sourceUrl: z.url(),
};

/**
 * The input tokens a company counts for one image sent in (a reference or an edit's base): the
 * same for every image, or counted in square patches of its pixels.
 */
export const inputImageTokensSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fixed"), tokens: z.int().nonnegative() }),
  z.strictObject({
    kind: z.literal("patches"),
    /** Pixels along a patch's side. */
    patch: z.int().positive(),
    /** A smaller image is scaled up until its long side reaches this, at most `maxScale` times. */
    scaleTo: z.int().positive(),
    maxScale: z.number().min(1),
    /** A patch grid wider or taller than this ratio is padded to it. */
    maxRatio: z.number().min(1),
    /** Past this many patches the image is shrunk to fit. */
    maxPatches: z.int().positive(),
    /** An image whose size isn't known yet (still to come from a node upstream). */
    unknown: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
  }),
]);

/** What one image sent in costs on top of a per-image price. */
export const inputImagePriceSchema = z.strictObject({
  tokens: inputImageTokensSchema,
  perMTok: z.number().nonnegative(),
});

export const priceModelSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("per_image"),
    ...priced,
    tiers: z.array(perImagePriceSchema).min(1),
    inputImage: inputImagePriceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("per_token"),
    ...priced,
    textInputPerMTok: z.number().nonnegative(),
    imageInputPerMTok: z.number().nonnegative(),
    /** Input tokens one image sent in costs, at imageInputPerMTok. Absent: not priced. */
    imageInputTokens: inputImageTokensSchema.optional(),
    imageOutputPerMTok: z.number().nonnegative(),
    cachedInputPerMTok: z.number().nonnegative().optional(),
    /** Output tokens per (quality, size): the only way to estimate before a run. */
    outputTokenTable: z.array(
      z.strictObject({ quality: z.string().min(1), size: z.string().min(1), tokens: z.int().nonnegative() }),
    ),
  }),
  z.strictObject({ kind: z.literal("per_second"), ...priced, perSecond: z.number().nonnegative() }),
  /**
   * A video billed on tokens the company counts from its output: width × height × fps × seconds /
   * 1024 (BytePlus Seedance). The sizes and frame rate come from the manifest's video capability,
   * so an estimate is exact once the aspect ratio is. The first rate that matches the run wins; a
   * row without a resolution or sound matches any.
   */
  z.strictObject({
    kind: z.literal("video_tokens"),
    ...priced,
    rates: z
      .array(
        z.strictObject({
          resolution: videoResolutionSchema.optional(),
          audio: z.boolean().optional(),
          perMTok: z.number().nonnegative(),
        }),
      )
      .min(1),
  }),
  z.strictObject({ kind: z.literal("provider_estimate"), ...priced }),
  z.strictObject({ kind: z.literal("unknown") }),
]);

export const costEstimateSchema = z.object({
  currency: currencySchema,
  min: z.number().nonnegative(),
  /** Equals min when exact. */
  max: z.number().nonnegative(),
  confidence: z.enum(ESTIMATE_CONFIDENCES),
  /** Human string for the tooltip, e.g. "3 images × $0.134 (2K)". */
  basis: z.string(),
  /** Empty when the price is unknown. */
  pricedAt: z.string(),
});

export const costActualSchema = z.object({
  currency: currencySchema,
  amount: z.number().nonnegative(),
  confidence: z.enum(COST_SOURCES),
  basis: z.string(),
});

/** usage_log.units */
export const usageUnitsSchema = z.object({
  images: z.int().nonnegative().optional(),
  tokensIn: z.int().nonnegative().optional(),
  tokensOut: z.int().nonnegative().optional(),
  cachedIn: z.int().nonnegative().optional(),
  /** Seconds of video billed. */
  seconds: z.number().nonnegative().optional(),
});

export type PerImagePrice = z.infer<typeof perImagePriceSchema>;
export type PriceModel = z.infer<typeof priceModelSchema>;
export type InputImageTokens = z.infer<typeof inputImageTokensSchema>;
export type CostEstimate = z.infer<typeof costEstimateSchema>;
export type CostActual = z.infer<typeof costActualSchema>;
export type UsageUnits = z.infer<typeof usageUnitsSchema>;

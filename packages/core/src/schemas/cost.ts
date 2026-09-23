import { z } from "zod";
import { COST_SOURCES, ESTIMATE_CONFIDENCES } from "../constants";
import { currencySchema, dateOrTimestampSchema, resolutionTierSchema } from "./common";

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

export const priceModelSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("per_image"), ...priced, tiers: z.array(perImagePriceSchema).min(1) }),
  z.strictObject({
    kind: z.literal("per_token"),
    ...priced,
    textInputPerMTok: z.number().nonnegative(),
    imageInputPerMTok: z.number().nonnegative(),
    imageOutputPerMTok: z.number().nonnegative(),
    cachedInputPerMTok: z.number().nonnegative().optional(),
    /** Output tokens per (quality, size): the only way to estimate before a run. */
    outputTokenTable: z.array(
      z.strictObject({ quality: z.string().min(1), size: z.string().min(1), tokens: z.int().nonnegative() }),
    ),
  }),
  z.strictObject({ kind: z.literal("per_second"), ...priced, perSecond: z.number().nonnegative() }),
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
});

export type PerImagePrice = z.infer<typeof perImagePriceSchema>;
export type PriceModel = z.infer<typeof priceModelSchema>;
export type CostEstimate = z.infer<typeof costEstimateSchema>;
export type CostActual = z.infer<typeof costActualSchema>;
export type UsageUnits = z.infer<typeof usageUnitsSchema>;

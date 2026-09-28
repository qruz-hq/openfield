import type { PriceModel } from "@openfield/core";

// Paid tier, per output image. Google bills image output by token (1K at 1,120 tokens,
// and so on) and publishes the per-image equivalents used here. Every image sent in (a reference or
// an edit's base) is billed on top as input tokens, a fixed count per image whatever its size, at the
// model's input price (priced like text). Thinking tokens are billed too; they're small next to the
// image and only known after the run. There is no free tier for these models.

const PRICED = {
  currency: "USD",
  pricedAt: "2026-09-23",
  sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
};

/**
 * Input tokens for one image sent in, whatever its size (checked 2026-09-28):
 * - Nano Banana Pro: "Image input is set at 560 tokens or $0.0011 per image"
 *   (ai.google.dev/gemini-api/docs/pricing).
 * - Nano Banana 2 and 2 Lite: "charges 1120 tokens per input image"
 *   (cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
 */
export const INPUT_IMAGE_TOKENS = {
  "gemini-3-pro-image": 560,
  "gemini-3.1-flash-image": 1120,
  "gemini-3.1-flash-lite-image": 1120,
} as const;

/**
 * Input price per 1M tokens at Standard: Pro $2, Nano Banana 2 $0.50, 2 Lite $0.25. Batch and Flex
 * are half and Priority 1.8x, as for output.
 */
const INPUT_PER_MTOK = {
  "gemini-3-pro-image": 2,
  "gemini-3.1-flash-image": 0.5,
  "gemini-3.1-flash-lite-image": 0.25,
} as const;

type Model = keyof typeof INPUT_IMAGE_TOKENS;
const SPEED_FACTOR = { standard: 1, batch: 0.5, flex: 0.5, priority: 1.8 } as const;

/** One image sent in to `model` at `speed`. */
const input = (model: Model, speed: keyof typeof SPEED_FACTOR = "standard") => ({
  tokens: { kind: "fixed" as const, tokens: INPUT_IMAGE_TOKENS[model] },
  perMTok: INPUT_PER_MTOK[model] * SPEED_FACTOR[speed],
});

export const PRICES = {
  // $120 per 1M output image tokens; input $2 per 1M.
  "gemini-3-pro-image": {
    kind: "per_image",
    ...PRICED,
    tiers: [
      { tier: "1K", usd: 0.134 },
      { tier: "2K", usd: 0.134 },
      { tier: "4K", usd: 0.24 },
    ],
    inputImage: input("gemini-3-pro-image"),
  },
  // $60 per 1M output image tokens (747 / 1,120 / 1,680 / 2,520 tokens); input $0.50 per 1M.
  "gemini-3.1-flash-image": {
    kind: "per_image",
    ...PRICED,
    tiers: [
      { tier: "512", usd: 0.045 },
      { tier: "1K", usd: 0.067 },
      { tier: "2K", usd: 0.101 },
      { tier: "4K", usd: 0.151 },
    ],
    inputImage: input("gemini-3.1-flash-image"),
  },
  // $30 per 1M output image tokens (1,120 tokens); input $0.25 per 1M.
  "gemini-3.1-flash-lite-image": {
    kind: "per_image",
    ...PRICED,
    tiers: [{ tier: "1K", usd: 0.0336 }],
    inputImage: input("gemini-3.1-flash-lite-image"),
  },
} satisfies Record<string, PriceModel>;

/**
 * The other speeds, from the same pricing page (updated 2026-09-22, checked 2026-09-23). Batch and
 * Flex are half of Standard. Priority is exactly 1.8x Standard, but Google publishes it only per
 * token ($216 per 1M image output tokens), so its per-image figures are derived: 1,120 and 2,000
 * tokens. Nano Banana 2 and 2 Lite offer Batch only.
 */
export const SPEED_PRICES = {
  "gemini-3-pro-image": {
    batch: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "1K", usd: 0.067 },
        { tier: "2K", usd: 0.067 },
        { tier: "4K", usd: 0.12 },
      ],
      inputImage: input("gemini-3-pro-image", "batch"),
    },
    flex: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "1K", usd: 0.067 },
        { tier: "2K", usd: 0.067 },
        { tier: "4K", usd: 0.12 },
      ],
      inputImage: input("gemini-3-pro-image", "flex"),
    },
    priority: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "1K", usd: 0.24192 },
        { tier: "2K", usd: 0.24192 },
        { tier: "4K", usd: 0.432 },
      ],
      inputImage: input("gemini-3-pro-image", "priority"),
    },
  },
  "gemini-3.1-flash-image": {
    batch: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "512", usd: 0.022 },
        { tier: "1K", usd: 0.034 },
        { tier: "2K", usd: 0.05 },
        { tier: "4K", usd: 0.076 },
      ],
      inputImage: input("gemini-3.1-flash-image", "batch"),
    },
  },
  "gemini-3.1-flash-lite-image": {
    batch: {
      kind: "per_image",
      ...PRICED,
      tiers: [{ tier: "1K", usd: 0.0168 }],
      inputImage: input("gemini-3.1-flash-lite-image", "batch"),
    },
  },
} satisfies Record<string, Record<string, PriceModel>>;

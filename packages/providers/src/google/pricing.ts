import type { PriceModel } from "@openfield/core";

// Paid tier, per output image. Google bills image output by token (1K at 1,120 tokens,
// and so on) and publishes the per-image equivalents used here. Input tokens and thinking tokens
// are billed on top; they're small next to the image and only known after the run.
// There is no free tier for these models.

const PRICED = {
  currency: "USD",
  pricedAt: "2026-09-23",
  sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
};

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
  },
  // $30 per 1M output image tokens (1,120 tokens); input $0.25 per 1M.
  "gemini-3.1-flash-lite-image": {
    kind: "per_image",
    ...PRICED,
    tiers: [{ tier: "1K", usd: 0.0336 }],
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
    },
    flex: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "1K", usd: 0.067 },
        { tier: "2K", usd: 0.067 },
        { tier: "4K", usd: 0.12 },
      ],
    },
    priority: {
      kind: "per_image",
      ...PRICED,
      tiers: [
        { tier: "1K", usd: 0.24192 },
        { tier: "2K", usd: 0.24192 },
        { tier: "4K", usd: 0.432 },
      ],
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
    },
  },
  "gemini-3.1-flash-lite-image": {
    batch: { kind: "per_image", ...PRICED, tiers: [{ tier: "1K", usd: 0.0168 }] },
  },
} satisfies Record<string, Record<string, PriceModel>>;

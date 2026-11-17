import type { PriceModel } from "@openfield/core";

// USD per million output tokens, online inference, from BytePlus's pricing page on 2026-09-29.
// Tokens are width × height × 24 × seconds / 1024 of the output, estimated from the size table and
// billed from usage.completion_tokens once the video exists. Only a successful video is billed.
// The limited promotions on 2.0 Fast and 2.0 Mini (enterprise accounts, to 2026-10-07) aren't
// applied: individual keys pay the list price.

const SOURCE = "https://docs.byteplus.com/en/docs/ModelArk/1099320";
const priced = { currency: "USD", pricedAt: "2026-09-29", sourceUrl: SOURCE } as const;

const price = (rates: Extract<PriceModel, { kind: "video_tokens" }>["rates"]): PriceModel => ({
  kind: "video_tokens",
  ...priced,
  rates,
});

export const PRICES = {
  "dreamina-seedance-2-5-260628": price([{ resolution: "1080p", perMTok: 11.7 }, { perMTok: 10.7 }]),
  "dreamina-seedance-2-0-260128": price([
    { resolution: "1080p", perMTok: 7.7 },
    { resolution: "4k", perMTok: 4.0 },
    { perMTok: 7.0 },
  ]),
  "dreamina-seedance-2-0-fast-260128": price([{ perMTok: 5.6 }]),
  "dreamina-seedance-2-0-mini-260615": price([{ perMTok: 3.5 }]),
  // The one model whose price depends on sound.
  "seedance-1-5-pro-251215": price([
    { audio: true, perMTok: 2.4 },
    { audio: false, perMTok: 1.2 },
  ]),
  "seedance-1-0-pro-250528": price([{ perMTok: 2.5 }]),
  "seedance-1-0-pro-fast-251015": price([{ perMTok: 1.0 }]),
} satisfies Record<string, PriceModel>;

// Seedream: USD per output image, from the same page on 2026-11-09. Only images that come back are
// billed, and every image of a related set or a separation counts on its own. 5.5 and 5.0 Pro bill
// by the pixels of each image, each with a line between two rates, and their input images (all of
// 5.5's, Pro's after the first); every other model takes input images free.

const seedreamPriced = { currency: "USD", pricedAt: "2026-11-09", sourceUrl: SOURCE } as const;
/** "up to 2.61M px" on the pricing page. Every 1K and 1.5K size is under it; every 2K size over. */
export const PRO_TIER_PIXELS = 2_610_000;

const flat = (usd: number): Extract<PriceModel, { kind: "per_image" }> => ({
  kind: "per_image",
  ...seedreamPriced,
  tiers: [{ usd }],
});

/**
 * 5.5's line between its two rates: "up to 2,601,123.84 px". Pixels are whole, so this is exact. Its
 * top, 4,624,220.16, is the most any size it makes can have.
 */
export const V55_TIER_PIXELS = 2_601_123;

export const SEEDREAM_PRICES = {
  // From the same page on 2026-11-17. Every input image is $0.008, none free. A separation bills
  // its base and each layer by their own pixels on the same two rates. The table starts at
  // 921,600 px, but a cropped layer can be smaller: the lower rate is assumed for those (README).
  "dola-seedream-5-5-261028": {
    kind: "per_image",
    currency: "USD",
    pricedAt: "2026-11-17",
    sourceUrl: SOURCE,
    tiers: [
      { tier: "1K", usd: 0.02 },
      { tier: "1.5K", usd: 0.02 },
      { tier: "2K", usd: 0.035 },
    ],
    byPixels: [{ maxPixels: V55_TIER_PIXELS, usd: 0.02 }, { usd: 0.035 }],
    inputImage: { usd: 0.008, freePerCall: 0 },
    decompose: {
      tiers: [
        { tier: "1K", usd: 0.02 },
        { tier: "1.5K", usd: 0.02 },
        { tier: "2K", usd: 0.035 },
      ],
      byPixels: [{ maxPixels: V55_TIER_PIXELS, usd: 0.02 }, { usd: 0.035 }],
      // A base and 1 to 99 layers. How many at most is the person's choice (layers.choose).
      outputs: { min: 2, max: 100 },
    },
  },
  "dola-seedream-5-0-pro-260628": {
    kind: "per_image",
    ...seedreamPriced,
    tiers: [
      { tier: "1K", usd: 0.045 },
      { tier: "1.5K", usd: 0.045 },
      { tier: "2K", usd: 0.09 },
    ],
    byPixels: [{ maxPixels: PRO_TIER_PIXELS, usd: 0.045 }, { usd: 0.09 }],
    inputImage: { usd: 0.003, freePerCall: 1 },
    // The base and each layer at the layer rate, by their own pixels: up to a base and 16 layers.
    decompose: {
      tiers: [
        { tier: "1K", usd: 0.0225 },
        { tier: "1.5K", usd: 0.0225 },
        { tier: "2K", usd: 0.045 },
      ],
      byPixels: [{ maxPixels: PRO_TIER_PIXELS, usd: 0.0225 }, { usd: 0.045 }],
      outputs: { min: 2, max: 17 },
    },
  },
  // One rate, and no separate layer row: assumed to apply to a separation's images too (README).
  "dola-seedream-5-0-flash-260915": {
    ...flat(0.018),
    decompose: { tiers: [{ usd: 0.018 }], outputs: { min: 2, max: 17 } },
  },
  "seedream-5-0-260128": flat(0.035),
  "seedream-4-5-251128": flat(0.04),
  "seedream-4-0-250828": flat(0.03),
} satisfies Record<string, PriceModel>;

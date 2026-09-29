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

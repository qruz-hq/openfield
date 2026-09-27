import type { PriceModel } from "@openfield/core";
import { openAiSize, outputTokens, RATIOS, TIERS, TOKEN_BASES } from "./capabilities";

// Per 1M tokens, from developers.openai.com/api/docs/pricing (checked 2026-09-27). The Image API
// bills text input, image input and image output tokens. It publishes no per-image price, so the
// estimate reads output tokens from a table built with OpenAI's own calculator for exactly the
// sizes this adapter sends. Cached input rates apply only to the Responses API's image tool, never
// to /v1/images, so none is declared.

const PRICED = {
  currency: "USD",
  pricedAt: "2026-09-27",
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
};

type Family = keyof typeof TOKEN_BASES;

/**
 * One row per quality, ratio and tier, keyed "3:4@1K", the key estimate() looks up for an
 * aspect-mode request. "auto" sizes and qualities have no row: the estimate shows the tier's range.
 */
export function outputTokenTable(family: Family): { quality: string; size: string; tokens: number }[] {
  const rows: { quality: string; size: string; tokens: number }[] = [];
  for (const [quality, base] of Object.entries(TOKEN_BASES[family])) {
    for (const ratio of RATIOS) {
      for (const tier of TIERS) {
        const size = openAiSize(ratio, tier);
        if (size === "auto") continue;
        rows.push({ quality, size: `${ratio}@${tier}`, tokens: outputTokens(base, size.width, size.height) });
      }
    }
  }
  return rows;
}

const standard = (family: Family): PriceModel => ({
  kind: "per_token",
  ...PRICED,
  textInputPerMTok: 5,
  imageInputPerMTok: 8,
  imageOutputPerMTok: 30,
  outputTokenTable: outputTokenTable(family),
});

export const PRICES = {
  "gpt-image-2.5-sunburst": standard("gpt-image-2.5"),
  "gpt-image-2.5-flare": standard("gpt-image-2.5"),
  "gpt-image-2": standard("gpt-image-2"),
} satisfies Record<string, PriceModel>;

/** Batch is half price on every rate. Only gpt-image-2 lists it; the 2.5 models don't offer Batch. */
export const BATCH_PRICES = {
  "gpt-image-2": {
    kind: "per_token",
    ...PRICED,
    textInputPerMTok: 2.5,
    imageInputPerMTok: 4,
    imageOutputPerMTok: 15,
    outputTokenTable: outputTokenTable("gpt-image-2"),
  },
} satisfies Record<string, PriceModel>;

import type { InputImageTokens, PriceModel } from "@openfield/core";
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
 * Input tokens for one image sent in (a reference or an edit's base), billed at imageInputPerMTok.
 * OpenAI publishes no rule for GPT Image 2 or 2.5 (checked 2026-09-28). This is a community
 * measurement of gpt-image-2 (community.openai.com/t/openai-must-document-the-input-image-pricing-
 * of-gpt-image-2-so-i-did/1382940): scaled up until its long side reaches 1,024 px (at most 2x),
 * counted in 32 px patches, the grid padded to 3:1 and shrunk to fit 1,536 patches. Measured:
 * 256² is 256, 768² and 1024² are 1,024, 1536² is 1,521, 2048×1024 is 1,458. Output size and quality
 * don't change it. The 2.5 models are assumed to count the same: their pages say "Token rates match
 * GPT Image 2". An image whose size isn't known yet counts as 1,024 to 1,536.
 */
export const INPUT_IMAGE_TOKENS: InputImageTokens = {
  kind: "patches",
  patch: 32,
  scaleTo: 1024,
  maxScale: 2,
  maxRatio: 3,
  maxPatches: 1536,
  unknown: { min: 1024, max: 1536 },
};

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
  imageInputTokens: INPUT_IMAGE_TOKENS,
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
    imageInputTokens: INPUT_IMAGE_TOKENS,
    imageOutputPerMTok: 15,
    outputTokenTable: outputTokenTable("gpt-image-2"),
  },
} satisfies Record<string, PriceModel>;

import type { ModelManifest } from "@openfield/core";
import { openAiCapabilities, QUALITY } from "./capabilities";
import { BATCH_PRICES, PRICES } from "./pricing";

// The static catalog, checked against developers.openai.com/api/docs/models on 2026-09-27. The
// older image models (gpt-image-1, 1-mini, 1.5) are deprecated and shut down by December 1, 2026,
// so they're left out.

const CATALOGED = {
  providerId: "openai",
  family: "GPT Image",
  source: "static",
  fetchedAt: "2026-09-27",
} as const;

const HOUR = 3_600_000;

export const OPENAI_MODELS: readonly ModelManifest[] = [
  {
    ...CATALOGED,
    key: "openai:gpt-image-2.5-sunburst",
    modelId: "gpt-image-2.5-sunburst",
    displayName: "GPT Image 2.5 Sunburst",
    description: "The most capable, and the most precise at edits.",
    badges: ["new"],
    capabilities: openAiCapabilities({
      displayName: "GPT Image 2.5 Sunburst",
      quality: QUALITY["gpt-image-2.5"],
      transparency: true,
    }),
    price: PRICES["gpt-image-2.5-sunburst"],
    manifestVersion: "1",
  },
  {
    ...CATALOGED,
    key: "openai:gpt-image-2.5-flare",
    modelId: "gpt-image-2.5-flare",
    displayName: "GPT Image 2.5 Flare",
    description: "Fast everyday images at a good price.",
    badges: ["new"],
    capabilities: openAiCapabilities({
      displayName: "GPT Image 2.5 Flare",
      quality: QUALITY["gpt-image-2.5"],
      transparency: true,
    }),
    price: PRICES["gpt-image-2.5-flare"],
    manifestVersion: "1",
  },
  {
    ...CATALOGED,
    key: "openai:gpt-image-2",
    modelId: "gpt-image-2",
    displayName: "GPT Image 2",
    description: "The previous generation. Offers Batch at half price.",
    badges: ["legacy"],
    capabilities: openAiCapabilities({
      displayName: "GPT Image 2",
      quality: QUALITY["gpt-image-2"],
      // Transparent backgrounds are only a preview on this model.
      transparency: false,
    }),
    price: PRICES["gpt-image-2"],
    // Batch ships generations only: edits in a batch need the JSON form of /v1/images/edits, which
    // OpenAI's batch guide doesn't confirm (README.md). An edit at Batch runs at Standard.
    speeds: [
      {
        id: "batch",
        price: BATCH_PRICES["gpt-image-2"],
        delivery: "async",
        waitMs: { target: 24 * HOUR, max: 24 * HOUR },
        ops: ["generate"],
      },
    ],
    manifestVersion: "1",
  },
];

import type { ModelManifest } from "@openfield/core";
import { EXTRAS, geminiCapabilities, RATIOS } from "./capabilities";
import { PRICES } from "./pricing";

// The static catalog, checked against ai.google.dev/gemini-api/docs/models on 2026-09-23.
// Nano Banana (gemini-2.5-flash-image) is left out: Google shuts it down on October 2, 2026 and
// already limits it to existing users.

const CATALOGED = {
  providerId: "google",
  family: "Nano Banana",
  source: "static",
  fetchedAt: "2026-09-23",
} as const;

export const GOOGLE_MODELS: readonly ModelManifest[] = [
  {
    ...CATALOGED,
    key: "google:gemini-3-pro-image",
    modelId: "gemini-3-pro-image",
    displayName: "Nano Banana Pro",
    description: "Sharp text and complex scenes, up to 4K.",
    capabilities: geminiCapabilities({
      displayName: "Nano Banana Pro",
      ratios: RATIOS.pro,
      tiers: ["1K", "2K", "4K"],
      extraSchema: EXTRAS.pro,
    }),
    price: PRICES["gemini-3-pro-image"],
    manifestVersion: "1",
  },
  {
    ...CATALOGED,
    key: "google:gemini-3.1-flash-image",
    modelId: "gemini-3.1-flash-image",
    displayName: "Nano Banana 2",
    description: "Fast and versatile, up to 4K.",
    capabilities: geminiCapabilities({
      displayName: "Nano Banana 2",
      ratios: RATIOS.flash,
      tiers: ["512", "1K", "2K", "4K"],
      extraSchema: EXTRAS.flash,
    }),
    price: PRICES["gemini-3.1-flash-image"],
    manifestVersion: "1",
  },
  {
    ...CATALOGED,
    key: "google:gemini-3.1-flash-lite-image",
    modelId: "gemini-3.1-flash-lite-image",
    displayName: "Nano Banana 2 Lite",
    description: "The fastest and cheapest. 1K only.",
    capabilities: geminiCapabilities({
      displayName: "Nano Banana 2 Lite",
      ratios: RATIOS.lite,
      tiers: ["1K"],
      extraSchema: EXTRAS.lite,
      // One size only, so the chip shows it disabled rather than offering a choice of one.
      unsupported: { resolution: { reason: "Nano Banana 2 Lite makes 1K images only." } },
    }),
    price: PRICES["gemini-3.1-flash-lite-image"],
    manifestVersion: "1",
  },
];

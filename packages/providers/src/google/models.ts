import type { ModelManifest, PriceModel, SpeedOffer } from "@openfield/core";
import { EXTRAS, geminiCapabilities, RATIOS } from "./capabilities";
import { PRICES, SPEED_PRICES } from "./pricing";

// The static catalog, checked against ai.google.dev/gemini-api/docs/models on 2026-09-23.
// Nano Banana (gemini-2.5-flash-image) is left out: Google shuts it down on October 2, 2026 and
// already limits it to existing users.

const CATALOGED = {
  providerId: "google",
  family: "Nano Banana",
  source: "static",
  fetchedAt: "2026-09-23",
} as const;

// Waits from Google's guides: Batch targets 24 hours and expires at 48; Flex targets 1 to 15
// minutes and asks clients to wait 10 minutes or more, so a Flex call gets 15.
const HOUR = 3_600_000;
const batch = (price: PriceModel): SpeedOffer => ({
  id: "batch",
  price,
  delivery: "async",
  waitMs: { target: 24 * HOUR, max: 48 * HOUR },
});
const flex = (price: PriceModel): SpeedOffer => ({
  id: "flex",
  price,
  delivery: "sync",
  waitMs: { target: 60_000, max: 900_000 },
  requestTimeoutMs: 900_000,
});
const priority = (price: PriceModel): SpeedOffer => ({
  id: "priority",
  price,
  delivery: "sync",
  waitMs: { target: 3_000, max: 120_000 },
});

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
    // Flex and Priority follow the newer pricing page; the model page still says "Not supported"
    // (README.md). If Google rejects or ignores them, they come out of this list.
    speeds: [
      batch(SPEED_PRICES["gemini-3-pro-image"].batch),
      flex(SPEED_PRICES["gemini-3-pro-image"].flex),
      priority(SPEED_PRICES["gemini-3-pro-image"].priority),
    ],
    manifestVersion: "2",
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
    speeds: [batch(SPEED_PRICES["gemini-3.1-flash-image"].batch)],
    manifestVersion: "2",
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
    speeds: [batch(SPEED_PRICES["gemini-3.1-flash-lite-image"].batch)],
    manifestVersion: "2",
  },
];

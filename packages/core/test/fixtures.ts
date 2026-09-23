import type { ModelManifest } from "../src/schemas";

// A Gemini-like manifest, close to §6.13. Values are illustrative, not a catalog.
export const sampleManifest: ModelManifest = {
  key: "google:gemini-3-pro-image",
  providerId: "google",
  modelId: "gemini-3-pro-image",
  displayName: "Nano Banana Pro",
  description: "Up to 14 references",
  family: "Nano Banana",
  capabilities: {
    ops: {
      textToImage: true,
      imageEdit: true,
      inpaint: false,
      outpaint: false,
      upscale: false,
      removeBackground: false,
      detectText: false,
      decomposeLayers: false,
    },
    references: {
      supported: true,
      max: 14,
      roles: ["subject", "style", "composition", "palette"],
      mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxBytes: 20_000_000,
      weights: false,
      strengthMode: "none",
    },
    size: { mode: "aspect", ratios: ["auto", "1:1", "3:4", "4:3", "16:9", "9:16"], default: "auto" },
    resolution: { tiers: ["1K", "2K", "4K"], default: "1K" },
    batch: { max: 4, native: false },
    seed: { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "openfield",
    styleStrength: false,
    transparency: false,
    streaming: { partialImages: false, progressPercent: false },
    output: { formats: ["png"], default: "png" },
    safety: { notices: ["Images include a hidden AI watermark."] },
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    limits: { requestTimeoutMs: 120_000, typicalLatencyMs: [3000, 9000], maxConcurrent: 4 },
    controlOrder: ["model", "aspect", "resolution", "advanced", "batch", "seed"],
    extraSchema: {
      type: "object",
      properties: {
        thinking: { type: "string", title: "Thinking", enum: ["low", "high"], default: "low" },
        grounding: { type: "boolean", title: "Search the web", default: false },
      },
    },
    emulated: ["batch", "negativePrompt"],
    unsupported: { seed: { reason: "Nano Banana Pro doesn't support seeds." } },
    unsupportedParamPolicy: "drop-with-warning",
  },
  price: {
    kind: "per_image",
    currency: "USD",
    tiers: [
      { tier: "1K", usd: 0.134 },
      { tier: "2K", usd: 0.134 },
      { tier: "4K", usd: 0.24 },
    ],
    pricedAt: "2026-09-23",
    sourceUrl: "https://ai.google.dev/pricing",
  },
  source: "static",
  manifestVersion: "1",
  fetchedAt: "2026-09-23",
};

export const ID_A = "01K6BQ7Y2M8N4P0R3S5T7V9W1X";
export const ID_B = "01K6BQ8A1C4D7E9F2G3H4J5K6M";
export const ID_C = "01K6BQ9Z0A1B2C3D4E5F6G7H8J";
export const NOW = "2026-09-23T12:44:01.882Z";

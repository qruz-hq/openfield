import type { AspectRatio, Capabilities, PixelSize, QualityLevel, ResolutionTier } from "@openfield/core";
import { RESOLUTION_TIER_PX, t } from "@openfield/core";

// Checked against the Image API reference, the image generation guide and each model's page on
// developers.openai.com on 2026-09-27. See README.md for what is still unverified.

/** meta.displayName, and the company name in our copy. */
export const COMPANY = "OpenAI";
export const API_HOST = "api.openai.com";
export const API_BASE = `https://${API_HOST}/v1`;

// Custom sizes (gpt-image-2 and the 2.5 models): both edges multiples of 16, the long edge at most
// 3840, at most 3:1, and between 655,360 and 8,294,400 pixels. Above 2560×1440 OpenAI calls the
// size experimental.
export const SIZE_RULES = {
  multipleOf: 16,
  maxEdge: 3840,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
} as const;

/**
 * Every ratio the composer offers maps to a legal custom size (conformance 2), so all three models
 * share the list. "auto" sends size "auto" and lets the model choose.
 */
export const RATIOS: AspectRatio[] = [
  "auto",
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "27:16",
  "16:27",
  "9:8",
  "8:9",
];

export const TIERS: ResolutionTier[] = ["1K", "1.5K", "2K", "4K"];

/**
 * The size OpenAI is sent for a ratio at a tier: the tier sets the long edge, the ratio the short
 * one, both snapped to 16. A shape too small for the pixel floor (16:9 at 1K is 1024×576) grows
 * until it clears it, and one too big for the ceiling (1:1 at 4K) shrinks to fit, so "1K" means
 * "about a megapixel" and "4K" "as large as OpenAI allows" whatever the shape.
 */
export function openAiSize(ratio: AspectRatio, tier: ResolutionTier): PixelSize | "auto" {
  if (ratio === "auto") return "auto";
  const { multipleOf: m, maxEdge, minPixels, maxPixels } = SIZE_RULES;
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  const value = w / h;
  const wide = value >= 1;
  const shape = wide ? value : 1 / value;
  const fit = (long: number) => {
    const l = Math.min(maxEdge, Math.floor(long / m) * m);
    const s = Math.max(m, Math.floor(l / shape / m) * m);
    return wide ? { width: l, height: s } : { width: s, height: l };
  };
  let size = fit(RESOLUTION_TIER_PX[tier]);
  let area = size.width * size.height;
  if (area < minPixels) {
    // Round each edge up to the grid so the floor is cleared, not just approached.
    const scale = Math.sqrt(minPixels / area);
    const up = (edge: number) => Math.ceil((edge * scale) / m) * m;
    size = { width: up(size.width), height: up(size.height) };
    area = size.width * size.height;
  }
  if (area > maxPixels) size = fit(Math.sqrt(maxPixels * shape));
  return size;
}

/**
 * Output tokens for one image, from OpenAI's own calculator in the image generation guide: the
 * quality sets a base, the long side gets it and the short side gets it scaled by the shape
 * (rounded half to even), and the product scales with the pixel count.
 */
export function outputTokens(base: number, width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const s = base / (long / short);
  const floor = Math.floor(s);
  const scaled = s - floor === 0.5 ? floor + (floor % 2) : Math.round(s);
  return Math.ceil((base * scaled * (2e6 + width * height)) / 4e6);
}

/** Token bases per quality, from the calculator. The 2.5 models add Extra high and Max. */
export const TOKEN_BASES = {
  "gpt-image-2": { low: 16, medium: 48, high: 96 },
  "gpt-image-2.5": { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 },
} as const;

const LEVELS: Record<string, QualityLevel> = {
  low: { id: "low", label: "Low", hint: "Fastest and cheapest" },
  medium: { id: "medium", label: "Medium", hint: "Balanced" },
  high: { id: "high", label: "High", hint: "Sharpest detail" },
  xhigh: { id: "xhigh", label: "Extra high", hint: "Finer detail, costs more" },
  max: { id: "max", label: "Max", hint: "Best quality" },
  auto: { id: "auto", label: "Auto", hint: "Let the model choose" },
};

export const QUALITY = {
  "gpt-image-2": ["low", "medium", "high", "auto"].map((id) => LEVELS[id]!),
  "gpt-image-2.5": ["low", "medium", "high", "xhigh", "max", "auto"].map((id) => LEVELS[id]!),
};

interface OpenAiCapabilityOptions {
  displayName: string;
  quality: QualityLevel[];
  /** Transparent backgrounds: supported on the 2.5 models, only a preview on gpt-image-2. */
  transparency: boolean;
}

export function openAiCapabilities(opts: OpenAiCapabilityOptions): Capabilities {
  return {
    ops: {
      textToImage: true,
      // /v1/images/edits takes the base and references as image[], and a mask for the first image.
      imageEdit: true,
      inpaint: true,
      // The PRD's padded-canvas outpaint isn't built yet (README.md).
      outpaint: false,
      upscale: false,
      removeBackground: false,
      detectText: false,
      decomposeLayers: false,
    },
    references: {
      supported: true,
      // Up to 16 images per edit, the base among them.
      max: 15,
      roles: ["subject", "style", "composition", "palette"],
      mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxBytes: 50_000_000,
      weights: false,
      strengthMode: "none",
    },
    size: { mode: "aspect", ratios: RATIOS, default: "1:1" },
    resolution: { tiers: TIERS, default: "1K" },
    quality: { levels: opts.quality, default: "medium" },
    // n goes up to 10; the composer's cap is 4. OpenAI returns exactly n images or an error.
    batch: { max: 4, native: true },
    seed: { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "openfield",
    styleStrength: false,
    background: {
      values: opts.transparency ? ["auto", "opaque", "transparent"] : ["auto", "opaque"],
      default: "auto",
    },
    transparency: opts.transparency,
    // Every model page says streaming isn't supported, so no partial images yet.
    streaming: { partialImages: false, progressPercent: false },
    output: {
      formats: ["png", "jpeg", "webp"],
      default: "png",
      compression: { min: 0, max: 100, default: 100 },
    },
    safety: {
      moderation: { values: ["auto", "low"], default: "auto", label: "Content filter" },
    },
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    // Complex prompts can take close to two minutes, so the call gets three.
    limits: {
      maxPromptChars: 32_000,
      requestTimeoutMs: 180_000,
      typicalLatencyMs: [8000, 120_000],
      maxConcurrent: 2,
    },
    controlOrder: [
      "model",
      "aspect",
      "resolution",
      "quality",
      "promptEnhance",
      "batch",
      "background",
      "negativePrompt",
      "seed",
      "outputFormat",
      "moderation",
      "advanced",
    ],
    emulated: ["negativePrompt"],
    unsupported: {
      seed: { reason: t("composer.chips.seed.unsupported", { model: opts.displayName }) },
    },
    unsupportedParamPolicy: "reject",
  };
}

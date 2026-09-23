import type { AspectRatio, Capabilities, ExtraField, ExtraSchema, ResolutionTier } from "@openfield/core";
import { t } from "@openfield/core";

// Verified against the image generation guide, its resolution tables and the ImageConfig API
// reference on 2026-09-23. See README.md for what is still unverified.

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Every model's table lists these ten. */
const STANDARD_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const satisfies readonly AspectRatio[];

/** Only the Nano Banana 2 table has these. The PRD assumed Pro had them too; its table doesn't. */
const TALL_AND_WIDE_RATIOS = ["1:4", "4:1", "1:8", "8:1"] as const satisfies readonly AspectRatio[];

// "auto" leaves aspectRatio out, and the model follows the references or makes a square.
export const RATIOS = {
  pro: ["auto", ...STANDARD_RATIOS],
  flash: ["auto", ...STANDARD_RATIOS, ...TALL_AND_WIDE_RATIOS],
  lite: ["auto", ...STANDARD_RATIOS],
} satisfies Record<string, AspectRatio[]>;

const THINKING: ExtraField = {
  type: "string",
  title: "Thinking",
  description: "Think longer before drawing. Slower, and it may cost a little more.",
  enum: ["minimal", "high"],
  default: "minimal",
};

const GROUNDING: ExtraField = {
  type: "boolean",
  title: "Search the web",
  description: "Look up current facts before drawing. Google may charge for searches.",
  default: false,
};

// Thinking level is documented for the two 3.1 models only; search grounding for all but Lite.
export const EXTRAS = {
  pro: { type: "object", properties: { grounding: GROUNDING } },
  flash: { type: "object", properties: { thinking: THINKING, grounding: GROUNDING } },
  lite: { type: "object", properties: { thinking: THINKING } },
} satisfies Record<string, ExtraSchema>;

interface GeminiCapabilityOptions {
  displayName: string;
  ratios: AspectRatio[];
  tiers: ResolutionTier[];
  extraSchema: ExtraSchema;
  unsupported?: Capabilities["unsupported"];
}

export function geminiCapabilities(opts: GeminiCapabilityOptions): Capabilities {
  return {
    ops: {
      textToImage: true,
      imageEdit: true,
      // No mask input: masked edits use Openfield's regional fallback (§0.9).
      inpaint: false,
      outpaint: false,
      upscale: false,
      removeBackground: false,
      detectText: false,
      decomposeLayers: false,
    },
    references: {
      supported: true,
      // "Up to 14 reference images" on all three. The role goes in the prompt, not on the wire.
      max: 14,
      roles: ["subject", "style", "composition", "palette"],
      mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
      // One guide caps a whole inline request at 20 MB, another at 100 MB. Per image, 20 MB is safe.
      maxBytes: 20_000_000,
      weights: false,
      strengthMode: "none",
    },
    size: { mode: "aspect", ratios: opts.ratios, default: "auto" },
    resolution: { tiers: opts.tiers, default: "1K" },
    // generationConfig.candidateCount exists, but nothing documents it for image models, and the
    // guide warns the model "won't always follow the exact number of image outputs". So: one call
    // per image.
    batch: { max: 4, native: false },
    // generationConfig.seed exists, but reproducible images aren't documented for these models.
    seed: { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "openfield",
    styleStrength: false,
    transparency: false,
    streaming: { partialImages: false, progressPercent: false },
    // The only documented image output type (ResponseFormatConfig.image.mimeType) is JPEG. The PRD
    // assumed PNG. Bytes are stored as returned either way, so this only informs the UI.
    output: { formats: ["jpeg"], default: "jpeg" },
    safety: { notices: ["Images include a hidden AI watermark."] },
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    // From the PRD's research. Not yet measured over 10 runs (§6.12 rule 7).
    limits: { requestTimeoutMs: 120_000, typicalLatencyMs: [3000, 9000], maxConcurrent: 4 },
    // Model, aspect, size, Enhance, batch, as the composer design shows; then the rest.
    controlOrder: [
      "model",
      "aspect",
      "resolution",
      "promptEnhance",
      "batch",
      "seed",
      "negativePrompt",
      "advanced",
    ],
    extraSchema: opts.extraSchema,
    emulated: ["batch", "negativePrompt"],
    unsupported: {
      seed: { reason: t("composer.chips.seed.unsupported", { model: opts.displayName }) },
      ...opts.unsupported,
    },
    unsupportedParamPolicy: "drop-with-warning",
  };
}

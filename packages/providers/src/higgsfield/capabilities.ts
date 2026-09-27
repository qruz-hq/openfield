import type {
  AspectRatio,
  Capabilities,
  ControlId,
  ExtraSchema,
  OutputFormat,
  QualityLevel,
  ResolutionTier,
} from "@openfield/core";
import { t } from "@openfield/core";

// Checked against each workflow's JSON schema on docs.higgsfield.ai (catalog as of 2026-09-22),
// on 2026-09-27. Nothing here has been run live yet: see README.md.

/** meta.displayName, and the company name in our copy. */
export const COMPANY = "Higgsfield";
export const API_HOST = "api.higgsfield.ai";
export const API_BASE = `https://${API_HOST}`;
/**
 * Where finished images are downloaded from. UNCONFIRMED: the docs only show cdn.example.com, so
 * this is the PRD's research until a live run shows the real host. A download from anywhere else
 * is refused, and the error names the host, so the log says what to add here.
 */
export const ASSET_HOSTS = ["cdn.higgsfield.ai"];

/**
 * One model's wire rules: its endpoint, and how each Openfield control reaches it. The manifest is
 * built from this, so what the composer offers and what the adapter sends can't drift apart.
 */
export interface WireSpec {
  /** Our model id: a slug, because a slash would break the /api/models/:providerId/:modelId routes. */
  modelId: string;
  /** The endpoint path after the host, the model's id at Higgsfield. */
  path: string;
  displayName: string;
  /** Our own copy, 90 characters at most. */
  description: string;
  family: string;
  /** The documented ratios Openfield can draw, in the order the chip lists them. */
  ratios: AspectRatio[];
  defaultRatio: AspectRatio;
  /** Our resolution tier to the model's own value ("720p", "2k"). Absent: the model picks. */
  resolutions?: Partial<Record<ResolutionTier, string>>;
  defaultTier?: ResolutionTier;
  /** The field the quality chip fills. Ideogram calls its ladder rendering_speed. */
  quality?: { field: "quality" | "rendering_speed"; levels: QualityLevel[]; default: string };
  /** Inclusive, as documented. Absent: no seed field. */
  seed?: [number, number];
  negativePrompt?: boolean;
  /** The model's own prompt rewriting, when the Enhance chip should drive it. */
  enhance?: "enhance_prompt" | "prompt_extend";
  /** moderation: auto or low. */
  moderation?: boolean;
  /** Recraft only: jpg, png or webp. */
  outputFormats?: boolean;
  extras?: ExtraSchema;
  maxPromptChars?: number;
}

const OPS: Capabilities["ops"] = {
  textToImage: true,
  // Edits and references need an upload whose storage host is unconfirmed (README.md).
  imageEdit: false,
  inpaint: false,
  outpaint: false,
  upscale: false,
  removeBackground: false,
  detectText: false,
  decomposeLayers: false,
};

const NO_REFERENCES: Capabilities["references"] = {
  supported: false,
  max: 0,
  roles: [],
  mimeTypes: [],
  maxBytes: 0,
  weights: false,
  strengthMode: "none",
};

const CONTROL_ORDER: ControlId[] = [
  "model",
  "aspect",
  "resolution",
  "quality",
  "promptEnhance",
  "batch",
  "seed",
  "negativePrompt",
  "advanced",
];

/** The finished image's format. Recraft lets you choose; for the rest the docs don't say (README.md). */
function outputOf(spec: WireSpec): Capabilities["output"] {
  const formats: OutputFormat[] = spec.outputFormats ? ["jpeg", "png", "webp"] : ["png"];
  return { formats, default: formats[0]! };
}

export function higgsfieldCapabilities(spec: WireSpec): Capabilities {
  const tiers = Object.keys(spec.resolutions ?? {}) as ResolutionTier[];
  const unsupported: NonNullable<Capabilities["unsupported"]> = {};
  if (!spec.seed) {
    unsupported.seed = { reason: t("composer.chips.seed.unsupported", { model: spec.displayName }) };
  }
  if (tiers.length === 1) {
    // One size only, so the chip shows it disabled rather than offering a choice of one.
    unsupported.resolution = { reason: `${spec.displayName} makes ${tiers[0]} images only.` };
  } else if (!tiers.length) {
    unsupported.resolution = { reason: `${spec.displayName} picks its own size.` };
  }
  return {
    ops: OPS,
    references: NO_REFERENCES,
    size: { mode: "aspect", ratios: spec.ratios, default: spec.defaultRatio },
    ...(tiers.length && { resolution: { tiers, default: spec.defaultTier ?? tiers[0]! } }),
    ...(spec.quality && { quality: { levels: spec.quality.levels, default: spec.quality.default } }),
    // Only the SOUL family takes a batch size, and only 1 or 4, so every model makes one image per
    // call and the runner sends one call per image.
    batch: { max: 4, native: false },
    seed: spec.seed
      ? { supported: true, range: spec.seed, echoed: false }
      : { supported: false, echoed: false },
    negativePrompt: spec.negativePrompt ?? false,
    promptEnhance: spec.enhance ? "native" : "openfield",
    // SOUL's style strength rides with its style id in Advanced, since there's no preset slot for it.
    styleStrength: false,
    transparency: false,
    streaming: { partialImages: false, progressPercent: false },
    output: outputOf(spec),
    ...(spec.moderation && {
      safety: { moderation: { values: ["auto", "low"], default: "auto", label: "Filtering" } },
    }),
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    // Not measured: nobody has run these yet. New accounts get 2 requests at once.
    limits: {
      ...(spec.maxPromptChars && { maxPromptChars: spec.maxPromptChars }),
      requestTimeoutMs: 600_000,
      typicalLatencyMs: [15_000, 90_000],
      maxConcurrent: 2,
    },
    controlOrder: CONTROL_ORDER,
    ...(spec.extras && { extraSchema: spec.extras }),
    emulated: spec.negativePrompt ? ["batch"] : ["batch", "negativePrompt"],
    ...(Object.keys(unsupported).length && { unsupported }),
    unsupportedParamPolicy: "drop-with-warning",
  };
}

// Quality ladders. The ids are the wire values; labels and hints are ours, as in the composer.
const LOW: QualityLevel = { id: "low", label: "Low", hint: "Fastest and cheapest" };
const MEDIUM: QualityLevel = { id: "medium", label: "Medium", hint: "Balanced" };
const HIGH: QualityLevel = { id: "high", label: "High", hint: "Sharpest detail" };
const XHIGH: QualityLevel = { id: "xhigh", label: "Extra high", hint: "Finer detail" };
const MAX: QualityLevel = { id: "max", label: "Max", hint: "Best quality" };

export const QUALITY = {
  studio: [LOW, MEDIUM, HIGH],
  studio25: [LOW, MEDIUM, HIGH, XHIGH, MAX],
  grok: [LOW, MEDIUM],
  ideogram: [
    { id: "TURBO", label: "Turbo", hint: "Fastest" },
    { id: "DEFAULT", label: "Default", hint: "Balanced" },
    { id: "QUALITY", label: "Quality", hint: "Sharpest detail" },
  ],
} satisfies Record<string, QualityLevel[]>;

// Advanced fields. SOUL's styles and trained characters are ids from Higgsfield; there's no list
// of them in Openfield yet, so they're pasted in (README.md).
const STYLE_ID = {
  type: "string",
  title: "Style ID",
  description: "A Higgsfield style. Leave it empty for the default style.",
  maxLength: 36,
} as const;
const STYLE_STRENGTH = {
  type: "number",
  title: "Style strength",
  description: "How strongly the style shows.",
  minimum: 0,
  maximum: 1,
  default: 1,
} as const;
const CHARACTER_ID = {
  type: "string",
  title: "Character ID",
  description: "A character you trained at Higgsfield.",
  maxLength: 36,
} as const;
const characterStrength = (minimum: number) =>
  ({
    type: "number",
    title: "Character strength",
    description: "How closely the image follows the character.",
    minimum,
    maximum: 1,
    default: 1,
  }) as const;

export const EXTRAS = {
  soul: {
    type: "object",
    properties: {
      styleId: STYLE_ID,
      styleStrength: STYLE_STRENGTH,
      characterId: CHARACTER_ID,
      characterStrength: characterStrength(0),
    },
  },
  // Style strength is accepted but has no effect on SOUL V2, and a character strength of 0 fails.
  soulV2: {
    type: "object",
    properties: { styleId: STYLE_ID, characterId: CHARACTER_ID, characterStrength: characterStrength(0.01) },
  },
  // SOUL Cinema has one fixed style.
  soulCinema: {
    type: "object",
    properties: { characterId: CHARACTER_ID, characterStrength: characterStrength(0) },
  },
  qwen: {
    type: "object",
    properties: {
      thinking: {
        type: "boolean",
        title: "Thinking",
        description: "Think about the prompt before drawing. Works only with Enhance on.",
        default: true,
      },
    },
  },
} satisfies Record<string, ExtraSchema>;

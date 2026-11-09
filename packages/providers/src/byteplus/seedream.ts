import type {
  AspectRatio,
  Capabilities,
  ControlId,
  ModelManifest,
  OutputFormat,
  PixelSize,
  PriceModel,
  ResolutionTier,
  SpeedOffer,
} from "@openfield/core";
import { MARK_KINDS, t } from "@openfield/core";
import { API_BASE } from "./capabilities";
import { SEEDREAM_PRICES } from "./pricing";

// Seedream on ModelArk: images from words, from up to 14 references, and edits, in one blocking
// call to /images/generations. Checked against the model list, the image generation API and
// tutorial, the 5.0 Pro / Flash tutorial and editing guide, and the pricing page on 2026-11-09
// (README.md, "Seedream"). Nothing here has run live yet.

export const IMAGES_URL = `${API_BASE}/images/generations`;

/** One Seedream model's wire rules. The manifest is built from this, so offers and payloads agree. */
export interface SeedreamSpec {
  modelId: string;
  /** Other ids BytePlus answers to for the same model. */
  aliases?: string[];
  displayName: string;
  /** Our own copy, 90 characters at most. */
  description: string;
  tiers: ResolutionTier[];
  defaultTier: ResolutionTier;
  /** Total pixels of an exact WxH size, inclusive. */
  pixels: [min: number, max: number];
  /** Every image one call takes: an edit's base and its references. */
  maxInputs: number;
  /** Lite, 4.5 and 4.0: inputs plus outputs at most 15, and the count as a related set. */
  group: boolean;
  /** output_format is a parameter (the 5.0 models); 4.5 and 4.0 always answer JPEG. */
  formats: OutputFormat[];
  /** background: "transparent" (Pro and Flash). */
  transparency: boolean;
  /** optimize_prompt_options.mode "fast" (Pro and 4.0). */
  fastPrompt: boolean;
  /** Layer separation and the interactive editing tags (Pro and Flash). */
  layers: boolean;
  price: PriceModel;
}

type Row = [AspectRatio, number, number];

// "Recommended width and height", per tier and ratio (image generation tutorial, 5.0 Pro tutorial).
const PRO_1K: Row[] = [
  ["1:1", 1024, 1024],
  ["4:3", 1152, 864],
  ["3:4", 864, 1152],
  ["16:9", 1424, 800],
  ["9:16", 800, 1424],
  ["3:2", 1248, 832],
  ["2:3", 832, 1248],
  ["21:9", 1568, 672],
];
const PRO_1_5K: Row[] = [
  ["1:1", 1536, 1536],
  ["4:3", 1792, 1344],
  ["3:4", 1344, 1792],
  ["16:9", 2048, 1152],
  ["9:16", 1152, 2048],
  ["3:2", 1872, 1248],
  ["2:3", 1248, 1872],
  ["21:9", 2352, 1008],
];
const PRO_2K: Row[] = [
  ["1:1", 2048, 2048],
  ["4:3", 2368, 1776],
  ["3:4", 1776, 2368],
  ["16:9", 2816, 1584],
  ["9:16", 1584, 2816],
  ["3:2", 2496, 1664],
  ["2:3", 1664, 2496],
  ["21:9", 3136, 1344],
];
const LITE_2K: Row[] = [
  ["1:1", 2048, 2048],
  ["4:3", 2304, 1728],
  ["3:4", 1728, 2304],
  ["16:9", 2848, 1600],
  ["9:16", 1600, 2848],
  ["3:2", 2496, 1664],
  ["2:3", 1664, 2496],
  ["21:9", 3136, 1344],
];
const LITE_3K: Row[] = [
  ["1:1", 3072, 3072],
  ["4:3", 3456, 2592],
  ["3:4", 2592, 3456],
  ["16:9", 4096, 2304],
  ["9:16", 2304, 4096],
  ["3:2", 3744, 2496],
  ["2:3", 2496, 3744],
  ["21:9", 4704, 2016],
];
const ALL_4K: Row[] = [
  ["1:1", 4096, 4096],
  ["4:3", 4704, 3520],
  ["3:4", 3520, 4704],
  ["16:9", 5504, 3040],
  ["9:16", 3040, 5504],
  ["3:2", 4992, 3328],
  ["2:3", 3328, 4992],
  ["21:9", 6240, 2656],
];
// 4.0's 1K is Pro's, except at 16:9 and 9:16.
const V40_1K: Row[] = PRO_1K.map(
  ([aspect, w, h]): Row =>
    aspect === "16:9" ? [aspect, 1312, 736] : aspect === "9:16" ? [aspect, 736, 1312] : [aspect, w, h],
);

const SIZE_TABLES: Record<string, Partial<Record<ResolutionTier, Row[]>>> = {
  pro: { "1K": PRO_1K, "1.5K": PRO_1_5K, "2K": PRO_2K },
  lite: { "2K": LITE_2K, "3K": LITE_3K, "4K": ALL_4K },
  "4.5": { "2K": LITE_2K, "4K": ALL_4K },
  "4.0": { "1K": V40_1K, "2K": LITE_2K, "4K": ALL_4K },
};

const TABLE_OF: Record<string, keyof typeof SIZE_TABLES> = {
  "dola-seedream-5-0-pro-260628": "pro",
  "dola-seedream-5-0-flash-260915": "pro",
  "seedream-5-0-260128": "lite",
  "seedream-4-5-251128": "4.5",
  "seedream-4-0-250828": "4.0",
};

/** The exact size BytePlus lists for a ratio at a tier, or undefined for "auto". */
export function seedreamSize(
  spec: SeedreamSpec,
  aspect: AspectRatio,
  tier: ResolutionTier,
): PixelSize | undefined {
  const row = SIZE_TABLES[TABLE_OF[spec.modelId]!]?.[tier]?.find(([a]) => a === aspect);
  return row && { width: row[1], height: row[2] };
}

/** In chip order. "auto" sends the tier alone, and the model picks the shape from the prompt. */
export const SEEDREAM_RATIOS: AspectRatio[] = [
  "auto",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
];

const PRO_PIXELS: [number, number] = [921_600, 4_624_220];
const LARGE_PIXELS: [number, number] = [3_686_400, 16_777_216];

export const SEEDREAM_SPECS: readonly SeedreamSpec[] = [
  {
    modelId: "dola-seedream-5-0-pro-260628",
    displayName: "Seedream 5.0 Pro",
    description: "Precise edits and layers",
    tiers: ["1K", "1.5K", "2K"],
    defaultTier: "1.5K",
    pixels: PRO_PIXELS,
    maxInputs: 10,
    group: false,
    formats: ["png", "jpeg"],
    transparency: true,
    fastPrompt: true,
    layers: true,
    price: SEEDREAM_PRICES["dola-seedream-5-0-pro-260628"],
  },
  {
    modelId: "dola-seedream-5-0-flash-260915",
    displayName: "Seedream 5.0 Flash",
    description: "Quick edits and layers",
    tiers: ["1K", "1.5K", "2K"],
    defaultTier: "1.5K",
    pixels: PRO_PIXELS,
    maxInputs: 10,
    group: false,
    formats: ["png", "jpeg"],
    transparency: true,
    fastPrompt: false,
    layers: true,
    price: SEEDREAM_PRICES["dola-seedream-5-0-flash-260915"],
  },
  {
    modelId: "seedream-5-0-260128",
    aliases: ["seedream-5-0-lite-260128"],
    displayName: "Seedream 5.0 Lite",
    description: "Image sets, up to 4K",
    tiers: ["2K", "3K", "4K"],
    defaultTier: "2K",
    pixels: LARGE_PIXELS,
    maxInputs: 14,
    group: true,
    formats: ["png", "jpeg"],
    transparency: false,
    fastPrompt: false,
    layers: false,
    price: SEEDREAM_PRICES["seedream-5-0-260128"],
  },
  {
    modelId: "seedream-4-5-251128",
    displayName: "Seedream 4.5",
    description: "Rich detail, image sets",
    tiers: ["2K", "4K"],
    defaultTier: "2K",
    pixels: LARGE_PIXELS,
    maxInputs: 14,
    group: true,
    formats: ["jpeg"],
    transparency: false,
    fastPrompt: false,
    layers: false,
    price: SEEDREAM_PRICES["seedream-4-5-251128"],
  },
  {
    modelId: "seedream-4-0-250828",
    displayName: "Seedream 4.0",
    description: "Fast, up to 4K",
    tiers: ["1K", "2K", "4K"],
    defaultTier: "2K",
    pixels: [921_600, 16_777_216],
    maxInputs: 14,
    group: true,
    formats: ["jpeg"],
    transparency: false,
    fastPrompt: true,
    layers: false,
    price: SEEDREAM_PRICES["seedream-4-0-250828"],
  },
];

const byId = new Map(SEEDREAM_SPECS.flatMap((s) => [s.modelId, ...(s.aliases ?? [])].map((id) => [id, s])));

export const seedreamSpecFor = (modelId: string): SeedreamSpec | undefined => byId.get(modelId);

/** Inputs plus outputs, at most, on the models that make related sets. */
export const GROUP_LIMIT = 15;
/** The Advanced toggle that sends a run's count as one related set. */
export const GROUP_OPTION = "relatedSet";
/** "Up to 30 MB" per input image, and its total pixels at most. */
export const INPUT_MAX_BYTES = 30 * 1024 * 1024;
export const INPUT_MAX_PIXELS = 36_000_000;
/** What Openfield stores, all of which BytePlus reads. */
export const INPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** An image's width over height, at most, in and out: [1/16, 16]. */
export const MAX_RATIO = 16;

/**
 * Fast is Seedream's lighter prompt rewrite. Openfield has no speed id for it, so it rides on the
 * Priority id with BytePlus's own label, at the Standard price: nothing on the pricing page
 * charges for it.
 */
function fastOffer(spec: SeedreamSpec): SpeedOffer {
  return {
    id: "priority",
    label: "Fast",
    price: spec.price,
    delivery: "sync",
    // Not measured; drives copy only.
    waitMs: { target: 15_000, max: 120_000 },
  };
}

export function seedreamCapabilities(spec: SeedreamSpec): Capabilities {
  const [minPixels, maxPixels] = spec.pixels;
  const controls: ControlId[] = [
    "model",
    "aspect",
    "resolution",
    "batch",
    ...(spec.transparency ? (["background"] as const) : []),
    "negativePrompt",
    "seed",
    ...(spec.formats.length > 1 ? (["outputFormat"] as const) : []),
    ...(spec.group ? (["advanced"] as const) : []),
  ];
  return {
    ops: {
      textToImage: true,
      // The base goes in as the first image, and the prompt says what to change.
      imageEdit: true,
      // No mask parameter: a masked edit runs on the whole image and the composite keeps the rest.
      inpaint: false,
      outpaint: false,
      upscale: false,
      removeBackground: false,
      detectText: false,
      decomposeLayers: spec.layers,
    },
    references: {
      supported: true,
      max: spec.maxInputs,
      roles: ["subject", "style", "composition", "palette"],
      mimeTypes: INPUT_MIME_TYPES,
      maxBytes: INPUT_MAX_BYTES,
      maxPixels: INPUT_MAX_PIXELS,
      weights: false,
      strengthMode: "none",
      maxInputs: spec.maxInputs,
      ...(spec.group && { maxInputsAndOutputs: GROUP_LIMIT }),
    },
    size: {
      mode: "aspect",
      ratios: SEEDREAM_RATIOS,
      default: "1:1",
      // Exact sizes, so an edit can keep its base's shape. No grid is documented, only these.
      pixels: {
        multipleOf: 1,
        maxEdge: Math.min(16_384, Math.floor(Math.sqrt(maxPixels * MAX_RATIO))),
        maxRatio: MAX_RATIO,
        minPixels,
        maxPixels,
      },
    },
    resolution: { tiers: spec.tiers, default: spec.defaultTier },
    // One image per call unless it's a related set, so a moderated image fails on its own.
    batch: { max: 4, native: false, ...(spec.group && { groupOption: GROUP_OPTION }) },
    seed: { supported: false, echoed: false },
    negativePrompt: false,
    promptEnhance: "openfield",
    styleStrength: false,
    ...(spec.transparency && {
      background: { values: ["auto", "opaque", "transparent"], default: "auto" as const },
    }),
    transparency: spec.transparency,
    // Lite, 4.5 and 4.0 can stream a related set, which Openfield doesn't use yet.
    streaming: { partialImages: false, progressPercent: false },
    output: { formats: spec.formats, default: spec.formats[0]! },
    identity: { nativeCharacterRefs: false, nativeStylePresets: false },
    limits: {
      // A separation makes up to 17 images in one call.
      requestTimeoutMs: spec.layers ? 300_000 : 180_000,
      // Not measured: nobody has run these live yet.
      typicalLatencyMs: [10_000, 90_000],
      maxConcurrent: 4,
    },
    controlOrder: controls,
    emulated: ["negativePrompt"],
    unsupported: { seed: { reason: t("composer.chips.seed.unsupported", { model: spec.displayName }) } },
    ...(spec.group && {
      extraSchema: {
        type: "object" as const,
        properties: {
          [GROUP_OPTION]: {
            type: "boolean" as const,
            title: "Related set",
            description:
              "Make the images as one set that belongs together, like the panels of a story. The model may make fewer than you ask for, and you pay only for those.",
            default: false,
          },
        },
      },
    }),
    unsupportedParamPolicy: "drop-with-warning",
    ...(spec.layers && {
      marks: { kinds: [...MARK_KINDS], max: 20 },
      layers: {
        sizes: ["auto", "1K", "1.5K", "2K"],
        default: "auto" as const,
        mimeTypes: ["image/png", "image/jpeg"],
        maxBytes: INPUT_MAX_BYTES,
        minPixels: 262_144,
        maxPixels: INPUT_MAX_PIXELS,
        maxRatio: MAX_RATIO,
        maxLayers: 16,
      },
    }),
  };
}

export function seedreamManifest(spec: SeedreamSpec): ModelManifest {
  return {
    key: `byteplus:${spec.modelId}`,
    providerId: "byteplus",
    modelId: spec.modelId,
    displayName: spec.displayName,
    description: spec.description,
    family: "Seedream",
    modality: "image",
    ...(spec.layers && { badges: ["new" as const] }),
    capabilities: seedreamCapabilities(spec),
    price: spec.price,
    ...(spec.fastPrompt && { speeds: [fastOffer(spec)] }),
    source: "static",
    manifestVersion: "1",
    fetchedAt: "2026-11-09",
  };
}

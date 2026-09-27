import type { AspectRatio, ModelManifest } from "@openfield/core";
import { EXTRAS, higgsfieldCapabilities, QUALITY, type WireSpec } from "./capabilities";
import { PRICE } from "./pricing";

// The static catalog: every text-to-image workflow in Higgsfield's public API catalog
// (docs.higgsfield.ai/docs/models/image-generation, 16 entries as of 2026-09-22), checked on
// 2026-09-27. Left out: Soul ID trains a character rather than making an image, and Qwen Image 3
// edit needs input images, which wait on the upload host (README.md).
//
// Each model's ratios are its documented ones that Openfield can draw. Qwen Image 3 and Z-Image
// Turbo also take 7:9 and 9:7, and Ideogram 4.0 twelve more; they're listed in README.md.

const SOUL_RATIOS: AspectRatio[] = ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"];
const STUDIO_RATIOS: AspectRatio[] = ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"];
const RECRAFT_RATIOS: AspectRatio[] = [
  "1:1",
  "3:4",
  "4:3",
  "2:3",
  "3:2",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "1:2",
  "2:1",
  "6:10",
  "14:10",
  "10:14",
];
const QWEN_RATIOS: AspectRatio[] = ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"];

// SOUL's 720p and 1080p sit on our 1K and 2K chips; the others' own 1k/2k/4k line up by name.
const SOUL_SIZES = { "1K": "720p", "2K": "1080p" } as const;
const SOUL_SEED: [number, number] = [1, 1_000_000];
const WIDE_SEED: [number, number] = [0, 2_147_483_647];

export const SPECS: readonly WireSpec[] = [
  {
    modelId: "soul",
    path: "higgsfield-ai/soul/standard",
    displayName: "SOUL",
    description: "Styled portraits and fashion, with Higgsfield's styles.",
    family: "SOUL",
    ratios: SOUL_RATIOS,
    defaultRatio: "4:3",
    resolutions: SOUL_SIZES,
    defaultTier: "1K",
    seed: SOUL_SEED,
    enhance: "enhance_prompt",
    extras: EXTRAS.soul,
  },
  {
    modelId: "soul-v2",
    path: "higgsfield-ai/soul/v2/standard",
    displayName: "SOUL V2",
    description: "Portraits, fashion and editorial images.",
    family: "SOUL",
    ratios: SOUL_RATIOS,
    defaultRatio: "1:1",
    resolutions: SOUL_SIZES,
    defaultTier: "1K",
    seed: SOUL_SEED,
    enhance: "enhance_prompt",
    extras: EXTRAS.soulV2,
  },
  {
    modelId: "soul-cinema",
    path: "higgsfield-ai/soul/cinema",
    displayName: "SOUL Cinema",
    description: "Stills with a cinematic look.",
    family: "SOUL",
    ratios: SOUL_RATIOS,
    defaultRatio: "1:1",
    resolutions: SOUL_SIZES,
    defaultTier: "1K",
    seed: SOUL_SEED,
    enhance: "enhance_prompt",
    extras: EXTRAS.soulCinema,
  },
  {
    modelId: "marketing-studio-image",
    path: "marketing-studio/image",
    displayName: "Marketing Studio Image 2.0 Alpha",
    description: "Campaign and product images, up to 4K.",
    family: "Marketing Studio Image",
    ratios: STUDIO_RATIOS,
    defaultRatio: "auto",
    resolutions: { "1K": "1k", "2K": "2k", "4K": "4k" },
    defaultTier: "2K",
    quality: { field: "quality", levels: QUALITY.studio, default: "high" },
    moderation: true,
    maxPromptChars: 5000,
  },
  {
    modelId: "marketing-studio-image-2.5-flare",
    path: "marketing-studio/image/flare",
    displayName: "Marketing Studio Image 2.5 Flare",
    description: "Fast campaign and product images, up to 4K.",
    family: "Marketing Studio Image",
    ratios: STUDIO_RATIOS,
    defaultRatio: "auto",
    resolutions: { "1K": "1k", "2K": "2k", "4K": "4k" },
    defaultTier: "2K",
    quality: { field: "quality", levels: QUALITY.studio25, default: "high" },
    moderation: true,
    maxPromptChars: 5000,
  },
  {
    modelId: "marketing-studio-image-2.5-sunburst",
    path: "marketing-studio/image/sunburst",
    displayName: "Marketing Studio Image 2.5 Sunburst",
    description: "The most detailed campaign images, up to 4K.",
    family: "Marketing Studio Image",
    ratios: STUDIO_RATIOS,
    defaultRatio: "auto",
    resolutions: { "1K": "1k", "2K": "2k", "4K": "4k" },
    defaultTier: "2K",
    quality: { field: "quality", levels: QUALITY.studio25, default: "high" },
    moderation: true,
    maxPromptChars: 5000,
  },
  {
    modelId: "grok-imagine-image-2.0",
    path: "xai/grok-imagine-image-2.0",
    displayName: "Grok Image 2.0",
    description: "xAI's image model, at 1K or 2K.",
    family: "Grok",
    ratios: ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "1:2", "2:1"],
    defaultRatio: "auto",
    resolutions: { "1K": "1k", "2K": "2k" },
    defaultTier: "1K",
    quality: { field: "quality", levels: QUALITY.grok, default: "medium" },
  },
  {
    modelId: "recraft-v4.1",
    path: "recraft/v4.1/text-to-image",
    displayName: "Recraft V4.1",
    description: "Design-minded images at 1K.",
    family: "Recraft",
    ratios: RECRAFT_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "1K": "1k" },
    outputFormats: true,
    maxPromptChars: 10_000,
  },
  {
    modelId: "recraft-v4.1-utility",
    path: "recraft/v4.1/utility/text-to-image",
    displayName: "Recraft V4.1 Utility",
    description: "Recraft's utility model at 1K.",
    family: "Recraft",
    ratios: RECRAFT_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "1K": "1k" },
    outputFormats: true,
    maxPromptChars: 10_000,
  },
  {
    modelId: "recraft-v4.1-pro",
    path: "recraft/v4.1/pro/text-to-image",
    displayName: "Recraft V4.1 Pro",
    description: "Design-minded images at 2K.",
    family: "Recraft",
    ratios: RECRAFT_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "2K": "2k" },
    outputFormats: true,
    maxPromptChars: 10_000,
  },
  {
    modelId: "recraft-v4.1-utility-pro",
    path: "recraft/v4.1/utility/pro/text-to-image",
    displayName: "Recraft V4.1 Utility Pro",
    description: "Recraft's utility model at 2K.",
    family: "Recraft",
    ratios: RECRAFT_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "2K": "2k" },
    outputFormats: true,
    maxPromptChars: 10_000,
  },
  {
    modelId: "qwen-image-3",
    path: "alibaba/qwen-image-3/text-to-image",
    displayName: "Qwen Image 3",
    description: "Alibaba's model, with prompt rewriting and thinking.",
    family: "Qwen",
    ratios: QWEN_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "1K": "1k", "2K": "2k" },
    defaultTier: "1K",
    seed: WIDE_SEED,
    negativePrompt: true,
    enhance: "prompt_extend",
    extras: EXTRAS.qwen,
  },
  {
    modelId: "ideogram-4.0",
    path: "ideogram/v4.0",
    displayName: "Ideogram 4.0",
    description: "Strong at lettering and layout.",
    family: "Ideogram",
    ratios: ["1:1", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4", "9:16", "16:9", "1:2", "2:1"],
    defaultRatio: "1:1",
    quality: { field: "rendering_speed", levels: QUALITY.ideogram, default: "DEFAULT" },
    maxPromptChars: 2048,
  },
  {
    modelId: "z-image-turbo",
    path: "z-image/turbo",
    displayName: "Z-Image Turbo",
    description: "Quick and cheap, at 1K or 2K.",
    family: "Z-Image",
    ratios: QWEN_RATIOS,
    defaultRatio: "1:1",
    resolutions: { "1K": "1k", "2K": "2k" },
    defaultTier: "1K",
    seed: WIDE_SEED,
    enhance: "prompt_extend",
    maxPromptChars: 800,
  },
];

const bySlug = new Map(SPECS.map((s) => [s.modelId, s]));

export const specFor = (modelId: string): WireSpec | undefined => bySlug.get(modelId);

function manifestOf(spec: WireSpec): ModelManifest {
  return {
    key: `higgsfield:${spec.modelId}`,
    providerId: "higgsfield",
    modelId: spec.modelId,
    displayName: spec.displayName,
    description: spec.description,
    family: spec.family,
    capabilities: higgsfieldCapabilities(spec),
    price: PRICE,
    // A queue: the request id arrives at once and is read later, so a restart picks the image up.
    resumableSpeeds: ["standard"],
    source: "static",
    manifestVersion: "1",
    fetchedAt: "2026-09-27",
  };
}

export const HIGGSFIELD_MODELS: readonly ModelManifest[] = SPECS.map(manifestOf);

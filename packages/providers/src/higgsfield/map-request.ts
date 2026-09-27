import type { NormalizedRequest } from "@openfield/core";
import type { WireSpec } from "./capabilities";

// NormalizedRequest to one workflow's JSON body. Pure, so golden tests can snapshot it. Field names
// and values are each workflow's own, from its schema on docs.higgsfield.ai. Anything left out
// takes the workflow's default. batch_size is never sent: every call makes one image.

export type HiggsfieldBody = Record<string, string | number | boolean>;

/** Advanced fields to their wire names. The same names mean the same thing on every SOUL workflow. */
const EXTRA_FIELDS = {
  styleId: "style_id",
  styleStrength: "style_strength",
  characterId: "custom_reference_id",
  characterStrength: "custom_reference_strength",
} as const;

export function toHiggsfieldBody(spec: WireSpec, req: NormalizedRequest): HiggsfieldBody {
  const body: HiggsfieldBody = { prompt: req.promptAfterPreset.trim() };

  const aspect = "aspect" in req.size ? req.size.aspect : undefined;
  if (aspect && spec.ratios.includes(aspect)) body.aspect_ratio = aspect;

  const tier = req.resolution ?? spec.defaultTier;
  const resolution = tier && spec.resolutions?.[tier];
  if (resolution) body.resolution = resolution;

  if (spec.quality) {
    const quality = req.quality ?? spec.quality.default;
    if (spec.quality.levels.some((l) => l.id === quality)) body[spec.quality.field] = quality;
  }

  if (spec.seed && typeof req.seed === "number") {
    const [low, high] = spec.seed;
    body.seed = Math.min(high, Math.max(low, Math.trunc(req.seed)));
  }

  if (spec.negativePrompt && req.negativePrompt?.trim()) body.negative_prompt = req.negativePrompt.trim();

  // Only a choice the person made goes out; otherwise the workflow's own default stands.
  if (spec.enhance && typeof req.enhancePrompt === "boolean") {
    body[spec.enhance] = req.enhancePrompt;
    // Qwen's thinking needs its prompt rewriting on, so both go off together.
    if ("thinking" in (spec.extras?.properties ?? {})) {
      body.enable_thinking = req.enhancePrompt && req.providerOptions?.thinking !== false;
    }
  }

  if (spec.moderation && (req.moderation === "auto" || req.moderation === "low")) {
    body.moderation = req.moderation;
  }
  // Recraft spells JPEG "jpg".
  if (spec.outputFormats && req.output)
    body.output_format = req.output.format === "jpeg" ? "jpg" : req.output.format;

  const declared = spec.extras?.properties ?? {};
  for (const [option, wire] of Object.entries(EXTRA_FIELDS)) {
    if (!(option in declared)) continue;
    const value = req.providerOptions?.[option];
    if (typeof value === "string" && value.trim()) body[wire] = value.trim();
    if (typeof value === "number" && Number.isFinite(value)) body[wire] = value;
  }
  return body;
}

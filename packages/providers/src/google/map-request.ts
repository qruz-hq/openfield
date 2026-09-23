import type { AspectRatio, ModelManifest, NormalizedRequest, SpeedId } from "@openfield/core";

// NormalizedRequest to a generateContent body. Pure, so golden tests can snapshot it.
//
// generateContent, not the newer Interactions API: Google says generateContent "remains fully
// supported", it's stateless (Interactions stores history unless told not to), and it's what
// the PRD specifies. Field names are the camelCase JSON form from the API reference.

export interface InlineImage {
  mimeType: string;
  /** Base64. Built inside the adapter from ctx.assets bytes, never passed in by callers. */
  data: string;
}

/** A file uploaded once through the Files API, used by batch requests over the inline size limit. */
export interface FileRef {
  mimeType: string;
  fileUri: string;
}

export type GeminiPart = { text: string } | { inlineData: InlineImage } | { fileData: FileRef };

/** The generateContent value for a sync speed. Standard leaves the field out; Batch has its own endpoint. */
export type ServiceTier = "flex" | "priority";

export interface GeminiRequest {
  contents: { role: "user"; parts: GeminiPart[] }[];
  generationConfig: {
    // Image only: no conversational text to pay for or throw away.
    responseModalities: ["IMAGE"];
    imageConfig?: { aspectRatio?: string; imageSize?: string };
    thinkingConfig?: { thinkingLevel: "MINIMAL" | "HIGH" };
  };
  tools?: { googleSearch: Record<string, never> }[];
  /** Top level, beside contents, never inside generationConfig (§6.13). */
  serviceTier?: ServiceTier;
}

export function serviceTierFor(speed: SpeedId): ServiceTier | undefined {
  return speed === "flex" || speed === "priority" ? speed : undefined;
}

/**
 * `images` is the edit base (when there is one) followed by the references, in order. Their
 * roles are already written into the prompt (§0.8); Gemini has no per-image role field.
 */
export function toGeminiRequest(
  manifest: ModelManifest,
  req: NormalizedRequest,
  images: InlineImage[],
  opts: { serviceTier?: ServiceTier } = {},
): GeminiRequest {
  const caps = manifest.capabilities;
  const parts: GeminiPart[] = [];
  const prompt = req.promptAfterPreset.trim();
  if (prompt) parts.push({ text: prompt });
  for (const image of images) parts.push({ inlineData: image });

  const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
  const aspect = aspectOf(req);
  if (aspect && aspect !== "auto") imageConfig.aspectRatio = aspect;
  // Tier names match the wire values ("512", "1K", "2K", "4K"; uppercase K is required).
  // A single-tier model gets no imageSize, in case it rejects a setting it doesn't offer.
  const tiers = caps.resolution?.tiers ?? [];
  if (req.resolution && tiers.length > 1 && tiers.includes(req.resolution))
    imageConfig.imageSize = req.resolution;

  const body: GeminiRequest = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  if (Object.keys(imageConfig).length) body.generationConfig.imageConfig = imageConfig;

  // Advanced fields, only when this model declares them. The ThinkingLevel enum names are the
  // canonical JSON values; the guides show lowercase in other request styles.
  const extras = caps.extraSchema?.properties ?? {};
  const thinking = req.providerOptions?.thinking;
  if ("thinking" in extras && (thinking === "minimal" || thinking === "high")) {
    body.generationConfig.thinkingConfig = { thinkingLevel: thinking === "high" ? "HIGH" : "MINIMAL" };
  }
  if ("grounding" in extras && req.providerOptions?.grounding === true) body.tools = [{ googleSearch: {} }];
  if (opts.serviceTier) body.serviceTier = opts.serviceTier;

  return body;
}

function aspectOf(req: NormalizedRequest): AspectRatio | undefined {
  return "aspect" in req.size ? req.size.aspect : undefined;
}

import type { ModelManifest, NormalizedRequest, ResolutionTier } from "@openfield/core";
import { openAiSize } from "./capabilities";

// NormalizedRequest to Image API fields. Pure, so golden tests can snapshot it. Generations take
// JSON; edits (an edit, an inpaint, or a generation with references) take the same fields as
// multipart form values beside the images.

export interface ImageFields {
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
}

/** Which endpoint a request goes to. Any input image means /v1/images/edits. */
export function endpointFor(req: NormalizedRequest): "generations" | "edits" {
  return req.op === "edit" || req.op === "inpaint" || (req.references?.length ?? 0) > 0
    ? "edits"
    : "generations";
}

export function toImageFields(manifest: ModelManifest, req: NormalizedRequest): ImageFields {
  const caps = manifest.capabilities;
  const tier = (req.resolution ?? caps.resolution?.default ?? "1K") as ResolutionTier;
  const size = "aspect" in req.size ? openAiSize(req.size.aspect, tier) : req.size;
  const fields: ImageFields = {
    model: manifest.modelId,
    prompt: req.promptAfterPreset.trim(),
    n: Math.max(1, req.batch),
    size: size === "auto" ? "auto" : `${size.width}x${size.height}`,
  };
  if (req.quality) fields.quality = req.quality;
  if (req.background && caps.background?.values.includes(req.background)) fields.background = req.background;
  const format = req.output?.format;
  if (format) fields.output_format = format;
  // Compression only means something for the lossy formats.
  if ((format === "jpeg" || format === "webp") && req.output?.compression !== undefined) {
    fields.output_compression = req.output.compression;
  }
  if (req.moderation) fields.moderation = req.moderation;
  return fields;
}

/** The fields as multipart values: strings, as a form carries them. */
export function toFormValues(fields: ImageFields): [string, string][] {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)]);
}

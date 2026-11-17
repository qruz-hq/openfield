import type { NormalizedRequest, ResolutionTier } from "@openfield/core";
import { promptWithMarks } from "./marks";
import {
  DEFAULT_CHOSEN_LAYERS,
  GROUP_LIMIT,
  GROUP_OPTION,
  type SeedreamSpec,
  seedreamSize,
} from "./seedream";

// NormalizedRequest to the body of POST /images/generations. Pure, so golden tests can snapshot it.
// Images arrive already read, as data URLs (the base first, then the references), because the
// request only names their ids. Fields a model doesn't list are never sent: whether BytePlus
// ignores or refuses them isn't documented, so the payload stays inside what each model takes.

export interface SeedreamBody {
  model: string;
  prompt?: string;
  image?: string | string[];
  size: string;
  output_format?: "png" | "jpeg";
  background?: "transparent" | "opaque";
  optimize_prompt_options?: { mode: "fast" };
  sequential_image_generation?: "auto";
  sequential_image_generation_options?: { max_images: number };
  layer_decomposition?: true;
  /** 5.5 only. max_images counts the base as well as the layers. */
  layer_decomposition_options?: { max_images: number; text_recognition: true };
  // Inline data, so no download host is needed. The URL form lasts 24 hours on an undocumented host.
  response_format: "b64_json";
  // On by default at BytePlus: an "AI generated" mark in the corner.
  watermark: false;
}

/** The size field: the exact WxH for a ratio at a tier, an exact size as asked, or the tier alone. */
export function wireSize(spec: SeedreamSpec, req: Pick<NormalizedRequest, "size" | "resolution">): string {
  const tier = (req.resolution ?? spec.defaultTier) as ResolutionTier;
  if ("width" in req.size) return `${req.size.width}x${req.size.height}`;
  const exact = req.size.aspect === "auto" ? undefined : seedreamSize(spec, req.size.aspect, tier);
  // "auto" goes as the tier, and the model takes the shape from the prompt (Method 1).
  return exact ? `${exact.width}x${exact.height}` : tier;
}

export interface SeedreamInputs {
  /** Data URLs, in the order the prompt counts them: "Image 1" first. */
  images: string[];
  /** A transparent background was asked for, and the model can make one from these images. */
  transparent?: boolean;
  /** An opaque background was asked for, on a model whose own default isn't opaque. */
  opaque?: boolean;
}

export function toSeedreamBody(
  spec: SeedreamSpec,
  req: NormalizedRequest,
  inputs: SeedreamInputs,
  opts: { fast: boolean },
): SeedreamBody {
  const { prompt } = promptWithMarks(req.promptAfterPreset.trim(), req.marks);
  const body: SeedreamBody = {
    model: spec.modelId,
    prompt,
    size: wireSize(spec, req),
    response_format: "b64_json",
    watermark: false,
  };
  if (inputs.images.length) body.image = inputs.images.length === 1 ? inputs.images[0]! : inputs.images;
  // 4.5 and 4.0 take no output_format. A transparent result is always a PNG: JPEG with it is an error.
  if (spec.formats.length > 1) {
    const asked = req.output?.format === "jpeg" ? "jpeg" : "png";
    body.output_format = inputs.transparent ? "png" : asked;
  }
  if (inputs.transparent) body.background = "transparent";
  else if (inputs.opaque) body.background = "opaque";
  if (opts.fast && spec.fastPrompt) body.optimize_prompt_options = { mode: "fast" };
  if (spec.group && req.batch > 1 && req.providerOptions?.[GROUP_OPTION] === true) {
    body.sequential_image_generation = "auto";
    body.sequential_image_generation_options = {
      max_images: Math.min(req.batch, GROUP_LIMIT - inputs.images.length),
    };
  }
  return body;
}

/**
 * A separation: one image in, a base and its layers out. The prompt is optional. Never a background:
 * layers are always transparent PNGs, and BytePlus refuses the field on a separation.
 */
export function toLayersBody(spec: SeedreamSpec, req: NormalizedRequest, image: string): SeedreamBody {
  const prompt = req.promptAfterPreset.trim();
  const most = Math.min(spec.maxLayers, Math.max(1, req.layers?.maxLayers ?? DEFAULT_CHOSEN_LAYERS));
  return {
    model: spec.modelId,
    ...(prompt && { prompt }),
    image,
    layer_decomposition: true,
    // The words on each text layer come back with it, to show beside the layer.
    ...(spec.layerOptions && {
      layer_decomposition_options: { max_images: most + 1, text_recognition: true as const },
    }),
    size: req.layers?.size ?? "auto",
    // Only the base takes this; layers are always PNGs with transparency.
    output_format: "png",
    response_format: "b64_json",
    watermark: false,
  };
}

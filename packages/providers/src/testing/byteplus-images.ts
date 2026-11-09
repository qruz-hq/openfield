import badKey from "../byteplus/__fixtures__/bad-key.json";
import { LAST_FRAME_JPEG } from "../byteplus/__fixtures__/media";
import overdue from "../byteplus/__fixtures__/overdue.json";
import overloaded from "../byteplus/__fixtures__/overloaded.json";
import groupPartial from "../byteplus/__fixtures__/seedream/group-partial.json";
import invalid from "../byteplus/__fixtures__/seedream/invalid.json";
import ipmLimited from "../byteplus/__fixtures__/seedream/ipm-rate-limited.json";
import layersFailed from "../byteplus/__fixtures__/seedream/layers-failed.json";
import notOpen from "../byteplus/__fixtures__/seedream/not-open.json";
import outputFlagged from "../byteplus/__fixtures__/seedream/output-flagged.json";
import serverError from "../byteplus/__fixtures__/server-error.json";
import { encodeRgbaPng, gradientPng, hashString, pngHasTransparency } from "./png";
import { type FakeEnv, type FakeScenario, type RecordedExchange, replay, taggedScenario } from "./types";

// A stand-in for ModelArk's /images/generations (Seedream). Every body is checked against the image
// generation API reference, written out below rather than read from our manifests, so a manifest
// that offers something a model doesn't take fails the conformance suite. Stricter than the real
// API: a field a model doesn't list is refused, because whether BytePlus ignores it isn't known.
//
// Images come back as b64_json, tiny but with the size BytePlus would report in data[].size: PNGs
// on the 5.0 models, JPEGs on 4.5 and 4.0, which always answer JPEG.

export const IMAGES_PATH = "/api/v3/images/generations";

interface ImageRules {
  tiers: string[];
  pixels: [number, number];
  maxImages: number;
  outputFormat: boolean;
  transparent: boolean;
  fast: boolean;
  sequential: boolean;
  layers: boolean;
  /** usage.input_images is reported on 5.0 Pro and Flash only. */
  reportsInputs: boolean;
}

// From "Image generation API" and the 5.0 Pro / Flash tutorial, 2026-11-09.
const PRO: ImageRules = {
  tiers: ["1K", "1.5K", "2K"],
  pixels: [921_600, 4_624_220],
  maxImages: 10,
  outputFormat: true,
  transparent: true,
  fast: true,
  sequential: false,
  layers: true,
  reportsInputs: true,
};
const LARGE = { pixels: [3_686_400, 16_777_216] as [number, number], maxImages: 14, sequential: true };
const MODELS: Record<string, ImageRules> = {
  "dola-seedream-5-0-pro-260628": PRO,
  "dola-seedream-5-0-flash-260915": { ...PRO, fast: false },
  "seedream-5-0-260128": {
    ...LARGE,
    tiers: ["2K", "3K", "4K"],
    outputFormat: true,
    transparent: false,
    fast: false,
    layers: false,
    reportsInputs: false,
  },
  "seedream-4-5-251128": {
    ...LARGE,
    tiers: ["2K", "4K"],
    outputFormat: false,
    transparent: false,
    fast: false,
    layers: false,
    reportsInputs: false,
  },
  "seedream-4-0-250828": {
    ...LARGE,
    tiers: ["1K", "2K", "4K"],
    pixels: [921_600, 16_777_216],
    outputFormat: false,
    transparent: false,
    fast: true,
    layers: false,
    reportsInputs: false,
  },
};
MODELS["seedream-5-0-lite-260128"] = MODELS["seedream-5-0-260128"]!;

const FIELDS = new Set([
  "model",
  "prompt",
  "image",
  "layer_decomposition",
  "size",
  "optimize_prompt_options",
  "output_format",
  "background",
  "response_format",
  "sequential_image_generation",
  "sequential_image_generation_options",
  "stream",
  "watermark",
]);

/** The square size of each tier, which is what "2K" alone comes back at. */
const TIER_EDGE: Record<string, number> = { "1K": 1024, "1.5K": 1536, "2K": 2048, "3K": 3072, "4K": 4096 };

const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden: notOpen,
  no_billing: overdue,
  invalid,
  rate_limited: ipmLimited,
  server_error: serverError,
  unavailable: overloaded,
  refused: outputFlagged,
  failed: layersFailed,
};

export async function handleImages(request: Request, env: FakeEnv, forced: FakeScenario | undefined) {
  const failure = forced && fixtures[forced];
  if (failure) return replay(failure);
  if (request.method !== "POST") return error(405, "MethodNotAllowed", "Method not allowed");
  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const problem = validate(body);
  if (problem) return problem;
  const prompt = typeof body!.prompt === "string" ? body!.prompt : "";
  const scenario = taggedScenario(prompt);
  const tagged = scenario && fixtures[scenario];
  if (tagged) return replay(tagged);
  return body!.layer_decomposition === true ? layers(body!, env) : images(body!, prompt, scenario, env);
}

async function images(
  body: Record<string, unknown>,
  prompt: string,
  scenario: FakeScenario | undefined,
  env: FakeEnv,
): Promise<Response> {
  const rules = MODELS[String(body.model)]!;
  const inputs = imagesOf(body).length;
  const asked =
    body.sequential_image_generation === "auto"
      ? ((body.sequential_image_generation_options as { max_images?: number } | undefined)?.max_images ?? 15)
      : 1;
  // no_image: one image short, so a related set comes back short and a single call comes back empty.
  const count = scenario === "no_image" ? asked - 1 : asked;
  const [width, height] = reportedSize(String(body.size));
  const jpeg = !rules.outputFormat || body.output_format === "jpeg";
  const data: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    // batch_partial: the second image of a set is moderated, as group-partial.json shows.
    if (scenario === "batch_partial" && i === 1) {
      data.push({ error: (groupPartial.response.body.data[1] as { error: unknown }).error });
      continue;
    }
    const seed = hashString(prompt) + env.nextSeed() * 7919 + i;
    const bytes = jpeg ? distinctJpeg(seed) : await gradientPng(...fitted(width, height, env.maxEdge), seed);
    data.push({
      b64_json: Buffer.from(bytes).toString("base64"),
      size: `${width}x${height}`,
      ...(rules.outputFormat && { output_format: jpeg ? "jpeg" : "png" }),
    });
  }
  const made = data.filter((d) => d.b64_json).length;
  const tokens = Math.round((made * width * height) / 256);
  return json(200, {
    model: body.model,
    created: Math.floor(env.now() / 1000),
    data,
    usage: {
      generated_images: made,
      ...(rules.reportsInputs && { input_images: inputs }),
      output_tokens: tokens,
      total_tokens: tokens,
    },
  });
}

/**
 * A base and three layers, each cropped to its own box, with sizes a pixel off as the docs show.
 * "#fake-layers:N" in the prompt makes only the first N (1 to 3), as a rerun that finds fewer would.
 */
async function layers(body: Record<string, unknown>, env: FakeEnv): Promise<Response> {
  const tier = String(body.size ?? "auto");
  const edge = tier === "auto" ? 2048 : TIER_EDGE[tier]!;
  const canvas = { width: edge, height: edge };
  const all: [number, number, number, number][] = [
    [0.1, 0.05, 0.8, 0.2],
    [0.2, 0.35, 0.65, 0.98],
    [0.22, 0.43, 0.78, 1],
  ];
  const asked = Number(/#fake-layers:(\d)/.exec(String(body.prompt ?? ""))?.[1] ?? all.length);
  const boxes = all.slice(0, Math.min(all.length, Math.max(1, asked)));
  const data: Record<string, unknown>[] = [
    {
      b64_json: Buffer.from(await gradientPng(...fitted(edge, edge, env.maxEdge), env.nextSeed())).toString(
        "base64",
      ),
      size: `${canvas.width}x${canvas.height}`,
      output_format: "png",
      z_index: 0,
    },
  ];
  for (const [i, [l, t, r, b]] of boxes.entries()) {
    const absolute = [l * edge, t * edge, r * edge, b * edge].map(Math.round);
    const w = absolute[2]! - absolute[0]!;
    const h = absolute[3]! - absolute[1]!;
    const [pw, ph] = fitted(w, h, env.maxEdge);
    const rgba = new Uint8Array(pw * ph * 4);
    for (let p = 0; p < pw * ph; p++) {
      rgba.set([40 + i * 60, 200 - i * 50, 120, p % 3 === 0 ? 0 : 255], p * 4);
    }
    data.push({
      b64_json: Buffer.from(await encodeRgbaPng(pw, ph, rgba)).toString("base64"),
      size: `${w + 1}x${h + 1}`,
      output_format: "png",
      z_index: i + 1,
      bounding_box: { absolute, normalized: [l, t, r, b].map((v) => Math.round(v * 1000)) },
      name: `Layer ${i + 1}`,
      description: `Part ${i + 1} of the picture`,
    });
  }
  const tokens = Math.round((edge * edge * 2) / 256);
  return json(200, {
    model: body.model,
    created: Math.floor(env.now() / 1000),
    data,
    usage: { input_images: 1, generated_images: data.length, output_tokens: tokens, total_tokens: tokens },
  });
}

/** What data[].size says: the WxH asked for, or a tier's square. */
function reportedSize(size: string): [number, number] {
  const exact = /^(\d+)x(\d+)$/.exec(size);
  if (exact) return [Number(exact[1]), Number(exact[2])];
  const edge = TIER_EDGE[size] ?? 2048;
  return [edge, edge];
}

/** The same shape, at most `max` on its long side, so fake images stay tiny. */
function fitted(width: number, height: number, max: number): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** The fixture JPEG with a comment that makes each one's bytes its own. */
function distinctJpeg(seed: number): Uint8Array {
  const source = Buffer.from(LAST_FRAME_JPEG, "base64");
  const note = Buffer.from(`fake-${seed}`);
  const segment = Buffer.alloc(4 + note.length);
  segment.writeUInt16BE(0xfffe, 0);
  segment.writeUInt16BE(note.length + 2, 2);
  note.copy(segment, 4);
  return new Uint8Array(Buffer.concat([source.subarray(0, 2), segment, source.subarray(2)]));
}

function imagesOf(body: Record<string, unknown>): string[] {
  const image = body.image;
  if (image === undefined) return [];
  return Array.isArray(image) ? (image as string[]) : [image as string];
}

function validate(body: Record<string, unknown> | undefined): Response | undefined {
  const bad = (param: string, message: string) =>
    json(400, { error: { code: "InvalidParameter", message, param, type: "BadRequest" } });
  if (!body || typeof body !== "object") return bad("body", "The request body is not valid JSON");
  for (const field of Object.keys(body))
    if (!FIELDS.has(field)) return bad(field, `Unknown parameter ${field}`);
  const rules = MODELS[String(body.model)];
  if (!rules) {
    return json(404, {
      error: {
        code: "InvalidEndpointOrModel.NotFound",
        message: `The model or endpoint ${String(body.model)} does not exist or you do not have access to it.`,
        type: "NotFound",
      },
    });
  }
  const layered = body.layer_decomposition !== undefined;
  if (layered && (!rules.layers || body.layer_decomposition !== true))
    return bad("layer_decomposition", `${body.model} doesn't separate layers`);

  const image = body.image;
  if (image !== undefined && typeof image !== "string" && !Array.isArray(image))
    return bad("image", "image is a string or a list of strings");
  const inputs = imagesOf(body);
  for (const url of inputs) {
    if (typeof url !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(url))
      return bad("image", "Each image must be a data URL with a lowercase format");
  }
  if (inputs.length > rules.maxImages) return bad("image", `At most ${rules.maxImages} images`);

  if (layered) {
    if (inputs.length !== 1 || Array.isArray(image)) return bad("image", "Only one image is supported");
    if (!/^data:image\/(png|jpeg);base64,/.test(inputs[0]!)) return bad("image", "Layers take a png or jpeg");
    if (!["auto", "1K", "1.5K", "2K"].includes(String(body.size ?? "auto")))
      return bad("size", "Only resolution levels are supported");
    if (body.prompt !== undefined && typeof body.prompt !== "string")
      return bad("prompt", "prompt is a string");
  } else {
    if (typeof body.prompt !== "string") return bad("prompt", "prompt is required");
    const size = String(body.size);
    const exact = /^(\d+)x(\d+)$/.exec(size);
    if (exact) {
      const w = Number(exact[1]);
      const h = Number(exact[2]);
      const [low, high] = rules.pixels;
      if (w * h < low || w * h > high || Math.max(w / h, h / w) > 16)
        return bad("size", `${size} is outside ${body.model}'s range`);
    } else if (!rules.tiers.includes(size)) {
      return bad("size", `size must be one of ${rules.tiers.join(", ")} or WxH`);
    }
  }

  if (body.output_format !== undefined) {
    if (!rules.outputFormat) return bad("output_format", `${body.model} doesn't take output_format`);
    if (body.output_format !== "png" && body.output_format !== "jpeg")
      return bad("output_format", "output_format is png or jpeg");
  }
  if (body.background !== undefined) {
    if (!rules.transparent || !["transparent", "opaque"].includes(String(body.background)))
      return bad("background", `${body.model} doesn't take background`);
    if (body.background === "transparent") {
      if (body.output_format === "jpeg") return bad("background", "A transparent background needs png");
      const only = inputs.length === 1 ? inputs[0]! : undefined;
      const bytes = only && Buffer.from(only.slice(only.indexOf(",") + 1), "base64");
      if (!bytes || !pngHasTransparency(new Uint8Array(bytes)))
        return bad("background", "Exactly one input image with an alpha channel is required");
    }
  }
  const optimize = body.optimize_prompt_options as { mode?: unknown } | undefined;
  if (optimize !== undefined) {
    if (typeof optimize !== "object" || !["standard", "fast"].includes(String(optimize.mode)))
      return bad("optimize_prompt_options", "mode is standard or fast");
    if (optimize.mode === "fast" && !rules.fast)
      return bad("optimize_prompt_options", `${body.model} has no fast mode`);
  }
  const sequential = body.sequential_image_generation;
  const options = body.sequential_image_generation_options as { max_images?: unknown } | undefined;
  if (sequential !== undefined || options !== undefined || body.stream !== undefined) {
    if (!rules.sequential)
      return bad("sequential_image_generation", `${body.model} makes one image at a time`);
    if (sequential !== undefined && sequential !== "auto" && sequential !== "disabled")
      return bad("sequential_image_generation", "auto or disabled");
    if (options !== undefined) {
      const max = options.max_images;
      if (sequential !== "auto") return bad("sequential_image_generation_options", "Only with auto");
      if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 15)
        return bad("max_images", "max_images is between 1 and 15");
      if ((max as number) + inputs.length > 15) return bad("max_images", "Inputs and outputs are at most 15");
    }
    if (body.stream !== undefined && body.stream !== false) return bad("stream", "The fake doesn't stream");
  }
  if (
    body.response_format !== undefined &&
    body.response_format !== "b64_json" &&
    body.response_format !== "url"
  )
    return bad("response_format", "url or b64_json");
  if (body.response_format !== "b64_json") return bad("response_format", "The fake only answers b64_json");
  if (body.watermark !== undefined && typeof body.watermark !== "boolean")
    return bad("watermark", "watermark must be a boolean");
  return undefined;
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

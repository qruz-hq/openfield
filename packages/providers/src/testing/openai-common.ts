import { gradientPng, hashString } from "./png";
import type { FakeEnv } from "./types";

// Shared by the fake Image, Files and Batch routes: OpenAI's documented rules, request checks, the
// image a request makes, and small response helpers. Written out from the docs (2026-09-27), not
// read from our manifests, so a manifest that declares something the API refuses fails conformance.

const QUALITIES = {
  "gpt-image-2": ["low", "medium", "high", "auto"],
  "gpt-image-2.5": ["low", "medium", "high", "xhigh", "max", "auto"],
} as const;

/** Output token bases per quality, from the image generation guide's calculator. */
const TOKEN_BASES: Record<string, Record<string, number>> = {
  "gpt-image-2": { low: 16, medium: 48, high: 96 },
  "gpt-image-2.5": { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 },
};

const NAMED_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const FORMATS = ["png", "jpeg", "webp"];

/** The family a model id or dated snapshot belongs to, or undefined for anything else. */
export function familyOf(model: string): keyof typeof QUALITIES | undefined {
  const match = /^(gpt-image-2\.5-(?:sunburst|flare)|gpt-image-2)(-\d{4}-\d{2}-\d{2})?$/.exec(model);
  if (!match) return undefined;
  return match[1] === "gpt-image-2" ? "gpt-image-2" : "gpt-image-2.5";
}

export interface ImageRequest {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  quality?: unknown;
  background?: unknown;
  output_format?: unknown;
  output_compression?: unknown;
  moderation?: unknown;
  input_fidelity?: unknown;
  response_format?: unknown;
}

/** What an accepted request will produce, worked out before any image is drawn. */
export interface Planned {
  model: string;
  n: number;
  /** The size OpenAI would make, and the (smaller) one the fake draws. */
  width: number;
  height: number;
  drawWidth: number;
  drawHeight: number;
  outputTokens: number;
  textTokens: number;
  imageTokens: number;
  quality: string;
  seed: number;
}

/**
 * Checks fields against the reference and works out the images. `inputs` are the input images'
 * sizes for an edit: "auto" follows the first one's shape.
 */
export function planImages(
  body: ImageRequest,
  env: FakeEnv,
  inputs: { width: number; height: number }[] = [],
): Planned | Response {
  const model = typeof body.model === "string" ? body.model : "";
  const family = familyOf(model);
  if (!family) return notFound(`The model \`${model}\` does not exist or you do not have access to it.`);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim())
    return badRequest("Missing required parameter: 'prompt'.", "prompt", "missing_required_parameter");
  if (prompt.length > 32_000) return badRequest("'prompt' is too long.", "prompt", "string_above_max_length");
  if (body.response_format !== undefined)
    return badRequest("Unknown parameter: 'response_format'.", "response_format", "unknown_parameter");

  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > 10) return badRequest("'n' must be between 1 and 10.", "n");
  const quality = body.quality === undefined ? "auto" : String(body.quality);
  if (!(QUALITIES[family] as readonly string[]).includes(quality)) {
    return badRequest(
      `Invalid value: '${quality}'. Supported values are: ${QUALITIES[family].join(", ")}.`,
      "quality",
      "invalid_value",
    );
  }
  const format = body.output_format === undefined ? "png" : String(body.output_format);
  if (!FORMATS.includes(format))
    return badRequest(`Invalid value: '${format}'.`, "output_format", "invalid_value");
  if (body.output_compression !== undefined) {
    const c = Number(body.output_compression);
    if (format === "png")
      return badRequest("'output_compression' is only for jpeg and webp.", "output_compression");
    if (!Number.isInteger(c) || c < 0 || c > 100)
      return badRequest("'output_compression' must be 0 to 100.", "output_compression");
  }
  const background = body.background === undefined ? "auto" : String(body.background);
  if (!["auto", "opaque", "transparent"].includes(background))
    return badRequest(`Invalid value: '${background}'.`, "background", "invalid_value");
  if (background === "transparent" && format === "jpeg")
    return badRequest("Transparent backgrounds need png or webp.", "background", "invalid_value");
  if (body.moderation !== undefined && !["auto", "low"].includes(String(body.moderation)))
    return badRequest(`Invalid value: '${String(body.moderation)}'.`, "moderation", "invalid_value");
  if (body.input_fidelity !== undefined && family === "gpt-image-2")
    return badRequest("input_fidelity is not supported for gpt-image-2.", "input_fidelity");

  const size = body.size === undefined ? "auto" : String(body.size);
  let width: number;
  let height: number;
  if (size === "auto") {
    const first = inputs[0];
    [width, height] =
      first && first.width !== first.height
        ? first.width > first.height
          ? [1536, 1024]
          : [1024, 1536]
        : [1024, 1024];
  } else {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return badRequest(`Invalid size '${size}'.`, "size", "invalid_value");
    [width, height] = [Number(match[1]), Number(match[2])];
    const problem = NAMED_SIZES.includes(size) ? undefined : sizeProblem(width, height);
    if (problem) return badRequest(`Invalid size '${size}'. ${problem}`, "size", "invalid_value");
  }

  const scale = Math.min(1, env.maxEdge / Math.max(width, height));
  const base = TOKEN_BASES[family]![quality === "auto" ? "medium" : quality] ?? 48;
  return {
    model,
    n,
    width,
    height,
    drawWidth: Math.max(1, Math.round(width * scale)),
    drawHeight: Math.max(1, Math.round(height * scale)),
    outputTokens: outputTokens(base, width, height),
    textTokens: Math.max(1, Math.ceil(prompt.length / 4)),
    imageTokens: inputs.length * 1_024,
    quality,
    seed: (hashString(prompt) + env.nextSeed() * 7919) >>> 0,
  };
}

/** The custom size rules from the reference: 16s, 3840, 3:1, and a pixel floor and ceiling. */
function sizeProblem(width: number, height: number): string | undefined {
  if (width % 16 || height % 16) return "Width and height must both be divisible by 16.";
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > 3840) return "Maximum edge length must be less than or equal to 3840px.";
  if (long / short > 3) return "Aspect ratio must be no greater than 3:1.";
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) return "Total pixels must be between 655,360 and 8,294,400.";
  return undefined;
}

/** The calculator's formula, written out again here on purpose. */
function outputTokens(base: number, width: number, height: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const s = base / (long / short);
  const floor = Math.floor(s);
  const scaled = s - floor === 0.5 ? floor + (floor % 2) : Math.round(s);
  return Math.ceil((base * scaled * (2e6 + width * height)) / 4e6);
}

/** An ImagesResponse with n inline PNGs. The fake only draws PNG, and says so in output_format. */
export async function imagesResponse(planned: Planned, body: ImageRequest): Promise<Record<string, unknown>> {
  const data = [];
  for (let i = 0; i < planned.n; i++) {
    const png = await gradientPng(planned.drawWidth, planned.drawHeight, planned.seed + i * 104_729);
    data.push({ b64_json: Buffer.from(png).toString("base64") });
  }
  const outputTokens = planned.outputTokens * planned.n;
  const inputTokens = planned.textTokens + planned.imageTokens;
  return {
    created: 1_790_467_200,
    background: body.background ?? "opaque",
    output_format: "png",
    quality: planned.quality,
    size: `${planned.width}x${planned.height}`,
    data,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { text_tokens: planned.textTokens, image_tokens: planned.imageTokens },
      output_tokens: outputTokens,
      output_tokens_details: { image_tokens: outputTokens, text_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function badRequest(message: string, param?: string, code?: string): Response {
  return json(400, {
    error: { message, type: "invalid_request_error", param: param ?? null, code: code ?? null },
  });
}

export function notFound(message: string): Response {
  return json(404, {
    error: { message, type: "invalid_request_error", param: null, code: "model_not_found" },
  });
}

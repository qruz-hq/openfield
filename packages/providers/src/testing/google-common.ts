import { RESOLUTION_TIER_PX, type ResolutionTier } from "@openfield/core";
import { gradientPng, hashString, probeImage } from "./png";
import type { FakeEnv } from "./types";

// Shared by the fake generateContent, Batch and Files routes: Google's documented tables, request
// checks, the image a request makes, and small response helpers.

const STANDARD = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

interface Documented {
  ratios: string[];
  sizes: string[];
  tokens: Record<string, number>;
  /** serviceTier values beyond standard, per the pricing page (2026-09-22). */
  tiers: string[];
}

/** From the resolution tables in the image generation guide and the pricing page (2026-09-23). */
const DOCUMENTED: Record<string, Documented> = {
  "gemini-3-pro-image": {
    ratios: STANDARD,
    sizes: ["1K", "2K", "4K"],
    tokens: { "1K": 1120, "2K": 1120, "4K": 2000 },
    tiers: ["flex", "priority"],
  },
  "gemini-3.1-flash-image": {
    ratios: [...STANDARD, "1:4", "4:1", "1:8", "8:1"],
    sizes: ["512", "1K", "2K", "4K"],
    tokens: { "512": 747, "1K": 1120, "2K": 1680, "4K": 2520 },
    tiers: [],
  },
  "gemini-3.1-flash-lite-image": { ratios: STANDARD, sizes: ["1K"], tokens: { "1K": 1120 }, tiers: [] },
};

type Part = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
};

export interface GenerateBody {
  contents?: { parts?: Part[] }[];
  generationConfig?: {
    responseModalities?: string[];
    imageConfig?: { aspectRatio?: string; imageSize?: string };
  };
  serviceTier?: string;
}

/** What an accepted request will produce, worked out before any image is drawn. */
export interface PlannedImage {
  modelId: string;
  width: number;
  height: number;
  tokens: number;
  promptTokens: number;
  seed: number;
}

export const promptOf = (body: GenerateBody) =>
  body.contents?.[0]?.parts?.map((p) => p.text ?? "").join(" ") ?? "";

/** Files uploaded through the fake Files API, by name ("files/abc"). */
export const files = (env: FakeEnv) =>
  storeMap<string, { mimeType: string; bytes: Uint8Array; displayName: string }>(env, "google:files");

export function storeMap<K, V>(env: FakeEnv, name: string): Map<K, V> {
  let map = env.store.get(name) as Map<K, V> | undefined;
  if (!map) {
    map = new Map<K, V>();
    env.store.set(name, map);
  }
  return map;
}

/**
 * Checks a generateContent body against Google's tables and works out the image it would make:
 * the requested ratio, or the first input image's shape, or a square, as the guide describes.
 */
export function planImage(
  modelId: string,
  body: GenerateBody,
  env: FakeEnv,
  file: (name: string) => { bytes: Uint8Array } | undefined,
): PlannedImage | Response {
  // Preview and dated snapshots answer like their family.
  const family = modelId.replace(/(-preview)?(-\d{2}-\d{4})?$/, "");
  const table = DOCUMENTED[family];
  if (!table) return notFound(`models/${modelId}`);

  const parts = body.contents?.[0]?.parts ?? [];
  if (!parts.length) return badRequest("* GenerateContentRequest.contents: contents is not specified");
  const modalities = body.generationConfig?.responseModalities ?? [];
  if (!modalities.includes("IMAGE")) return badRequest("The model needs IMAGE in responseModalities.");

  const tier = body.serviceTier;
  if (tier !== undefined && !["standard", "unspecified", ...table.tiers].includes(tier)) {
    return badRequest(`Service tier ${tier} is not supported for models/${modelId}.`, "service_tier");
  }

  const { aspectRatio, imageSize } = body.generationConfig?.imageConfig ?? {};
  if (aspectRatio !== undefined && !table.ratios.includes(aspectRatio)) {
    return badRequest(
      `Unsupported aspect ratio: ${aspectRatio}`,
      "generation_config.image_config.aspect_ratio",
    );
  }
  if (imageSize !== undefined && !table.sizes.includes(imageSize)) {
    return badRequest(`Unsupported image size: ${imageSize}`, "generation_config.image_config.image_size");
  }

  let firstImage: Uint8Array | undefined;
  for (const part of parts) {
    const uri = part.fileData?.fileUri;
    if (uri) {
      const name = /\/v1beta\/(files\/[^/?]+)/.exec(uri)?.[1] ?? "";
      const uploaded = file(name);
      if (!uploaded) return badRequest(`File ${name || uri} not found.`);
      firstImage ??= uploaded.bytes;
    } else if (part.inlineData?.data) {
      firstImage ??= new Uint8Array(Buffer.from(part.inlineData.data, "base64"));
    }
  }
  const probed = firstImage ? probeImage(firstImage) : null;
  const [rw, rh] = aspectRatio
    ? (aspectRatio.split(":").map(Number) as [number, number])
    : probed
      ? [probed.width, probed.height]
      : [1, 1];
  const size = (imageSize ?? "1K") as ResolutionTier;
  const long = Math.min(RESOLUTION_TIER_PX[size], env.maxEdge);
  const text = promptOf(body);
  return {
    modelId,
    width: Math.max(1, Math.round(rw >= rh ? long : (long * rw) / rh)),
    height: Math.max(1, Math.round(rw >= rh ? (long * rh) / rw : long)),
    tokens: table.tokens[size] ?? 1120,
    promptTokens: Math.max(1, Math.ceil(text.length / 4)),
    seed: (hashString(text) + env.nextSeed() * 7919) >>> 0,
  };
}

/** A GenerateContentResponse with one inline PNG. */
export async function imageResponse(
  planned: PlannedImage,
  opts: { serviceTier?: string; responseId?: boolean; env: FakeEnv },
): Promise<Record<string, unknown>> {
  const png = await gradientPng(planned.width, planned.height, planned.seed);
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from(png).toString("base64") } }],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: planned.promptTokens,
      candidatesTokenCount: planned.tokens,
      totalTokenCount: planned.promptTokens + planned.tokens,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: planned.promptTokens }],
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: planned.tokens }],
      ...(opts.serviceTier && { serviceTier: opts.serviceTier }),
    },
    modelVersion: planned.modelId,
    ...(opts.responseId && { responseId: `fake-${opts.env.nextSeed().toString(36)}` }),
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

export function badRequest(message: string, field?: string): Response {
  return json(400, {
    error: {
      code: 400,
      message,
      status: "INVALID_ARGUMENT",
      ...(field && {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [{ field, description: message }],
          },
        ],
      }),
    },
  });
}

export function notFound(what: string): Response {
  return json(404, {
    error: {
      code: 404,
      message: `${what} is not found for API version v1beta, or is not supported for generateContent.`,
      status: "NOT_FOUND",
    },
  });
}

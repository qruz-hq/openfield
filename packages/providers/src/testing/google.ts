import { RESOLUTION_TIER_PX, type ResolutionTier } from "@openfield/core";
import badKey from "../google/__fixtures__/bad-key.json";
import blockedPrompt from "../google/__fixtures__/blocked-prompt.json";
import forbidden from "../google/__fixtures__/forbidden.json";
import foreignAsset from "../google/__fixtures__/foreign-asset.json";
import invalidArgument from "../google/__fixtures__/invalid-argument.json";
import modelsList from "../google/__fixtures__/models-list.json";
import noBilling from "../google/__fixtures__/no-billing.json";
import noImage from "../google/__fixtures__/no-image.json";
import rateLimited from "../google/__fixtures__/rate-limited.json";
import refused from "../google/__fixtures__/refused-image-safety.json";
import serverError from "../google/__fixtures__/server-error.json";
import unavailable from "../google/__fixtures__/unavailable.json";
import { gradientPng, hashString, probeImage } from "./png";
import {
  type FakeEnv,
  type FakeRoute,
  type FakeScenario,
  type RecordedExchange,
  replay,
  taggedScenario,
} from "./types";

// A stand-in for generativelanguage.googleapis.com. It checks requests against Google's documented
// tables on its own, rather than against our manifests, so a manifest that declares something the
// API doesn't take fails the conformance suite.

const STANDARD = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/** From the resolution tables in the image generation guide (2026-09-23). */
const DOCUMENTED: Record<string, { ratios: string[]; sizes: string[]; tokens: Record<string, number> }> = {
  "gemini-3-pro-image": {
    ratios: STANDARD,
    sizes: ["1K", "2K", "4K"],
    tokens: { "1K": 1120, "2K": 1120, "4K": 2000 },
  },
  "gemini-3.1-flash-image": {
    ratios: [...STANDARD, "1:4", "4:1", "1:8", "8:1"],
    sizes: ["512", "1K", "2K", "4K"],
    tokens: { "512": 747, "1K": 1120, "2K": 1680, "4K": 2520 },
  },
  "gemini-3.1-flash-lite-image": { ratios: STANDARD, sizes: ["1K"], tokens: { "1K": 1120 } },
};

const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden,
  invalid: invalidArgument,
  rate_limited: rateLimited,
  no_billing: noBilling,
  server_error: serverError,
  unavailable,
  blocked: blockedPrompt,
  refused,
  no_image: noImage,
  foreign_asset: foreignAsset,
};

interface GenerateBody {
  contents?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }[];
  generationConfig?: {
    responseModalities?: string[];
    imageConfig?: { aspectRatio?: string; imageSize?: string };
  };
}

export const googleFake: FakeRoute = {
  providerId: "google",
  hosts: ["generativelanguage.googleapis.com"],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    const key = request.headers.get("x-goog-api-key");
    if (!key) return replay(forbidden);
    if (url.searchParams.has("key")) return badRequest("Pass the key in the x-goog-api-key header.");
    // Any key works, except one containing "invalid", so first-run tests can see a rejection.
    const keyScenario: FakeScenario | undefined = key.includes("invalid") ? "bad_key" : undefined;

    if (request.method === "GET" && url.pathname === "/v1beta/models") {
      const scenario = env.scenario ?? keyScenario;
      if (scenario && scenario !== "success") return replay(fixtures[scenario] ?? serverError);
      const models = modelsList.response.body.models.filter(
        (m) => !env.hiddenModels.includes(m.name.replace(/^models\//, "")),
      );
      return replay(modelsList, { ...modelsList.response.body, models });
    }

    const match = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return notFound(url.pathname);

    const body = (await request.json()) as GenerateBody;
    const text = body.contents?.[0]?.parts?.map((p) => p.text ?? "").join(" ") ?? "";
    const scenario = env.scenario ?? keyScenario ?? taggedScenario(text) ?? "success";
    if (scenario !== "success") return replay(fixtures[scenario] ?? serverError);

    return generate(decodeURIComponent(match[1]!), body, text, env);
  },
};

async function generate(modelId: string, body: GenerateBody, text: string, env: FakeEnv): Promise<Response> {
  // Preview and dated snapshots answer like their family.
  const family = modelId.replace(/(-preview)?(-\d{2}-\d{4})?$/, "");
  const table = DOCUMENTED[family];
  if (!table) return notFound(`models/${modelId}`);

  const parts = body.contents?.[0]?.parts ?? [];
  if (!parts.length) return badRequest("* GenerateContentRequest.contents: contents is not specified");
  const modalities = body.generationConfig?.responseModalities ?? [];
  if (!modalities.includes("IMAGE")) return badRequest("The model needs IMAGE in responseModalities.");

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

  // No aspect ratio: follow the first input image, or make a square, as the guide describes.
  const firstImage = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
  const probed = firstImage ? probeImage(new Uint8Array(Buffer.from(firstImage, "base64"))) : null;
  const [rw, rh] = aspectRatio
    ? (aspectRatio.split(":").map(Number) as [number, number])
    : probed
      ? [probed.width, probed.height]
      : [1, 1];
  const size = (imageSize ?? "1K") as ResolutionTier;
  const long = Math.min(RESOLUTION_TIER_PX[size], env.maxEdge);
  const width = Math.max(1, Math.round(rw >= rh ? long : (long * rw) / rh));
  const height = Math.max(1, Math.round(rw >= rh ? (long * rh) / rw : long));

  const png = await gradientPng(width, height, (hashString(text) + env.nextSeed() * 7919) >>> 0);
  const promptTokens = Math.max(1, Math.ceil(text.length / 4));
  const imageTokens = table.tokens[size] ?? 1120;
  return json(200, {
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
      promptTokenCount: promptTokens,
      candidatesTokenCount: imageTokens,
      totalTokenCount: promptTokens + imageTokens,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: promptTokens }],
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: imageTokens }],
    },
    modelVersion: modelId,
    responseId: `fake-${env.nextSeed().toString(36)}`,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function badRequest(message: string, field?: string): Response {
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

function notFound(what: string): Response {
  return json(404, {
    error: {
      code: 404,
      message: `${what} is not found for API version v1beta, or is not supported for generateContent.`,
      status: "NOT_FOUND",
    },
  });
}

import type { NormalizedRequest, SpeedId } from "@openfield/core";
import { t } from "@openfield/core";
import { type CallContext, type JobResult, ProviderError, type ProviderUsage } from "../types";

// generateContent response to a JobResult. The image arrives inline as base64 in
// candidates[0].content.parts[].inlineData; we decode it and stream it straight to ctx.assets.

interface ResponsePart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
}

interface TokenDetail {
  modality?: string;
  tokenCount?: number;
}

export interface GeminiResponse {
  candidates?: {
    content?: { role?: string; parts?: ResponsePart[] };
    finishReason?: string;
    finishMessage?: string;
    index?: number;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: TokenDetail[];
    candidatesTokensDetails?: TokenDetail[];
    /** The speed Google served: "standard", "flex" or "priority". */
    serviceTier?: string;
  };
  modelVersion?: string;
  responseId?: string;
}

/**
 * The final image. Thinking can produce up to two interim "thought" images before it; the guide
 * says the last one is the final render, so we take the last image that isn't a thought.
 */
export function pickImage(body: unknown): { mimeType: string; data: string } | undefined {
  const parts = (body as GeminiResponse | undefined)?.candidates?.[0]?.content?.parts ?? [];
  const finals = parts.filter((p) => !p.thought);

  // Images only ever arrive inline here, so meta.assetHosts is empty and any URL is refused (§6.11).
  if (finals.some((p) => p.fileData?.fileUri)) {
    throw new ProviderError("provider_error", {
      message: "The response pointed at an image URL instead of inline data",
      userMessage: t("errors.imageBlocked"),
    });
  }
  const image = finals.findLast((p) => p.inlineData?.data);
  const data = image?.inlineData?.data;
  if (!data) return undefined;
  return { mimeType: image.inlineData?.mimeType ?? "image/png", data };
}

/**
 * The speed Google says it served: usageMetadata.serviceTier, then the x-gemini-service-tier header
 * (documented for the Interactions API, so maybe absent here), then the speed asked for. Priority
 * over its limits is quietly served at Standard, so cost must follow this (§0.13).
 */
export function speedServed(body: unknown, headers: Headers | undefined, requested: SpeedId): SpeedId {
  const raw =
    (body as GeminiResponse | undefined)?.usageMetadata?.serviceTier ??
    headers?.get("x-gemini-service-tier") ??
    undefined;
  const tier = raw?.toLowerCase().replace(/^service_tier_/, "");
  if (tier === "standard" || tier === "flex" || tier === "priority") return tier;
  if (tier === "unspecified") return "standard";
  return requested;
}

export async function toJobResult(
  body: GeminiResponse,
  image: { mimeType: string; data: string },
  req: Pick<NormalizedRequest, "batchIndex" | "seed">,
  ctx: CallContext,
  submittedAt: number,
  speedUsed?: SpeedId,
): Promise<JobResult> {
  // Copy out of Buffer's shared pool so the sink gets bytes it owns.
  const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const written = await ctx.assets.write(stream, { mimeType: image.mimeType });
  const completedAt = ctx.now();

  const usage = usageOf(body);
  return {
    images: [
      {
        assetId: written.assetId,
        index: req.batchIndex,
        width: written.width,
        height: written.height,
        mimeType: image.mimeType,
        bytes: written.bytes,
        ...(req.seed !== undefined && { seed: req.seed }),
      },
    ],
    ...(usage && { usage }),
    providerRaw: ctx.log.scrub(withoutImageData(body)),
    timings: { submittedAt, firstOutputAt: completedAt, completedAt },
    ...(speedUsed && { speedUsed }),
  };
}

export function usageOf(body: GeminiResponse): ProviderUsage | undefined {
  const meta = body.usageMetadata;
  if (!meta) return undefined;
  const byModality = (list: TokenDetail[] | undefined, modality: string) =>
    list?.find((d) => d.modality === modality)?.tokenCount;

  const usage: ProviderUsage = { imagesBilled: 1 };
  const fields: [keyof ProviderUsage, number | undefined][] = [
    ["inputTextTokens", byModality(meta.promptTokensDetails, "TEXT")],
    ["inputImageTokens", byModality(meta.promptTokensDetails, "IMAGE")],
    ["cachedInputTokens", meta.cachedContentTokenCount],
    ["outputImageTokens", byModality(meta.candidatesTokensDetails, "IMAGE")],
  ];
  for (const [key, value] of fields) if (typeof value === "number") Object.assign(usage, { [key]: value });

  // Thinking tokens are billed at the text rate; keep them for reconciliation (§6.9).
  const raw: Record<string, number> = {};
  for (const key of [
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "totalTokenCount",
  ] as const) {
    const value = meta[key];
    if (typeof value === "number") raw[key] = value;
  }
  if (Object.keys(raw).length) usage.raw = raw;
  return usage;
}

/** The response for the error log, with each image swapped for its size. */
export function withoutImageData(body: GeminiResponse): GeminiResponse {
  return {
    ...body,
    ...(body.candidates && {
      candidates: body.candidates.map((c) => ({
        ...c,
        ...(c.content && {
          content: {
            ...c.content,
            parts: c.content.parts?.map((p) =>
              p.inlineData?.data
                ? {
                    ...p,
                    inlineData: {
                      ...p.inlineData,
                      data: `[${Math.floor((p.inlineData.data.length * 3) / 4)} bytes]`,
                    },
                  }
                : p,
            ),
          },
        }),
      })),
    }),
  };
}

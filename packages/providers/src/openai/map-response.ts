import type { CostActual, NormalizedRequest, PriceModel, SpeedId } from "@openfield/core";
import { formatMoney } from "@openfield/core";
import {
  type CallContext,
  type GeneratedImage,
  type JobResult,
  ProviderError,
  type ProviderUsage,
} from "../types";

// An Image API response to a JobResult. Images arrive inline as data[].b64_json (GPT Image models
// always answer this way), so meta.assetHosts is empty; each is decoded and streamed to ctx.assets.

export interface ImagesResponse {
  created?: number;
  output_format?: string;
  size?: string;
  quality?: string;
  background?: string;
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { image_tokens?: number; text_tokens?: number };
    total_tokens?: number;
  };
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export async function toJobResult(
  body: ImagesResponse,
  req: Pick<NormalizedRequest, "batchIndex">,
  ctx: CallContext,
  opts: { submittedAt: number; price: PriceModel; speed: SpeedId },
): Promise<JobResult> {
  const data = body.data ?? [];
  // A URL would need an asset host; GPT Image models never send one.
  if (data.some((d) => d.url && !d.b64_json)) {
    throw new ProviderError("provider_error", {
      message: "The response pointed at an image URL instead of inline data",
    });
  }
  const encoded = data.filter((d) => d.b64_json);
  if (!encoded.length) {
    throw new ProviderError("provider_error", { message: "The response held no image" });
  }
  const mimeType = MIME[body.output_format ?? "png"] ?? "image/png";

  const images: GeneratedImage[] = [];
  let firstOutputAt: number | undefined;
  for (const [i, item] of encoded.entries()) {
    // Copy out of Buffer's shared pool so the sink gets bytes it owns.
    const bytes = new Uint8Array(Buffer.from(item.b64_json!, "base64"));
    const written = await ctx.assets.write(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { mimeType },
    );
    firstOutputAt ??= ctx.now();
    images.push({
      assetId: written.assetId,
      index: req.batchIndex + i,
      width: written.width,
      height: written.height,
      mimeType,
      bytes: written.bytes,
    });
  }

  const usage = usageOf(body, images.length);
  const cost = usage && costOf(usage, opts.price);
  const revisedPrompt = data.find((d) => d.revised_prompt)?.revised_prompt;
  return {
    images,
    ...(revisedPrompt && { revisedPrompt }),
    ...(usage && { usage }),
    ...(cost && { cost }),
    providerRaw: ctx.log.scrub(withoutImageData(body)),
    timings: { submittedAt: opts.submittedAt, firstOutputAt: firstOutputAt!, completedAt: ctx.now() },
    speedUsed: opts.speed,
  };
}

export function usageOf(body: ImagesResponse, images: number): ProviderUsage | undefined {
  const u = body.usage;
  if (!u) return undefined;
  const usage: ProviderUsage = { imagesBilled: images };
  const text = u.input_tokens_details?.text_tokens;
  const imageIn = u.input_tokens_details?.image_tokens;
  // Older responses report output only as a total; for an image model that's all image tokens.
  const imageOut = u.output_tokens_details?.image_tokens ?? u.output_tokens;
  if (typeof text === "number") usage.inputTextTokens = text;
  if (typeof imageIn === "number") usage.inputImageTokens = imageIn;
  if (typeof imageOut === "number") usage.outputImageTokens = imageOut;
  const raw: Record<string, number> = {};
  for (const [key, value] of Object.entries({
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
    output_text_tokens: u.output_tokens_details?.text_tokens,
  })) {
    if (typeof value === "number") raw[key] = value;
  }
  if (Object.keys(raw).length) usage.raw = raw;
  return usage;
}

/**
 * What the tokens OpenAI reported cost, at the rates of the speed that served them. OpenAI bills
 * cached input without reporting it, so this is an upper bound when a prompt was cached.
 */
export function costOf(usage: ProviderUsage, price: PriceModel): CostActual | undefined {
  if (price.kind !== "per_token" || usage.outputImageTokens === undefined) return undefined;
  const amount =
    ((usage.inputTextTokens ?? 0) * price.textInputPerMTok +
      (usage.inputImageTokens ?? 0) * price.imageInputPerMTok +
      usage.outputImageTokens * price.imageOutputPerMTok) /
    1e6;
  const rounded = Math.round(amount * 1e6) / 1e6;
  return {
    currency: price.currency,
    amount: rounded,
    confidence: "reconciled",
    basis: `${usage.outputImageTokens} image tokens out, ${formatMoney(rounded, price.currency, true)} in all`,
  };
}

/** The response for the error log, with each image swapped for its size. */
export function withoutImageData(body: ImagesResponse): ImagesResponse {
  return {
    ...body,
    ...(body.data && {
      data: body.data.map((d) =>
        d.b64_json ? { ...d, b64_json: `[${Math.floor((d.b64_json.length * 3) / 4)} bytes]` } : d,
      ),
    }),
  };
}

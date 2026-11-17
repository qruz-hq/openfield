import {
  type CostActual,
  formatMoney,
  LAYER_FONT_MAX,
  LAYER_TEXT_LINES_MAX,
  LAYER_TEXT_MAX,
  LAYER_TEXT_RUNS_MAX,
  type LayerOpParams,
  type LayerText,
  type LayerTextStyle,
  layerGridToPixels,
  type NormalizedRequest,
  type PriceModel,
  pixelPriceFor,
  type SpeedId,
  t,
} from "@openfield/core";
import {
  type CallContext,
  type GeneratedImage,
  type JobResult,
  ProviderError,
  type ProviderUsage,
} from "../types";
import { type ByteplusErrorBody, errorFor } from "./errors";

// An /images/generations answer to a JobResult. Images come inline as b64_json and are streamed to
// ctx.assets one by one. A related set may answer short, or with an error in place of an image (a
// moderated one); those become per-image failures so the rest of the run still lands. A separation
// answers a base (z_index 0) and its layers, each cropped to its own box.

export interface SeedreamItem {
  b64_json?: string;
  url?: string;
  /** "<width>x<height>" of this image. */
  size?: string;
  output_format?: string;
  error?: ByteplusErrorBody;
  z_index?: number;
  bounding_box?: { absolute?: number[]; normalized?: number[] };
  name?: string;
  description?: string;
  /** 5.5, on a plain text layer when text_recognition was asked for. */
  text_recognition?: SeedreamTextRecognition;
}

/** data[].text_recognition, as the image generation API describes it. */
export interface SeedreamTextRecognition {
  text?: string;
  lines?: {
    bounding_box?: { absolute?: number[]; normalized?: number[] };
    runs?: {
      text?: string;
      style?: {
        similar_font_family?: string;
        foreground_color?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        shadow?: boolean;
        translucent?: boolean;
      };
    }[];
  }[];
}

export interface SeedreamResponse {
  model?: string;
  created?: number;
  data?: SeedreamItem[];
  usage?: { generated_images?: number; input_images?: number; output_tokens?: number; total_tokens?: number };
  error?: ByteplusErrorBody;
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg" };

interface MapOptions {
  submittedAt: number;
  price: PriceModel;
  speed: SpeedId;
  /** For copy that names it. */
  model: string;
  /** Images sent in, for the input charge when usage doesn't say. */
  inputsSent: number;
  /** The format asked for, when the answer doesn't say. */
  format: "png" | "jpeg";
}

export async function toSeedreamResult(
  body: SeedreamResponse,
  req: Pick<NormalizedRequest, "batchIndex" | "batch" | "op">,
  ctx: CallContext,
  opts: MapOptions,
): Promise<JobResult> {
  const layered = req.op === "decompose";
  if (body.error) throw failure(body.error, opts.model, layered);
  const data = body.data ?? [];
  if (data.some((d) => d.url && !d.b64_json)) {
    throw new ProviderError("provider_error", {
      message: "The response pointed at an image URL instead of inline data",
      final: true,
    });
  }

  const images: GeneratedImage[] = [];
  const failures: NonNullable<JobResult["failures"]> = [];
  const billed: { width: number; height: number }[] = [];
  let firstOutputAt: number | undefined;
  const base = layered ? data.find((d) => (d.z_index ?? 0) === 0 && d.b64_json) : undefined;
  const canvas = base ? sizeOf(base.size) : undefined;

  for (const [position, item] of data.entries()) {
    const index = req.batchIndex + position;
    if (!item.b64_json) {
      // A separation is all or nothing (the tutorial), so one missing image fails the whole call.
      if (layered) throw failure(item.error, opts.model, true);
      failures.push({ index, error: failure(item.error, opts.model, false) });
      continue;
    }
    const mimeType =
      MIME[item.output_format ?? (layered && item !== base ? "png" : opts.format)] ?? "image/png";
    const bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
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
    // What BytePlus says it made bills; the file's own size is the fallback.
    billed.push(sizeOf(item.size) ?? { width: written.width, height: written.height });
    const layer = layered ? layerOf(item, item === base, canvas ?? written) : undefined;
    images.push({
      assetId: written.assetId,
      // A layer has no job of its own: it's filed beside the base, which holds the job's index.
      index: layered ? req.batchIndex : index,
      width: written.width,
      height: written.height,
      mimeType,
      bytes: written.bytes,
      ...(layer && { layer }),
    });
  }

  if (layered && !base) throw failure(undefined, opts.model, true);
  if (!images.length) {
    // Nothing came back: the first image's own error says why.
    throw (
      failures[0]?.error ?? new ProviderError("content_refused", { message: "The response held no image" })
    );
  }
  // A related set the model chose to make shorter than asked: the missing images just weren't made.
  if (!layered) {
    for (let position = data.length; position < req.batch; position++) {
      failures.push({
        index: req.batchIndex + position,
        error: new ProviderError("content_refused", {
          message: "The model made fewer images than asked",
          userMessage: t("errors.groupImageMissing", { model: opts.model }),
        }),
      });
    }
  }

  const usage = usageOf(body, images.length);
  const cost = costOf(opts.price, billed, {
    billedImages: body.usage?.generated_images,
    inputImages: body.usage?.input_images ?? opts.inputsSent,
    layered,
  });
  return {
    images,
    ...(failures.length && { failures }),
    usage,
    ...(cost && { cost }),
    providerRaw: ctx.log.scrub(withoutImageData(body)),
    timings: { submittedAt: opts.submittedAt, firstOutputAt: firstOutputAt!, completedAt: ctx.now() },
    speedUsed: opts.speed,
  };
}

/** A failed image, or a failed separation, as a ProviderError with words a person can act on. */
function failure(error: ByteplusErrorBody | undefined, model: string, layered: boolean): ProviderError {
  const mapped = errorFor(error, { model });
  if (!layered)
    return error ? mapped : new ProviderError("content_refused", { message: "No image came back" });
  return asLayerFailure(mapped, model);
}

/**
 * A separation that broke on BytePlus's side, in words about layers. Refusals, keys, limits and
 * bad requests keep their own copy, which already says what to do.
 */
export function asLayerFailure(err: ProviderError, model: string): ProviderError {
  if (err.code !== "provider_error" && err.code !== "provider_unavailable") return err;
  return new ProviderError("provider_unavailable", {
    message: err.message,
    userMessage: t("errors.layersFailed", { model }),
    ...(err.providerCode && { providerCode: err.providerCode }),
    ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
  });
}

function layerOf(
  item: SeedreamItem,
  isBase: boolean,
  canvas: { width: number; height: number },
): LayerOpParams {
  const common = { canvas: { width: canvas.width, height: canvas.height } };
  if (isBase) return { role: "base", zIndex: 0, ...common };
  const text = layerTextOf(item.text_recognition, canvas);
  const absolute = item.bounding_box?.absolute;
  const grid = item.bounding_box?.normalized;
  const box =
    absolute?.length === 4
      ? (absolute.map((v) => Math.max(0, Math.round(v))) as [number, number, number, number])
      : grid?.length === 4
        ? layerGridToPixels(grid, canvas.width, canvas.height)
        : ([0, 0, canvas.width, canvas.height] as [number, number, number, number]);
  return {
    role: "layer",
    zIndex: Math.max(1, item.z_index ?? 1),
    ...common,
    box,
    ...(grid?.length === 4 && {
      boxGrid: grid.map((v) => Math.min(1000, Math.max(0, Math.round(v)))) as [
        number,
        number,
        number,
        number,
      ],
    }),
    ...(item.name && { name: item.name.slice(0, 200) }),
    ...(item.description && { description: item.description.slice(0, 2000) }),
    ...(text && { text }),
  };
}

/**
 * A text layer's words, trimmed to what a layer can store so a long poster never makes the layer
 * itself unreadable. Anything malformed is left out rather than failing the split.
 */
export function layerTextOf(
  ocr: SeedreamTextRecognition | undefined,
  canvas: { width: number; height: number },
): LayerText | undefined {
  if (!ocr || typeof ocr !== "object") return undefined;
  const lines: LayerText["lines"] = [];
  for (const line of Array.isArray(ocr.lines) ? ocr.lines.slice(0, LAYER_TEXT_LINES_MAX) : []) {
    const runs = (Array.isArray(line?.runs) ? line.runs : [])
      .filter((r) => typeof r?.text === "string")
      .slice(0, LAYER_TEXT_RUNS_MAX)
      .map((r) => ({ text: r.text!.slice(0, LAYER_TEXT_MAX), style: styleOf(r.style) }));
    const absolute = boxOf(line?.bounding_box?.absolute, 65_536);
    const grid = boxOf(line?.bounding_box?.normalized, 1000);
    const box = absolute ?? (grid && layerGridToPixels(grid, canvas.width, canvas.height));
    lines.push({ ...(box && { box }), ...(grid && { boxGrid: grid }), runs });
  }
  const text =
    typeof ocr.text === "string" ? ocr.text : lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");
  if (!text.trim()) return undefined;
  return { text: text.slice(0, LAYER_TEXT_MAX), lines };
}

function styleOf(
  style: NonNullable<NonNullable<SeedreamTextRecognition["lines"]>[number]["runs"]>[number]["style"],
): LayerTextStyle {
  if (!style || typeof style !== "object") return {};
  const font = typeof style.similar_font_family === "string" ? style.similar_font_family.trim() : "";
  const color = typeof style.foreground_color === "string" ? style.foreground_color.toUpperCase() : "";
  const out: LayerTextStyle = {};
  // "unknown" is the model saying it couldn't tell.
  if (font && font.toLowerCase() !== "unknown") out.font = font.slice(0, LAYER_FONT_MAX);
  if (/^#[0-9A-F]{6}$/.test(color)) out.color = color;
  for (const flag of ["bold", "italic", "underline", "strikethrough", "shadow", "translucent"] as const)
    if (typeof style[flag] === "boolean") out[flag] = style[flag];
  return out;
}

/** Four whole numbers from 0 to `max`, or nothing. */
function boxOf(values: number[] | undefined, max: number): [number, number, number, number] | undefined {
  if (!Array.isArray(values) || values.length !== 4 || !values.every((v) => Number.isFinite(v)))
    return undefined;
  return values.map((v) => Math.min(max, Math.max(0, Math.round(v)))) as [number, number, number, number];
}

function sizeOf(size: string | undefined): { width: number; height: number } | undefined {
  const match = size && /^(\d+)x(\d+)$/.exec(size);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

function usageOf(body: SeedreamResponse, images: number): ProviderUsage {
  const u = body.usage;
  const raw: Record<string, number> = {};
  for (const [key, value] of Object.entries(u ?? {})) if (typeof value === "number") raw[key] = value;
  return {
    imagesBilled: u?.generated_images ?? images,
    ...(typeof u?.output_tokens === "number" && { outputImageTokens: u.output_tokens }),
    ...(Object.keys(raw).length && { raw }),
  };
}

/**
 * What BytePlus bills (its pricing page): each image it made at the rate for that image's pixels,
 * plus any input images past the free ones. Only images that came back are counted.
 */
export function costOf(
  price: PriceModel,
  images: readonly { width: number; height: number }[],
  opts: { billedImages?: number | undefined; inputImages: number; layered: boolean },
): CostActual | undefined {
  if (price.kind !== "per_image") return undefined;
  const rates = opts.layered && price.decompose ? price.decompose : price;
  const each = (img: { width: number; height: number }) =>
    rates.byPixels
      ? pixelPriceFor(rates.byPixels, img.width * img.height)
      : (rates.tiers.find((r) => !r.tier && !r.quality) ?? rates.tiers[0]!).usd;
  const count = Math.min(opts.billedImages ?? images.length, images.length);
  let amount = images.slice(0, count).reduce((sum, img) => sum + each(img), 0);
  const input = price.inputImage;
  if (input && "usd" in input) amount += Math.max(0, opts.inputImages - input.freePerCall) * input.usd;
  const rounded = Math.round(amount * 1e6) / 1e6;
  return {
    currency: price.currency,
    amount: rounded,
    confidence: "reconciled",
    basis: `${count} ${count === 1 ? "image" : "images"}, ${formatMoney(rounded, price.currency, true)} in all`,
  };
}

/** The response for the error log, with each image swapped for its size. */
export function withoutImageData(body: SeedreamResponse): SeedreamResponse {
  return {
    ...body,
    ...(body.data && {
      data: body.data.map((d) =>
        d.b64_json ? { ...d, b64_json: `[${Math.floor((d.b64_json.length * 3) / 4)} bytes]` } : d,
      ),
    }),
  };
}

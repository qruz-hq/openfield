import {
  DEFAULT_CURRENCY,
  formatMoney,
  hostAllowed,
  type JobHandle,
  type ModelManifest,
  t,
  type VideoResolution,
  videoRate,
} from "@openfield/core";
import {
  type AssetSink,
  type CallContext,
  errorCodeForStatus,
  errorFromFetchFailure,
  type GeneratedImage,
  type JobResult,
  type JobUpdate,
  ProviderError,
  redactError,
} from "../types";
import { ASSET_HOSTS, COMPANY } from "./capabilities";
import { type ByteplusErrorBody, errorFor } from "./errors";

// A status read (GET /contents/generations/tasks/{id}) to a JobUpdate. A finished task names its
// video (and, asked for, its last frame) by URL, valid for 24 hours, so both are downloaded from
// the declared storage host and written through ctx.assets the first time the task reads finished.

export interface TaskBody {
  id?: string;
  model?: string;
  status?: string;
  error?: ByteplusErrorBody | null;
  content?: { video_url?: string; last_frame_url?: string } | null;
  usage?: { completion_tokens?: number; total_tokens?: number } | null;
  seed?: number;
  resolution?: string;
  ratio?: string;
  duration?: number;
  framespersecond?: number;
  generate_audio?: boolean;
  created_at?: number;
  updated_at?: number;
}

/** What handle.resume carries: enough to shape and price the result in a fresh process. */
export interface Resume {
  index: number;
  submittedAt: number;
  resolution?: VideoResolution;
  audio?: boolean;
}

export function resumeOf(handle: JobHandle): Resume {
  const r = handle.resume ?? {};
  return {
    index: typeof r.index === "number" ? r.index : 0,
    submittedAt: typeof r.submittedAt === "number" ? r.submittedAt : 0,
    ...(typeof r.resolution === "string" && { resolution: r.resolution as VideoResolution }),
    ...(typeof r.audio === "boolean" && { audio: r.audio }),
  };
}

/**
 * About five seconds between reads for the first minute, then less often: a video takes minutes,
 * and a busy queue can hold one far longer.
 */
export function pollAfterMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5_000;
  if (elapsedMs < 300_000) return 10_000;
  return 20_000;
}

export type PricedModel = Pick<ModelManifest, "displayName" | "price">;

export async function toJobUpdate(
  handle: JobHandle,
  task: TaskBody,
  ctx: CallContext,
  model: PricedModel,
): Promise<JobUpdate> {
  const resume = resumeOf(handle);
  const next = pollAfterMs(Math.max(0, ctx.now() - resume.submittedAt));
  switch (task.status) {
    case "queued":
      return { state: "queued", nextPollAfterMs: next };
    case "running":
      return { state: "running", nextPollAfterMs: next };
    case "succeeded":
      return { state: "succeeded", result: await harvest(handle, task, ctx, model) };
    case "failed":
      return {
        state: "failed",
        error: redactError(errorFor(task.error ?? undefined, { model: model.displayName }), ctx.log),
      };
    case "expired":
      // Still waiting when its expiry came (execution_expires_after): nothing was made or billed.
      return {
        state: "failed",
        error: new ProviderError("timeout", {
          providerCode: "expired",
          message: `${COMPANY} expired the task before it finished`,
        }),
      };
    case "cancelled":
      return {
        state: "canceled",
        error: new ProviderError("canceled", { message: `${COMPANY} canceled this task` }),
      };
    default:
      // Read the same id again later rather than end a task that may still be running.
      throw new ProviderError("provider_error", {
        message: `Unknown status ${JSON.stringify(task.status)}`,
      });
  }
}

/**
 * A finished task's files, written once per asset sink however often it's polled (§6.3), so a
 * repeated poll returns the same result instead of a second copy. A failed write is forgotten, so
 * the next poll tries again.
 */
const harvested = new WeakMap<AssetSink, Map<string, Promise<JobResult>>>();

function harvest(
  handle: JobHandle,
  task: TaskBody,
  ctx: CallContext,
  model: PricedModel,
): Promise<JobResult> {
  const id = handle.providerRef ?? handle.jobId;
  const bySink = harvested.get(ctx.assets) ?? new Map<string, Promise<JobResult>>();
  harvested.set(ctx.assets, bySink);
  const known = bySink.get(id);
  if (known) return known;
  const pending = toJobResult(handle, task, ctx, model);
  bySink.set(id, pending);
  pending.catch(() => bySink.delete(id));
  return pending;
}

async function toJobResult(
  handle: JobHandle,
  task: TaskBody,
  ctx: CallContext,
  model: PricedModel,
): Promise<JobResult> {
  const raw = task.content?.video_url;
  if (typeof raw !== "string" || !raw) {
    throw new ProviderError("provider_error", { message: "The finished task named no video", final: true });
  }
  // Both addresses are checked before either is fetched, so a stray host writes nothing at all.
  const videoUrl = assetUrl(raw);
  const frameRaw = task.content?.last_frame_url;
  const frameUrl = typeof frameRaw === "string" && frameRaw ? assetUrl(frameRaw) : undefined;
  const resume = resumeOf(handle);

  const video = await download(videoUrl, ctx, "video");
  const written = await ctx.assets.write(video.stream, {
    mimeType: video.mimeType,
    sourceUrl: plain(videoUrl),
  });

  // The last frame is only the fallback poster: a video without it is still a video.
  let poster: GeneratedImage["poster"];
  if (frameUrl) {
    try {
      const frame = await download(frameUrl, ctx, "image");
      const still = await ctx.assets.write(frame.stream, {
        mimeType: frame.mimeType,
        sourceUrl: plain(frameUrl),
      });
      poster = { assetId: still.assetId, mimeType: frame.mimeType };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warn("Couldn't download the video's last frame", { host: frameUrl.host });
    }
  }

  const seconds = typeof task.duration === "number" ? task.duration : undefined;
  const audio = typeof task.generate_audio === "boolean" ? task.generate_audio : resume.audio;
  const durationMs = written.durationMs ?? (seconds !== undefined ? seconds * 1000 : undefined);
  const hasAudio = written.hasAudio ?? audio;
  const image: GeneratedImage = {
    assetId: written.assetId,
    index: resume.index,
    width: written.width,
    height: written.height,
    mimeType: video.mimeType,
    bytes: written.bytes,
    ...(typeof task.seed === "number" && task.seed >= 0 && { seed: task.seed }),
    ...(durationMs !== undefined && { durationMs }),
    ...(hasAudio !== undefined && { hasAudio }),
    ...(poster && { poster }),
  };

  const tokens = task.usage?.completion_tokens ?? task.usage?.total_tokens;
  const resolution = (task.resolution as VideoResolution | undefined) ?? resume.resolution;
  const completedAt = ctx.now();
  const cost = tokens !== undefined && resolution ? costOf(model, tokens, resolution, audio) : undefined;
  return {
    images: [image],
    usage: {
      ...(tokens !== undefined && { outputVideoTokens: tokens, raw: { completion_tokens: tokens } }),
      ...(seconds !== undefined && { seconds }),
    },
    ...(cost && { cost }),
    // Video URLs are signed, so the log keeps only where each came from.
    providerRaw: ctx.log.scrub({
      ...task,
      content: { video_url: plain(videoUrl), ...(frameUrl && { last_frame_url: plain(frameUrl) }) },
    }),
    timings: { submittedAt: resume.submittedAt || completedAt, firstOutputAt: completedAt, completedAt },
    speedUsed: "standard",
  };
}

/** What the company bills: the tokens it counted, at the model's rate (§0.13). */
function costOf(
  model: PricedModel,
  tokens: number,
  resolution: VideoResolution,
  audio: boolean | undefined,
): JobResult["cost"] {
  if (model.price.kind !== "video_tokens") return undefined;
  const rate = videoRate(model.price, resolution, audio);
  if (rate === undefined) return undefined;
  const amount = Math.round(((tokens * rate) / 1e6) * 1e6) / 1e6;
  return {
    currency: DEFAULT_CURRENCY,
    amount,
    confidence: "reconciled",
    basis: t("cost.videoTokens", { tokens, rate: formatMoney(rate, DEFAULT_CURRENCY, true) }),
  };
}

const plain = (url: URL) => `${url.origin}${url.pathname}`;

/** Only https, and only from a declared storage host (§6.11). The host is named so the log says what to allow. */
function assetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("provider_error", { message: "The video address couldn't be read", final: true });
  }
  if (url.protocol !== "https:" || !hostAllowed(url.host, ASSET_HOSTS)) {
    throw new ProviderError("provider_error", {
      message: `The video came from ${url.protocol}//${url.host}, which isn't a declared ${COMPANY} storage host`,
      userMessage: t("errors.videoBlocked"),
      final: true,
    });
  }
  return url;
}

async function download(
  url: URL,
  ctx: CallContext,
  kind: "video" | "image",
): Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string }> {
  let res: Response;
  try {
    // No key: the URL is signed, so the key never reaches the storage host.
    res = await ctx.fetch(url, { signal: ctx.signal });
  } catch (err) {
    throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    // A 5xx may clear up on the next read; a 403 or 404 means the link expired or was used up.
    throw new ProviderError(res.status >= 500 ? errorCodeForStatus(res.status) : "provider_error", {
      httpStatus: res.status,
      message: `Couldn't download the ${kind} from ${url.host}: HTTP ${res.status}`,
      ...(res.status < 500 && { final: true }),
    });
  }
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (kind === "video") {
    return { stream: res.body, mimeType: type?.startsWith("video/") ? type : videoMimeOf(url.pathname) };
  }
  return { stream: res.body, mimeType: type?.startsWith("image/") ? type : "image/jpeg" };
}

function videoMimeOf(path: string): string {
  return path.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4";
}

import { type JobHandle, t } from "@openfield/core";
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
import { statusError } from "./errors";

// A status read (GET /requests/{id}/status) to a JobUpdate. A finished request lists its images as
// URLs; each one is downloaded from a declared host and written through ctx.assets, because
// Higgsfield keeps output for only about seven days.

export interface StatusBody {
  status?: string;
  request_id?: string;
  error?: string | null;
  images?: { url?: string }[];
}

/** What handle.resume carries: enough to shape the result in a process that never saw the request. */
export interface Resume {
  index: number;
  submittedAt: number;
}

export function resumeOf(handle: JobHandle): Resume {
  const r = handle.resume ?? {};
  return {
    index: typeof r.index === "number" ? r.index : 0,
    submittedAt: typeof r.submittedAt === "number" ? r.submittedAt : 0,
  };
}

// Docs: start at two seconds, back off towards ten.
const QUEUED_POLL_MS = 3_000;
const RUNNING_POLL_MS = 2_000;

export async function toJobUpdate(
  handle: JobHandle,
  status: StatusBody,
  ctx: CallContext,
): Promise<JobUpdate> {
  switch (status.status) {
    case "queued":
      return { state: "queued", nextPollAfterMs: QUEUED_POLL_MS };
    case "in_progress":
      return { state: "running", nextPollAfterMs: RUNNING_POLL_MS };
    case "completed":
      return { state: "succeeded", result: await harvest(handle, status, ctx) };
    case "nsfw":
    case "failed":
      return { state: "failed", error: redactError(statusError(status.status, status.error), ctx.log) };
    case "canceled":
      return {
        state: "canceled",
        error: new ProviderError("canceled", { message: `${COMPANY} canceled this request` }),
      };
    default:
      // Read the same id again later rather than end a request that may still be running.
      throw new ProviderError("provider_error", {
        message: `Unknown status ${JSON.stringify(status.status)}`,
      });
  }
}

/**
 * A finished request's images, written once per asset sink however often it's polled (§6.3), so a
 * repeated poll returns the same result instead of a second copy. A failed write is forgotten, so
 * the next poll tries again.
 */
const harvested = new WeakMap<AssetSink, Map<string, Promise<JobResult>>>();

function harvest(handle: JobHandle, status: StatusBody, ctx: CallContext): Promise<JobResult> {
  const id = handle.providerRef ?? handle.jobId;
  const bySink = harvested.get(ctx.assets) ?? new Map<string, Promise<JobResult>>();
  harvested.set(ctx.assets, bySink);
  const known = bySink.get(id);
  if (known) return known;
  const pending = toJobResult(handle, status, ctx);
  bySink.set(id, pending);
  pending.catch(() => bySink.delete(id));
  return pending;
}

async function toJobResult(handle: JobHandle, status: StatusBody, ctx: CallContext): Promise<JobResult> {
  const urls = (status.images ?? []).map((i) => i.url).filter((u): u is string => typeof u === "string");
  if (!urls.length) {
    throw new ProviderError("provider_error", { message: "The finished request listed no image" });
  }
  // Every URL is checked before any is fetched, so a stray host writes nothing at all.
  const checked = urls.map(assetUrl);
  const resume = resumeOf(handle);
  const images: GeneratedImage[] = [];
  for (const [i, url] of checked.entries()) {
    const { stream, mimeType } = await download(url, ctx);
    const written = await ctx.assets.write(stream, { mimeType, sourceUrl: `${url.origin}${url.pathname}` });
    images.push({
      assetId: written.assetId,
      index: resume.index + i,
      width: written.width,
      height: written.height,
      mimeType,
      bytes: written.bytes,
    });
  }
  const completedAt = ctx.now();
  return {
    images,
    usage: { imagesBilled: images.length },
    // Image URLs can be signed, so the log keeps only where each came from.
    providerRaw: ctx.log.scrub({
      ...status,
      images: checked.map((u) => ({ url: `${u.origin}${u.pathname}` })),
    }),
    timings: { submittedAt: resume.submittedAt || completedAt, firstOutputAt: completedAt, completedAt },
    speedUsed: "standard",
  };
}

/** Only https, and only from a host in meta.assetHosts (§6.11). The host is named so the log says what to allow. */
function assetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("provider_error", { message: "The image address couldn't be read" });
  }
  if (url.protocol !== "https:" || !ASSET_HOSTS.includes(url.host)) {
    throw new ProviderError("provider_error", {
      message: `The image came from ${url.protocol}//${url.host}, which isn't a declared ${COMPANY} image host`,
      userMessage: t("errors.imageBlocked"),
    });
  }
  return url;
}

async function download(
  url: URL,
  ctx: CallContext,
): Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string }> {
  let res: Response;
  try {
    // No key: images are fetched as plain links, so the key never reaches the image host.
    res = await ctx.fetch(url, { signal: ctx.signal });
  } catch (err) {
    throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    // A 5xx may clear up on the next read; anything else means the image isn't there to take.
    throw new ProviderError(res.status >= 500 ? errorCodeForStatus(res.status) : "provider_error", {
      httpStatus: res.status,
      message: `Couldn't download the image from ${url.host}: HTTP ${res.status}`,
    });
  }
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return { stream: res.body, mimeType: type?.startsWith("image/") ? type : mimeFromPath(url.pathname) };
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

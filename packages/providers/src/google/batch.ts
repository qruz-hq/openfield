import {
  type BatchHandle,
  batchDisplayName,
  DEFAULT_BATCH_EXPIRY_MS,
  isTerminalBatchState,
  type ModelManifest,
  type NormalizedRequest,
  t,
} from "@openfield/core";
import {
  type BatchApi,
  type BatchItem,
  type BatchUpdate,
  type CallContext,
  isProviderError,
  ProviderError,
  redactError,
} from "../types";
import { API_BASE, COMPANY, DOWNLOAD_BASE } from "./capabilities";
import { mapError, mapRpcStatus, type RpcStatus, refusal } from "./errors";
import { deleteFile, type UploadedFile, uploadFile } from "./files";
import { googleFetch } from "./http";
import { inlineImages } from "./images";
import { type GeminiRequest, type InlineImage, toGeminiRequest } from "./map-request";
import { type GeminiResponse, pickImage, toJobResult } from "./map-response";

// Google's Batch API (§6.13): one batch per job set, each request keyed by its job id, so results
// map back to tiles without guessing at order. Half price, ready within 24 hours, expired with no
// results after the manifest's waitMs.max. Webhooks need a public address, so Openfield polls instead.

/** Google caps an inline create at 20 MB, base64 references included. Stay clear of it. */
export const INLINE_LIMIT_BYTES = 19_000_000;
const LIST_PAGE_SIZE = 100;
const LIST_PAGES = 10;

type BatchState = BatchUpdate["state"];

interface BatchStats {
  requestCount?: string | number;
  successfulRequestCount?: string | number;
  failedRequestCount?: string | number;
  pendingRequestCount?: string | number;
}

interface InlinedResponse {
  metadata?: { key?: string };
  /** The JSONL results file puts the key at the top level. */
  key?: string;
  response?: GeminiResponse;
  error?: RpcStatus;
}

interface BatchOutput {
  inlinedResponses?: { inlinedResponses?: InlinedResponse[] };
  responsesFile?: string;
}

/** A long-running Operation, as GET /v1beta/batches/{id} returns it. */
interface BatchOperation {
  name?: string;
  metadata?: {
    name?: string;
    displayName?: string;
    state?: string;
    createTime?: string;
    batchStats?: BatchStats;
    output?: BatchOutput;
  };
  done?: boolean;
  response?: BatchOutput;
  error?: RpcStatus;
}

/** What poll, cancel and cleanup need, stored on the handle so it survives a restart. */
interface Resume {
  /** Job ids in request order, for results that come back without their key. */
  keys: string[];
  /** Files uploaded for this batch, deleted at cleanup. */
  uploads: string[];
  submittedAt: number;
}

function resumeOf(handle: BatchHandle, expiryMs: number): Resume {
  const r = handle.resume ?? {};
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    keys: strings(r.keys),
    uploads: strings(r.uploads),
    submittedAt: typeof r.submittedAt === "number" ? r.submittedAt : Date.parse(handle.expiresAt) - expiryMs,
  };
}

/**
 * Uploads from a create call that never answered, by display name. The batch may exist and use
 * them, so they stay until the runner knows: a find() that hits takes them on for cleanup, and a
 * second submit (sent only once find() came back empty) deletes them first. Held in memory only;
 * Google deletes uploads after 48 hours anyway.
 */
const unanswered = new Map<string, string[]>();

export function googleBatch(manifest: ModelManifest): BatchApi {
  const expiryMs = manifest.speeds?.find((o) => o.id === "batch")?.waitMs.max ?? DEFAULT_BATCH_EXPIRY_MS;
  const expiresAt = (submittedAt: number) => new Date(submittedAt + expiryMs).toISOString();
  return {
    async submit(reqs, ctx) {
      const first = reqs[0];
      if (!first)
        throw new ProviderError("invalid_request", { message: "A batch needs at least one request" });
      const displayName = batchDisplayName(first.jobSetId);
      const stale = unanswered.get(displayName) ?? [];
      unanswered.delete(displayName);
      await deleteQuietly(
        ctx,
        stale.map((name) => ({ name })),
      );

      const requests = [];
      for (const req of reqs)
        requests.push({ request: await batchRequest(manifest, req, ctx), metadata: { key: req.jobId } });
      // References repeat in every request. Over the limit, each is uploaded once and pointed at.
      const uploads =
        sizeOf(requests) > INLINE_LIMIT_BYTES ? await moveImagesToFiles(requests, ctx, displayName) : [];
      if (sizeOf(requests) > INLINE_LIMIT_BYTES) {
        await deleteQuietly(ctx, uploads);
        throw new ProviderError("payload_too_large", { message: "The batch is over Google's size limit" });
      }

      const url = `${API_BASE}/models/${encodeURIComponent(manifest.modelId)}:batchGenerateContent`;
      const body = JSON.stringify({ batch: { displayName, inputConfig: { requests: { requests } } } });
      ctx.log.debug("Gemini batch create", {
        model: manifest.modelId,
        requests: reqs.length,
        uploads: uploads.length,
      });
      const names = uploads.map((u) => u.name);
      const init = { method: "POST", headers: { "content-type": "application/json" }, body };
      const { res, body: answer } = await googleFetch(ctx, url, init).catch((err: unknown) => {
        if (names.length) unanswered.set(displayName, names);
        throw err;
      });
      const op = answer as BatchOperation | undefined;
      const remoteId = op?.name ?? op?.metadata?.name;
      if (!res.ok || !remoteId?.startsWith("batches/")) {
        // Google refused it, or answered without a batch to point at: nothing uses the uploads.
        await deleteQuietly(ctx, uploads);
        if (!res.ok) throw redactError(await mapError(res, answer), ctx.log);
        throw new ProviderError("provider_error", { message: "Google's batch answer had no batch id" });
      }
      const resume: Resume = {
        keys: reqs.map((r) => r.jobId),
        uploads: names,
        submittedAt: createdAt(op, ctx),
      };
      return { remoteId, displayName, expiresAt: expiresAt(resume.submittedAt), resume: { ...resume } };
    },

    async poll(handle, ctx, opts) {
      const { res, body } = await googleFetch(ctx, `${API_BASE}/${handle.remoteId}`);
      if (!res.ok) throw redactError(await readError(res, body), ctx.log);
      const op = (body ?? {}) as BatchOperation;
      const resume = resumeOf(handle, expiryMs);
      const state = stateOf(op);
      const counts = countsOf(op, resume.keys.length);
      if (!isTerminalBatchState(state)) return { state, ...(counts && { counts }) };

      const error = state === "failed" ? redactError(await mapRpcStatus(op.error), ctx.log) : undefined;
      const items = await harvest(op, resume, ctx, opts.harvest, state, error, expiryMs);
      return { state, ...(counts && { counts }), items, ...(error && { error }) };
    },

    async cancel(handle, ctx) {
      const { res, body } = await googleFetch(ctx, `${API_BASE}/${handle.remoteId}:cancel`, {
        method: "POST",
      });
      if (res.ok || res.status === 404) return;
      const err = await mapError(res, body);
      // Already finished: there's nothing left to stop.
      if (err.providerCode?.startsWith("FAILED_PRECONDITION")) return;
      throw redactError(err, ctx.log);
    },

    async cleanup(handle, ctx) {
      // Delete doesn't cancel, so the runner cancels first when a run is canceled.
      const { res, body } = await googleFetch(ctx, `${API_BASE}/${handle.remoteId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw redactError(await mapError(res, body), ctx.log);
      await deleteQuietly(
        ctx,
        resumeOf(handle, expiryMs).uploads.map((name) => ({ name })),
      );
    },

    async find(displayName, ctx) {
      let pageToken: string | undefined;
      for (let page = 0; page < LIST_PAGES; page++) {
        const url = new URL(`${API_BASE}/batches`);
        url.searchParams.set("pageSize", String(LIST_PAGE_SIZE));
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const { res, body } = await googleFetch(ctx, url);
        if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
        const list = body as {
          operations?: BatchOperation[];
          batches?: BatchOperation[];
          nextPageToken?: string;
        };
        const hit = (list?.operations ?? list?.batches ?? []).find(
          (op) => op.metadata?.displayName === displayName,
        );
        if (hit?.name) {
          const submittedAt = createdAt(hit, ctx);
          const resume: Resume = { keys: [], uploads: unanswered.get(displayName) ?? [], submittedAt };
          unanswered.delete(displayName);
          return {
            remoteId: hit.name,
            displayName,
            expiresAt: expiresAt(submittedAt),
            resume: { ...resume },
          };
        }
        pageToken = list?.nextPageToken;
        if (!pageToken) break;
      }
      return null;
    },
  };
}

/** The same generateContent body as a sync call, without serviceTier: Batch is its own endpoint. */
async function batchRequest(
  manifest: ModelManifest,
  req: NormalizedRequest,
  ctx: CallContext,
): Promise<GeminiRequest> {
  if (req.op !== "generate" && req.op !== "edit") {
    throw new ProviderError("capability_unsupported", { message: `${manifest.displayName} can't ${req.op}` });
  }
  return toGeminiRequest(manifest, req, await inlineImages(manifest, req, ctx));
}

const sizeOf = (requests: unknown) => Buffer.byteLength(JSON.stringify(requests));

/** Uploads each distinct inline image once and swaps every copy for a file reference. */
async function moveImagesToFiles(
  requests: { request: GeminiRequest }[],
  ctx: CallContext,
  displayName: string,
): Promise<UploadedFile[]> {
  const distinct = new Map<string, InlineImage>();
  for (const { request } of requests) {
    for (const part of request.contents[0]?.parts ?? []) {
      if ("inlineData" in part) distinct.set(part.inlineData.data, part.inlineData);
    }
  }
  const uploads: UploadedFile[] = [];
  const byData = new Map<string, UploadedFile>();
  try {
    for (const [data, image] of distinct) {
      const file = await uploadFile(ctx, {
        bytes: new Uint8Array(Buffer.from(data, "base64")),
        mimeType: image.mimeType,
        displayName: `${displayName}-${uploads.length}`,
      });
      uploads.push(file);
      byData.set(data, file);
    }
  } catch (err) {
    await deleteQuietly(ctx, uploads);
    throw err;
  }
  for (const { request } of requests) {
    for (const content of request.contents) {
      content.parts = content.parts.map((part) => {
        const file = "inlineData" in part ? byData.get(part.inlineData.data) : undefined;
        return file ? { fileData: { mimeType: file.mimeType, fileUri: file.fileUri } } : part;
      });
    }
  }
  return uploads;
}

async function deleteQuietly(ctx: CallContext, files: readonly Pick<UploadedFile, "name">[]): Promise<void> {
  for (const file of files) {
    try {
      await deleteFile(ctx, file.name);
    } catch {
      // Google deletes uploads after 48 hours anyway.
      ctx.log.warn("Couldn't delete an uploaded reference", { name: file.name });
    }
  }
}

function createdAt(op: BatchOperation | undefined, ctx: CallContext): number {
  const at = Date.parse(op?.metadata?.createTime ?? "");
  return Number.isNaN(at) ? ctx.now() : at;
}

/**
 * A batch this key can't read: most often it was sent with another key's project, or it's gone.
 * Only the runner knows which key sent it, so it picks the words (§0.5).
 */
async function readError(res: Response, body: unknown): Promise<ProviderError> {
  const err = await mapError(res, body);
  if (res.status === 403 || res.status === 404) {
    return new ProviderError("auth_forbidden", {
      httpStatus: res.status,
      ...(err.providerCode && { providerCode: err.providerCode }),
      message: err.message,
    });
  }
  return err;
}

/** BATCH_STATE_* on the REST surface, JOB_STATE_* in the SDK's spelling: both are read. */
function stateOf(op: BatchOperation): BatchState {
  const raw = op.metadata?.state?.toUpperCase().replace(/^(BATCH|JOB)_STATE_/, "");
  switch (raw) {
    case "RUNNING":
    case "CANCELLING":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "EXPIRED":
      return "expired";
    case "PENDING":
    case "QUEUED":
    case "UNSPECIFIED":
      return "queued";
    default:
      if (!op.done) return "queued";
      return op.error ? "failed" : "succeeded";
  }
}

/** batchStats counts are int64 strings. */
function countsOf(op: BatchOperation, knownTotal: number): BatchUpdate["counts"] {
  const stats = op.metadata?.batchStats;
  if (!stats) return undefined;
  const n = (v: string | number | undefined) => {
    const value = Number(v ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const total = n(stats.requestCount) || knownTotal;
  const succeeded = n(stats.successfulRequestCount);
  const failed = n(stats.failedRequestCount);
  const pending =
    stats.pendingRequestCount === undefined
      ? Math.max(0, total - succeeded - failed)
      : n(stats.pendingRequestCount);
  return { total, succeeded, failed, pending };
}

/** Results inline (nested twice), or a JSONL file to download. */
async function responsesOf(op: BatchOperation, ctx: CallContext): Promise<InlinedResponse[]> {
  const output = op.metadata?.output ?? op.response;
  const inline = output?.inlinedResponses?.inlinedResponses;
  if (inline) return inline;
  if (!output?.responsesFile) return [];

  const url = `${DOWNLOAD_BASE}/${output.responsesFile}:download?alt=media`;
  const { res, body } = await googleFetch(ctx, url, {}, { as: "text" });
  const text = String(body ?? "");
  if (!res.ok) throw redactError(await mapError(res, safeJson(text)), ctx.log);
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => (safeJson(line) ?? {}) as InlinedResponse);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One item per job id in `wanted`, and only those, so a harvest cut short by a restart never writes
 * an image twice. A job with no result by the end comes back as an error for its tile.
 */
async function harvest(
  op: BatchOperation,
  resume: Resume,
  ctx: CallContext,
  wanted: readonly string[],
  state: BatchState,
  batchError: ProviderError | undefined,
  expiryMs: number,
): Promise<BatchItem[]> {
  const want = new Set(wanted);
  const done = new Set<string>();
  const items: BatchItem[] = [];
  const entries = await responsesOf(op, ctx);

  for (const [i, entry] of entries.entries()) {
    const jobId = entry.metadata?.key ?? entry.key ?? resume.keys[i];
    if (!jobId || !want.has(jobId) || done.has(jobId)) continue;
    done.add(jobId);
    const index = resume.keys.includes(jobId) ? resume.keys.indexOf(jobId) : i;
    items.push(await itemOf(jobId, entry, index, resume.submittedAt, ctx));
  }
  for (const jobId of wanted) {
    if (!done.has(jobId)) items.push({ jobId, ok: false, error: unfinished(state, batchError, expiryMs) });
  }
  return items;
}

async function itemOf(
  jobId: string,
  entry: InlinedResponse,
  index: number,
  submittedAt: number,
  ctx: CallContext,
): Promise<BatchItem> {
  // Each result goes through the same mappers as a sync call, so a safety block is content_refused.
  if (entry.error) return { jobId, ok: false, error: redactError(await mapRpcStatus(entry.error), ctx.log) };
  const response = entry.response ?? {};
  let image: ReturnType<typeof pickImage>;
  try {
    image = pickImage(response);
  } catch (err) {
    if (isProviderError(err)) return { jobId, ok: false, error: err };
    throw err;
  }
  if (!image) {
    const error =
      refusal(response) ?? new ProviderError("provider_error", { message: "The result held no image" });
    return { jobId, ok: false, error };
  }
  try {
    const result = await toJobResult(response, image, { batchIndex: index }, ctx, submittedAt, "batch");
    return { jobId, ok: true, result };
  } catch (err) {
    // Saving it failed on our side (a full disk, bytes that aren't an image): only this job is hit.
    if (isProviderError(err)) return { jobId, ok: false, error: err };
    throw err;
  }
}

function unfinished(
  state: BatchState,
  batchError: ProviderError | undefined,
  expiryMs: number,
): ProviderError {
  switch (state) {
    case "expired":
      return new ProviderError("timeout", {
        message: "The batch expired before this image was made",
        userMessage: t("errors.batchExpired", { company: COMPANY, hours: Math.round(expiryMs / 3_600_000) }),
      });
    case "canceled":
      return new ProviderError("canceled", { message: "The batch was canceled before this image was made" });
    case "failed":
      return batchError ?? new ProviderError("provider_error", { message: "The batch failed" });
    default:
      return new ProviderError("provider_error", { message: "Google sent no result for this image" });
  }
}

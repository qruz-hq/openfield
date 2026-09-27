import {
  type BatchHandle,
  batchDisplayName,
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
import { API_BASE, COMPANY } from "./capabilities";
import { mapError } from "./errors";
import { openAiFetch } from "./http";
import { dataUrlOf, editInputs } from "./images";
import { endpointFor, toImageFields } from "./map-request";
import { type ImagesResponse, toJobResult } from "./map-response";

// OpenAI's Batch API (§6.14): one JSONL file per job set, one line per image keyed by its job id
// (custom_id), because the results file doesn't keep line order. Half price, a 24-hour window, and
// the only way to find a batch again is its metadata, which carries the run's display name.

/** OpenAI's own limit per input file is 200 MB. */
const FILE_LIMIT_BYTES = 200_000_000;
const WINDOW_MS = 24 * 3_600_000;
const LIST_PAGE_SIZE = 100;
const LIST_PAGES = 10;
const METADATA_KEY = "openfield_job_set";

type BatchState = BatchUpdate["state"];

interface OpenAiBatch {
  id?: string;
  status?: string;
  created_at?: number;
  expires_at?: number;
  output_file_id?: string | null;
  error_file_id?: string | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
  metadata?: Record<string, string> | null;
  errors?: { data?: { code?: string; message?: string; param?: string | null; line?: number | null }[] };
}

interface ResultLine {
  custom_id?: string;
  response?: { status_code?: number; body?: unknown } | null;
  error?: { code?: string; message?: string } | null;
}

/** What poll, cancel and cleanup need, stored on the handle so it survives a restart. */
interface Resume {
  /** Job ids in request order: a line's position in the job set. */
  keys: string[];
  /** The uploaded JSONL, deleted at cleanup. */
  inputFileId?: string;
  submittedAt: number;
}

function resumeOf(handle: BatchHandle): Resume {
  const r = handle.resume ?? {};
  const keys = Array.isArray(r.keys) ? r.keys.filter((k): k is string => typeof k === "string") : [];
  return {
    keys,
    ...(typeof r.inputFileId === "string" && { inputFileId: r.inputFileId }),
    submittedAt: typeof r.submittedAt === "number" ? r.submittedAt : Date.parse(handle.expiresAt) - WINDOW_MS,
  };
}

/**
 * Input files from a create call that never answered, by display name. The batch may exist and use
 * them, so they stay until the runner knows: find() takes them on for cleanup, and a second submit
 * (sent only once find() came back empty) deletes them first. Held in memory only.
 */
const unanswered = new Map<string, string>();

export function openAiBatch(manifest: ModelManifest): BatchApi {
  const price = manifest.speeds?.find((o) => o.id === "batch")?.price ?? manifest.price;
  return {
    async submit(reqs, ctx) {
      const first = reqs[0];
      if (!first)
        throw new ProviderError("invalid_request", { message: "A batch needs at least one request" });
      const displayName = batchDisplayName(first.jobSetId);
      const stale = unanswered.get(displayName);
      unanswered.delete(displayName);
      if (stale) await deleteQuietly(ctx, [stale]);

      // One endpoint per batch. A job set shares its references, so every line goes to the same one.
      const endpoint = `/v1/images/${endpointFor(first)}`;
      const lines: string[] = [];
      for (const req of reqs) {
        if (`/v1/images/${endpointFor(req)}` !== endpoint) {
          throw new ProviderError("invalid_request", { message: "A batch can't mix edits and generations" });
        }
        lines.push(
          JSON.stringify({
            custom_id: req.jobId,
            method: "POST",
            url: endpoint,
            body: await lineBody(manifest, req, ctx),
          }),
        );
      }
      const jsonl = `${lines.join("\n")}\n`;
      if (Buffer.byteLength(jsonl) > FILE_LIMIT_BYTES) {
        throw new ProviderError("payload_too_large", {
          message: "The batch is over OpenAI's 200 MB file limit",
        });
      }

      const inputFileId = await uploadInput(ctx, jsonl, displayName);
      ctx.log.debug("OpenAI batch create", { model: manifest.modelId, requests: reqs.length, endpoint });
      const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint,
          completion_window: "24h",
          metadata: { [METADATA_KEY]: displayName },
        }),
      };
      const { res, body } = await openAiFetch(ctx, `${API_BASE}/batches`, init).catch((err: unknown) => {
        unanswered.set(displayName, inputFileId);
        throw err;
      });
      const batch = body as OpenAiBatch | undefined;
      if (!res.ok || !batch?.id) {
        // OpenAI refused it, or answered without a batch to point at: nothing uses the file.
        await deleteQuietly(ctx, [inputFileId]);
        if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
        throw new ProviderError("provider_error", { message: "OpenAI's batch answer had no batch id" });
      }
      const resume: Resume = {
        keys: reqs.map((r) => r.jobId),
        inputFileId,
        submittedAt: createdAt(batch, ctx),
      };
      return {
        remoteId: batch.id,
        displayName,
        expiresAt: expiresAt(batch, resume.submittedAt),
        resume: { ...resume },
      };
    },

    async poll(handle, ctx, opts) {
      const { res, body } = await openAiFetch(
        ctx,
        `${API_BASE}/batches/${encodeURIComponent(handle.remoteId)}`,
      );
      if (!res.ok) throw redactError(await readError(res, body), ctx.log);
      const batch = (body ?? {}) as OpenAiBatch;
      const state = stateOf(batch.status);
      const counts = countsOf(batch, resumeOf(handle).keys.length);
      if (!isTerminalBatchState(state)) return { state, ...(counts && { counts }) };

      const error = state === "failed" ? batchError(batch) : undefined;
      const items = await harvest(batch, resumeOf(handle), ctx, opts.harvest, state, error, price);
      return {
        state,
        ...(counts && { counts }),
        items,
        ...(error && { error: redactError(error, ctx.log) }),
      };
    },

    async cancel(handle, ctx) {
      const url = `${API_BASE}/batches/${encodeURIComponent(handle.remoteId)}/cancel`;
      const { res, body } = await openAiFetch(ctx, url, { method: "POST" });
      // Gone, or already finished: there's nothing left to stop.
      if (res.ok || res.status === 404 || res.status === 400 || res.status === 409) return;
      throw redactError(await mapError(res, body), ctx.log);
    },

    async cleanup(handle, ctx) {
      // OpenAI has no batch delete; the files are what take up room.
      const { res, body } = await openAiFetch(
        ctx,
        `${API_BASE}/batches/${encodeURIComponent(handle.remoteId)}`,
      );
      const batch = res.ok ? ((body ?? {}) as OpenAiBatch) : {};
      const ids = [resumeOf(handle).inputFileId, batch.output_file_id, batch.error_file_id].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      await deleteQuietly(ctx, ids);
    },

    async find(displayName, ctx) {
      let after: string | undefined;
      for (let page = 0; page < LIST_PAGES; page++) {
        const url = new URL(`${API_BASE}/batches`);
        url.searchParams.set("limit", String(LIST_PAGE_SIZE));
        if (after) url.searchParams.set("after", after);
        const { res, body } = await openAiFetch(ctx, url);
        if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
        const list = body as { data?: OpenAiBatch[]; has_more?: boolean; last_id?: string } | undefined;
        const hit = (list?.data ?? []).find((b) => b.metadata?.[METADATA_KEY] === displayName);
        if (hit?.id) {
          const submittedAt = createdAt(hit, ctx);
          const inputFileId = unanswered.get(displayName);
          unanswered.delete(displayName);
          const resume: Resume = { keys: [], ...(inputFileId && { inputFileId }), submittedAt };
          return {
            remoteId: hit.id,
            displayName,
            expiresAt: expiresAt(hit, submittedAt),
            resume: { ...resume },
          };
        }
        after = list?.last_id ?? list?.data?.at(-1)?.id;
        if (!list?.has_more || !after) break;
      }
      return null;
    },
  };
}

/** A line's body: the same fields as a sync call, one image each so every tile fails on its own. */
async function lineBody(manifest: ModelManifest, req: NormalizedRequest, ctx: CallContext) {
  if (req.op !== "generate") {
    throw new ProviderError("capability_unsupported", {
      message: `${manifest.displayName} can't ${req.op} at Batch`,
    });
  }
  const fields = { ...toImageFields(manifest, req), n: 1 };
  if (endpointFor(req) === "generations") return fields;
  // References go through the JSON form of /v1/images/edits, as data URLs: a JSONL line can't carry
  // a multipart upload.
  const inputs = await editInputs(manifest, req, ctx);
  return { ...fields, images: inputs.images.map((image) => ({ image_url: dataUrlOf(image) })) };
}

async function uploadInput(ctx: CallContext, jsonl: string, displayName: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${displayName}.jsonl`);
  const { res, body } = await openAiFetch(ctx, `${API_BASE}/files`, { method: "POST", body: form });
  const id = (body as { id?: unknown } | undefined)?.id;
  if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
  if (typeof id !== "string")
    throw new ProviderError("provider_error", { message: "OpenAI's upload answer had no file id" });
  return id;
}

async function deleteQuietly(ctx: CallContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      const { res } = await openAiFetch(ctx, `${API_BASE}/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404)
        ctx.log.warn("Couldn't delete a batch file", { id, status: res.status });
    } catch {
      ctx.log.warn("Couldn't delete a batch file", { id });
    }
  }
}

const createdAt = (batch: OpenAiBatch, ctx: CallContext) =>
  typeof batch.created_at === "number" ? batch.created_at * 1000 : ctx.now();

const expiresAt = (batch: OpenAiBatch, submittedAt: number) =>
  new Date(
    typeof batch.expires_at === "number" ? batch.expires_at * 1000 : submittedAt + WINDOW_MS,
  ).toISOString();

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

function stateOf(status: string | undefined): BatchState {
  switch (status) {
    case "in_progress":
    case "finalizing":
    case "cancelling":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return "queued";
  }
}

function countsOf(batch: OpenAiBatch, knownTotal: number): BatchUpdate["counts"] {
  const c = batch.request_counts;
  if (!c) return undefined;
  const total = c.total || knownTotal;
  const succeeded = c.completed ?? 0;
  const failed = c.failed ?? 0;
  return { total, succeeded, failed, pending: Math.max(0, total - succeeded - failed) };
}

/** A failed batch says why in errors.data: a bad line, most often, or a file OpenAI couldn't read. */
function batchError(batch: OpenAiBatch): ProviderError {
  const first = batch.errors?.data?.[0];
  return new ProviderError(
    first?.code === "invalid_request" || first?.param ? "invalid_request" : "provider_error",
    {
      ...(first?.code && { providerCode: first.code }),
      message: first?.message ?? "The batch failed",
    },
  );
}

async function readLines(ctx: CallContext, fileId: string | null | undefined): Promise<ResultLine[]> {
  if (!fileId) return [];
  const url = `${API_BASE}/files/${encodeURIComponent(fileId)}/content`;
  const { res, body } = await openAiFetch(ctx, url, {}, { as: "text" });
  const text = String(body ?? "");
  if (!res.ok) throw redactError(await mapError(res, safeJson(text)), ctx.log);
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => (safeJson(line) ?? {}) as ResultLine);
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
 * an image twice. Results and errors both come keyed by custom_id; a job in neither ends the way
 * the batch did.
 */
async function harvest(
  batch: OpenAiBatch,
  resume: Resume,
  ctx: CallContext,
  wanted: readonly string[],
  state: BatchState,
  batchErr: ProviderError | undefined,
  price: ModelManifest["price"],
): Promise<BatchItem[]> {
  const lines = [
    ...(await readLines(ctx, batch.output_file_id)),
    ...(await readLines(ctx, batch.error_file_id)),
  ];
  // The files keep no order, so each line is found by its custom_id, and items follow `wanted`.
  const byJob = new Map<string, ResultLine>();
  for (const line of lines) if (line.custom_id && !byJob.has(line.custom_id)) byJob.set(line.custom_id, line);
  const items: BatchItem[] = [];
  for (const jobId of wanted) {
    const line = byJob.get(jobId);
    const index = Math.max(0, resume.keys.indexOf(jobId));
    items.push(
      line
        ? await itemOf(jobId, line, index, resume.submittedAt, ctx, price)
        : { jobId, ok: false, error: unfinished(state, batchErr) },
    );
  }
  return items;
}

async function itemOf(
  jobId: string,
  line: ResultLine,
  index: number,
  submittedAt: number,
  ctx: CallContext,
  price: ModelManifest["price"],
): Promise<BatchItem> {
  if (line.error) {
    const expired = line.error.code === "batch_expired";
    const error = expired
      ? unfinished("expired", undefined)
      : new ProviderError("provider_error", {
          ...(line.error.code && { providerCode: line.error.code }),
          message: line.error.message ?? "OpenAI sent an error for this image",
        });
    return { jobId, ok: false, error: redactError(error, ctx.log) };
  }
  const status = line.response?.status_code ?? 500;
  const body = line.response?.body;
  // Each result goes through the same mappers as a sync call, so a safety block is content_refused.
  if (status < 200 || status >= 300) {
    return {
      jobId,
      ok: false,
      error: redactError(await mapError(new Response(null, { status }), body), ctx.log),
    };
  }
  try {
    const result = await toJobResult((body ?? {}) as ImagesResponse, { batchIndex: index }, ctx, {
      submittedAt,
      price,
      speed: "batch",
    });
    return { jobId, ok: true, result };
  } catch (err) {
    // Saving it failed on our side (a full disk, bytes that aren't an image): only this job is hit.
    if (isProviderError(err)) return { jobId, ok: false, error: err };
    throw err;
  }
}

function unfinished(state: BatchState, batchErr: ProviderError | undefined): ProviderError {
  switch (state) {
    case "expired":
      return new ProviderError("timeout", {
        message: "The batch expired before this image was made",
        userMessage: t("errors.batchExpired", { company: COMPANY, hours: WINDOW_MS / 3_600_000 }),
      });
    case "canceled":
      return new ProviderError("canceled", { message: "The batch was canceled before this image was made" });
    case "failed":
      return batchErr ?? new ProviderError("provider_error", { message: "The batch failed" });
    default:
      return new ProviderError("provider_error", { message: "OpenAI sent no result for this image" });
  }
}

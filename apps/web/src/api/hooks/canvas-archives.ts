import {
  CANVAS_IMPORT_CHUNK_BYTES,
  type CanvasArchiveJob,
  type CanvasImportBody,
  type SseEvent,
} from "@openfield/core";
import { api, call } from "../client";
import { subscribeEvents } from "../events";
import { ApiError, rawFetch, toApiError } from "../raw";

// Canvas archives (§7.8): a canvas with every image it shows, as one .ofcanvas.zip.
//   GET    /api/canvases/:id/export?graphVersion=           → the zip, streamed
//   POST   /api/canvases/:id/export-to {path, overwrite}     → CanvasArchiveJob (desktop app only)
//   POST   /api/canvas-imports {path | uploadId, name?}      → CanvasArchiveJob
//   POST   /api/canvas-imports/uploads                       → {uploadId}
//   PUT    /api/canvas-imports/uploads/:id/files?path=&offset= (raw bytes) → {path, size}
//   POST   /api/canvas-imports/uploads/:id/needed            → {files}
//   DELETE /api/canvas-imports/uploads/:id
//   GET    /api/canvas-archive-jobs/:id                      → CanvasArchiveJob
//   DELETE /api/canvas-archive-jobs/:id (cancel)             → CanvasArchiveJob
// Jobs report on the event stream (canvas_archive.updated); followArchiveJob also asks now and
// then, which covers frames sent before it listened and a stream that dropped.

/** The zip's exact size. Bun drops Content-Length on a streamed body, so it rides here too. */
export const ZIP_BYTES_HEADER = "x-openfield-zip-bytes";
/** How many images the canvas shows that weren't in the library to pack. */
export const ARCHIVE_MISSING_HEADER = "x-openfield-archive-missing";

const FINISHED: ReadonlySet<CanvasArchiveJob["state"]> = new Set(["done", "failed", "canceled"]);
export const isFinished = (job: CanvasArchiveJob) => FINISHED.has(job.state);

/** The archive as the server has the canvas saved. 409 when it moved on past `graphVersion`. */
export async function fetchCanvasArchive(
  canvasId: string,
  opts: { graphVersion?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const query = opts.graphVersion === undefined ? "" : `?graphVersion=${opts.graphVersion}`;
  const res = await rawFetch(`/api/canvases/${canvasId}/export${query}`, {
    ...(opts.signal && { signal: opts.signal }),
  });
  if (!res.ok) throw await toApiError(res);
  return res;
}

/** The desktop app's save dialog picked `path`, and already asked about replacing a file there. */
export const exportCanvasTo = (canvasId: string, path: string) =>
  call(
    api.api.canvases[":id"]["export-to"].$post({ param: { id: canvasId }, json: { path, overwrite: true } }),
  );

export const startCanvasImport = (body: CanvasImportBody) =>
  call(api.api["canvas-imports"].$post({ json: body }));

export const createImportUpload = () => call(api.api["canvas-imports"].uploads.$post());

/** The files of a folder the library doesn't have yet, once canvas.json and manifest.json are up. */
export const neededImportFiles = async (uploadId: string) =>
  (await call(api.api["canvas-imports"].uploads[":uploadId"].needed.$post({ param: { uploadId } }))).files;

export const dropImportUpload = (uploadId: string) =>
  call(api.api["canvas-imports"].uploads[":uploadId"].$delete({ param: { uploadId } }));

export const fetchArchiveJob = (jobId: string) =>
  call(api.api["canvas-archive-jobs"][":id"].$get({ param: { id: jobId } }));

/** Asks the job to stop. It ends "canceled" a moment later, on the stream. */
export const cancelArchiveJob = (jobId: string) =>
  call(api.api["canvas-archive-jobs"][":id"].$delete({ param: { id: jobId } }));

/** Where each piece of a file starts and ends. An empty file is still one (empty) piece. */
export function piecesOf(size: number, chunk = CANVAS_IMPORT_CHUNK_BYTES): { start: number; end: number }[] {
  if (size <= 0) return [{ start: 0, end: 0 }];
  const pieces: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += chunk)
    pieces.push({ start, end: Math.min(size, start + chunk) });
  return pieces;
}

/**
 * Sends one file into an upload at `path`, in pieces the route takes. `onBytes` hears each piece
 * as it lands. Throws ApiError, or the AbortError when `signal` fires.
 */
export async function sendImportFile(
  uploadId: string,
  path: string,
  file: Blob,
  opts: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
): Promise<void> {
  for (const { start, end } of piecesOf(file.size)) {
    const query = new URLSearchParams({ path, offset: String(start) });
    const res = await rawFetch(`/api/canvas-imports/uploads/${uploadId}/files?${query}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      // A Blob, so fetch knows the length up front.
      body: file.slice(start, end),
      ...(opts.signal && { signal: opts.signal }),
    });
    if (!res.ok) throw await toApiError(res);
    // The reply is the size so far, which the loop already knows.
    await res.body?.cancel();
    opts.onBytes?.(end - start);
  }
}

export interface FollowOptions {
  onUpdate?: (job: CanvasArchiveJob) => void;
  /** How often to ask the server as well. */
  pollMs?: number;
  // Seams for tests.
  subscribe?: (listener: (event: SseEvent) => void) => () => void;
  fetchJob?: (jobId: string) => Promise<CanvasArchiveJob>;
}

/**
 * Resolves with the job once it's done, failed or canceled, calling onUpdate on the way; whatever
 * arrives after that is ignored. Rejects when the server no longer knows the job (it restarted).
 */
export function followArchiveJob(job: CanvasArchiveJob, opts: FollowOptions = {}): Promise<CanvasArchiveJob> {
  const { onUpdate, pollMs = 2000, subscribe = subscribeEvents, fetchJob = fetchArchiveJob } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
    const take = (next: CanvasArchiveJob) => {
      if (settled || next.jobId !== job.jobId) return;
      onUpdate?.(next);
      if (!isFinished(next)) return;
      stop();
      resolve(next);
    };
    const unsubscribe = subscribe((event) => {
      if (event.event === "canvas_archive.updated") take(event.data);
    });
    const poll = async () => {
      try {
        take(await fetchJob(job.jobId));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && !settled) {
          stop();
          reject(error);
          return;
        }
        // Offline for a moment: the next poll or the stream picks it up.
      }
      if (!settled) timer = setTimeout(poll, pollMs);
    };
    take(job);
    if (!settled) void poll();
  });
}

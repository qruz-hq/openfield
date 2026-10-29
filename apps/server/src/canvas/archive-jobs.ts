import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { documentAssetRefs, type EngineContext } from "@openfield/canvas";
import {
  type ApiErrorCode,
  type CanvasArchiveAsset,
  type CanvasArchiveJob,
  type CanvasArchiveJobKind,
  canvasArchiveAssetSchema,
  newId,
  t,
} from "@openfield/core";
import { type Db, findLiveAssetBySha256, getAsset } from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import type { HomePaths } from "../config/home";
import type { EventHub } from "../events/hub";
import type { Ingest } from "../files/ingest";
import type { Thumbs } from "../files/thumbs";
import { ApiFailure } from "../http/errors";
import type { Logger } from "../log/logger";
import type { SettingsService } from "../services/settings";
import { type ArchivePlan, archiveStream, planExport } from "./archive";
import { archivedMasks, CANVAS_JSON_MAX, importArchive, MANIFEST_MAX } from "./archive-import";
import { type ArchiveSource, CANVAS_FILE, MANIFEST_FILE, openArchiveSource } from "./archive-source";
import type { CanvasService } from "./canvases";
import { readDocument } from "./documents";

// Canvas exports and imports as jobs (§7.8). A big archive takes longer than a request may sit
// quiet (Bun's idleTimeout), so the route answers at once and the event stream carries the job
// (canvas_archive.updated) until it's done, failed or canceled. A canceled import leaves nothing
// behind, and a canceled export no half-written file. Imports go one at a time, so two of the same
// archive can't both claim an image id. The browser, which has no paths, sends an archive's files
// into a staging area first, in pieces.

export interface ArchiveServiceDeps {
  db: Db;
  paths: HomePaths;
  ingest: Ingest;
  thumbs: Thumbs;
  events: EventHub;
  logger: Logger;
  settings: SettingsService;
  canvases: CanvasService;
  engineContext: () => EngineContext;
  version: string;
}

interface Job {
  state: CanvasArchiveJob;
  controller: AbortController;
  /** Once the import is writing to the library, a cancel can't take it back. */
  committing: boolean;
  done: Promise<void>;
  lastSent: number;
  pending: ReturnType<typeof setTimeout> | null;
}

interface Upload {
  dir: string;
  touchedAt: number;
  /** An import is reading it. */
  busy: boolean;
}

/** At most 10 frames a second per job, like canvas_run.updated. */
const SEND_EVERY_MS = 100;
/** A finished job can still be asked about for this long. */
const KEEP_FINISHED_MS = 15 * 60_000;
/** An upload nothing has touched for this long is cleared away. */
const UPLOAD_IDLE_MS = 60 * 60_000;
const SWEEP_MS = 5 * 60_000;

export class CanvasArchiveService {
  readonly #jobs = new Map<string, Job>();
  readonly #uploads = new Map<string, Upload>();
  readonly #uploadsDir: string;
  /** Imports wait here for the one before them. */
  #importQueue: Promise<unknown> = Promise.resolve();
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ArchiveServiceDeps) {
    this.#uploadsDir = join(deps.paths.tmp, "canvas-imports");
    // Only one server opens a library at a time, so anything here is left from the last run.
    rmSync(this.#uploadsDir, { recursive: true, force: true });
    this.#sweep = setInterval(() => this.#sweepStale(), SWEEP_MS);
    this.#sweep.unref?.();
  }

  // Export

  /** The archive for the browser to download, streamed as it's read. */
  download(
    canvasId: string,
    opts: { graphVersion?: number } = {},
  ): ArchivePlan & {
    stream: ReadableStream<Uint8Array>;
  } {
    const plan = planExport(this.deps, canvasId, opts);
    const stream = archiveStream(plan, (error) =>
      this.deps.logger.warn("A canvas download stopped part way", { canvasId, error }),
    );
    return { ...plan, stream };
  }

  /**
   * Saves the archive at `target`, an absolute path ending in .zip, through `<target>.part` so a
   * stop never leaves a broken archive under the real name.
   */
  exportTo(canvasId: string, target: string, opts: { overwrite?: boolean } = {}): CanvasArchiveJob {
    const path = checkExportTarget(target, opts.overwrite ?? false);
    const plan = planExport(this.deps, canvasId);
    const job = this.#start("export", { canvasId, name: plan.name });
    job.state.total = plan.zip.length;
    job.state.files.total = plan.files.length;
    job.done = this.#run(job, async (signal) => {
      const part = `${path}.part`;
      try {
        await writeArchive(plan, part, signal, (bytes, file) => {
          job.state.done += bytes;
          if (file) job.state.files.done++;
          this.#send(job);
        });
        renameSync(part, path);
      } catch (error) {
        rmSync(part, { force: true });
        if (signal.aborted || error instanceof ApiFailure) throw error;
        throw new ApiFailure(500, "internal", `Couldn't write ${path}: ${error}`, {
          userMessage: t("canvas.archive.errors.cantWrite"),
        });
      }
      return { kind: "export", path, bytes: plan.zip.length, assets: plan.assets, missing: plan.missing };
    });
    return { ...job.state };
  }

  // Import

  /**
   * Brings in an archive, its unzipped folder or a .ofcanvas.json: at `path` on this computer, or
   * sent up first as `uploadId`.
   */
  startImport(
    source: { path: string } | { uploadId: string },
    opts: { name?: string } = {},
  ): CanvasArchiveJob {
    let upload: Upload | undefined;
    let at: string;
    if ("uploadId" in source) {
      upload = this.#upload(source.uploadId);
      upload.busy = true;
      at = upload.dir;
    } else {
      if (!isAbsolute(source.path)) {
        throw new ApiFailure(400, "bad_request", "The path must be absolute", { field: "path" });
      }
      at = source.path;
    }
    const job = this.#start("import", { canvasId: null, name: null });
    job.state.state = "waiting";
    const ready = this.#importQueue;
    job.done = this.#run(job, async (signal) => {
      // The import before this one finishes first. A cancel while waiting stops at once.
      await Promise.race([ready, aborted(signal)]);
      signal.throwIfAborted();
      job.state.state = "running";
      this.#send(job, true);
      const archive = upload ? await uploadSource(at) : await openArchiveSource(at);
      return importArchive(
        this.deps,
        archive,
        opts,
        {
          named: (name) => {
            job.state.name = name;
            this.#send(job, true);
          },
          sized: (files, bytes) => {
            job.state.files.total = files;
            job.state.total = bytes;
            this.#send(job, true);
          },
          copied: (bytes) => {
            job.state.done += bytes;
            this.#send(job);
          },
          fileDone: () => {
            job.state.files.done++;
            this.#send(job);
          },
          // The commit itself is quick, and once it starts there's nothing left to cancel.
          committing: () => {
            job.committing = true;
          },
        },
        signal,
      );
    }).finally(() => {
      if (upload) this.#dropUpload(source as { uploadId: string });
    });
    // The next import waits for this one and for the one before it: a cancel while waiting ends
    // this job early, but not the import still running ahead of it.
    this.#importQueue = Promise.allSettled([ready, job.done]);
    return { ...job.state };
  }

  // Uploads

  createUpload(): { uploadId: string } {
    const uploadId = newId();
    const dir = join(this.#uploadsDir, uploadId);
    mkdirSync(dir, { recursive: true });
    this.#uploads.set(uploadId, { dir, touchedAt: Date.now(), busy: false });
    return { uploadId };
  }

  /**
   * One piece of a file, at `offset`: 0 starts the file over, anything else must be where the file
   * ends now. Answers with the file's size so far.
   */
  async writeUpload(
    uploadId: string,
    path: string,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<{ path: string; size: number }> {
    const upload = this.#upload(uploadId);
    if (upload.busy) throw new ApiFailure(409, "conflict", "That upload is being imported");
    const file = join(upload.dir, ...path.split("/"));
    if (!resolve(file).startsWith(resolve(upload.dir) + sep)) {
      throw new ApiFailure(400, "bad_request", "Not a path inside the upload", { field: "path" });
    }
    mkdirSync(dirname(file), { recursive: true });
    const size = existsSync(file) ? statSync(file).size : 0;
    if (offset !== 0 && offset !== size) {
      throw new ApiFailure(409, "conflict", `The file is ${size} bytes so far`, { field: "offset" });
    }
    const handle = await open(file, offset === 0 ? "w" : "a", 0o600);
    let written = offset;
    try {
      if (body) {
        for await (const chunk of body) {
          await handle.write(chunk);
          written += chunk.byteLength;
          upload.touchedAt = Date.now();
        }
      }
    } finally {
      await handle.close();
    }
    return { path, size: written };
  }

  /**
   * Once canvas.json and manifest.json are up: the files the library doesn't have yet, named as
   * they were sent, so a folder can leave out the images already here.
   */
  async needed(uploadId: string): Promise<string[]> {
    const upload = this.#upload(uploadId);
    const archive = await uploadSource(upload.dir);
    const text = await archive.text(MANIFEST_FILE, MANIFEST_MAX);
    const doc = await archive.text(CANVAS_FILE, CANVAS_JSON_MAX);
    if (!text || !doc) return [];
    let shown: string[];
    let assets: CanvasArchiveAsset[];
    try {
      shown = documentAssetRefs(readDocument(JSON.parse(doc))).shown;
      const listed: unknown = JSON.parse(text).assets;
      assets = (Array.isArray(listed) ? listed : []).flatMap((item) => {
        const one = canvasArchiveAssetSchema.safeParse(item);
        return one.success ? [one.data] : [];
      });
    } catch {
      // The import itself says what's wrong with them.
      return [];
    }
    const { db } = this.deps;
    /** This library lacks it, so importArchive will want its file. */
    const lacks = (asset: CanvasArchiveAsset) => {
      if (getAsset(db, asset.id)?.sha256 === asset.sha256) return false;
      const same = findLiveAssetBySha256(db, asset.sha256);
      return !(same && same.kind !== "mask");
    };
    const onCanvas = new Set(shown);
    const coming = assets.filter((a) => onCanvas.has(a.id) && lacks(a));
    const masks = new Set(archivedMasks(shown, coming));
    const sent = new Set([...coming, ...assets.filter((a) => masks.has(a.id) && lacks(a))]);
    const files: string[] = [];
    for (const asset of assets) {
      if (!sent.has(asset)) continue;
      files.push(`${archive.prefix}${asset.file}`);
      if (asset.poster) files.push(`${archive.prefix}${asset.poster}`);
    }
    return files;
  }

  /** Clears an upload away. Fine to call for one that's already gone. */
  dropUpload(uploadId: string): void {
    const upload = this.#uploads.get(uploadId);
    if (upload?.busy) throw new ApiFailure(409, "conflict", "That upload is being imported");
    this.#dropUpload({ uploadId });
  }

  // Jobs

  job(jobId: string): CanvasArchiveJob | null {
    const job = this.#jobs.get(jobId);
    return job ? { ...job.state } : null;
  }

  /** Stops a job. One already finished, or an import already writing to the library, carries on. */
  cancel(jobId: string): CanvasArchiveJob | null {
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    if (!isFinished(job.state) && !job.committing) job.controller.abort(new CanceledError());
    return { ...job.state };
  }

  /** Waits until the job finishes or `ms` pass, with each change on the way. */
  async wait(
    jobId: string,
    ms: number,
    onChange?: (state: CanvasArchiveJob) => void,
  ): Promise<CanvasArchiveJob | null> {
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    if (isFinished(job.state) || ms <= 0) return { ...job.state };
    const stop = this.deps.events.subscribe((event, data) => {
      if (event === "canvas_archive.updated" && (data as CanvasArchiveJob).jobId === jobId) {
        onChange?.(data as CanvasArchiveJob);
      }
    });
    try {
      await Promise.race([job.done, Bun.sleep(ms)]);
    } finally {
      stop();
    }
    return { ...job.state };
  }

  /** Stops every job, for the server's stop. Their staged files are cleaned up first. */
  async stop(): Promise<void> {
    clearInterval(this.#sweep);
    const running = [...this.#jobs.values()].filter((job) => !isFinished(job.state));
    for (const job of running) job.controller.abort(new CanceledError());
    await Promise.race([Promise.allSettled(running.map((job) => job.done)), Bun.sleep(3_000)]);
  }

  #start(kind: CanvasArchiveJobKind, fields: { canvasId: string | null; name: string | null }): Job {
    const jobId = newId();
    const job: Job = {
      state: {
        jobId,
        kind,
        state: "running",
        canvasId: fields.canvasId,
        name: fields.name,
        done: 0,
        total: 0,
        files: { done: 0, total: 0 },
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      },
      controller: new AbortController(),
      committing: false,
      done: Promise.resolve(),
      lastSent: 0,
      pending: null,
    };
    this.#jobs.set(jobId, job);
    return job;
  }

  /** Runs the job's work, then records how it ended and says so on the event stream. */
  async #run(job: Job, work: (signal: AbortSignal) => Promise<CanvasArchiveJob["result"]>): Promise<void> {
    const { signal } = job.controller;
    this.#send(job, true);
    // Off the caller's turn, so the route answers before any of the work is done.
    await Promise.resolve();
    try {
      const result = await work(signal);
      job.state.result = result;
      job.state.state = "done";
      if (result?.kind === "import") {
        job.state.canvasId = result.canvasId;
        job.state.name = result.name;
      }
    } catch (error) {
      if (signal.aborted) {
        job.state.state = "canceled";
      } else {
        job.state.state = "failed";
        job.state.error = errorOf(error);
        if (!(error instanceof ApiFailure)) {
          this.deps.logger.error(`A canvas ${job.state.kind} failed`, { jobId: job.state.jobId, error });
        }
      }
    }
    job.state.finishedAt = new Date().toISOString();
    this.#send(job, true);
    const forget = setTimeout(() => this.#jobs.delete(job.state.jobId), KEEP_FINISHED_MS);
    forget.unref?.();
  }

  #send(job: Job, now = false): void {
    const due = job.lastSent + SEND_EVERY_MS - Date.now();
    if (!now && due > 0) {
      job.pending ??= setTimeout(() => {
        job.pending = null;
        this.#send(job, true);
      }, due);
      return;
    }
    if (job.pending) clearTimeout(job.pending);
    job.pending = null;
    job.lastSent = Date.now();
    this.deps.events.publish("canvas_archive.updated", { ...job.state, files: { ...job.state.files } });
  }

  #upload(uploadId: string): Upload {
    const upload = this.#uploads.get(uploadId);
    if (!upload || !existsSync(upload.dir)) {
      throw new ApiFailure(404, "not_found", "No such upload", {
        field: "uploadId",
        userMessage: t("canvas.archive.errors.uploadGone"),
      });
    }
    upload.touchedAt = Date.now();
    return upload;
  }

  #dropUpload({ uploadId }: { uploadId: string }): void {
    const upload = this.#uploads.get(uploadId);
    this.#uploads.delete(uploadId);
    if (upload) rmSync(upload.dir, { recursive: true, force: true });
  }

  #sweepStale(): void {
    const cutoff = Date.now() - UPLOAD_IDLE_MS;
    for (const [uploadId, upload] of this.#uploads) {
      if (!upload.busy && upload.touchedAt < cutoff) this.#dropUpload({ uploadId });
    }
  }
}

/** Rejects when the signal aborts; never settles otherwise. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

class CanceledError extends Error {
  override readonly name = "CanceledError";
  constructor() {
    super("Canceled");
  }
}

const isFinished = (state: CanvasArchiveJob) =>
  state.state === "done" || state.state === "failed" || state.state === "canceled";

function errorOf(error: unknown): NonNullable<CanvasArchiveJob["error"]> {
  if (error instanceof ApiFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.userMessage && { userMessage: error.userMessage }),
    };
  }
  if (isProviderError(error)) {
    return { code: error.code as ApiErrorCode, message: error.message, userMessage: error.userMessage };
  }
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

/** Where an export may go: an absolute .zip path in a folder that's there, not already taken. */
function checkExportTarget(target: string, overwrite: boolean): string {
  if (!isAbsolute(target))
    throw new ApiFailure(400, "bad_request", "The path must be absolute", { field: "path" });
  const path = resolve(target);
  if (!path.toLowerCase().endsWith(".zip")) {
    throw new ApiFailure(400, "bad_request", "The path must end in .zip", {
      field: "path",
      userMessage: t("canvas.archive.errors.notZip"),
    });
  }
  let folder: ReturnType<typeof statSync> | null = null;
  try {
    folder = statSync(dirname(path));
  } catch {
    // Said below.
  }
  if (!folder?.isDirectory()) {
    throw new ApiFailure(400, "bad_request", `No folder ${dirname(path)}`, {
      field: "path",
      userMessage: t("canvas.archive.errors.noFolder"),
    });
  }
  if (existsSync(path) && (!overwrite || statSync(path).isDirectory())) {
    const name = path.slice(dirname(path).length + 1);
    throw new ApiFailure(409, "conflict", `${path} already exists`, {
      field: "path",
      userMessage: t("canvas.archive.errors.exists", { name }),
    });
  }
  return path;
}

/** Streams the archive into `file`, telling `progress` each chunk's size and when a file ends. */
async function writeArchive(
  plan: ArchivePlan,
  file: string,
  signal: AbortSignal,
  progress: (bytes: number, fileEnded: boolean) => void,
): Promise<void> {
  const handle = await open(file, "w", 0o644);
  try {
    // Each entry is a local header then its data; the data's last chunk ends the file.
    const ends = new Set<number>();
    let at = 0;
    for (const entry of plan.zip.entries) {
      at = entry.offset + 30 + entry.nameBytes.length + entry.size;
      ends.add(at);
    }
    let written = 0;
    const reader = archiveStream(plan).getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(value);
        written += value.byteLength;
        progress(value.byteLength, ends.has(written));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    await handle.close();
  }
}

/**
 * What the browser sent: a single zip or .json at the top of the upload is read as that file; a
 * folder's files are read as the folder.
 */
async function uploadSource(dir: string): Promise<ArchiveSource> {
  const top = readdirSync(dir, { withFileTypes: true });
  const only = top.length === 1 ? top[0] : undefined;
  if (only?.isFile() && only.name !== CANVAS_FILE) return openArchiveSource(join(dir, only.name));
  return openArchiveSource(dir);
}

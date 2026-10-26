import { type CanvasArchiveJob, t } from "@openfield/core";
import { queryClient, queryKeys } from "../api/client";
import {
  ARCHIVE_MISSING_HEADER,
  cancelArchiveJob,
  createImportUpload,
  dropImportUpload,
  exportCanvasTo,
  fetchCanvasArchive,
  followArchiveJob,
  neededImportFiles,
  sendImportFile,
  startCanvasImport,
  ZIP_BYTES_HEADER,
} from "../api/hooks/canvas-archives";
import { libraryKeys } from "../api/hooks/library";
import { errorMessage } from "../api/raw";
import { isDesktop, saveDialog } from "../lib/desktop";
import { notify, notifyError, notifyProgress, type ProgressToast } from "../lib/notify";
import {
  archiveFileName,
  baseName,
  CanvasFileError,
  canvasNameOf,
  folderOf,
  type ImportSelection,
  importFraction,
  jobFraction,
} from "./index/file";

// Export and import of a whole canvas (§7.8), from the canvas card, the editor's name menu and the
// index page. Both show a toast with progress and Cancel while they run. The desktop app picks
// paths with the system's dialogs and the server reads or writes them; a browser streams the
// download and sends an import up in pieces first.

/** What the system dialogs filter on. */
export const archiveFilter = () => ({ name: t("canvas.archive.fileType"), extensions: ["zip"] });

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const failureCopy = (error: unknown) =>
  error instanceof CanvasFileError ? error.message : errorMessage(error);

const missingCopy = (
  count: number,
  key: "canvas.archive.export.missing" | "canvas.archive.import.missing",
) => (count > 0 ? t(key, { count }) : undefined);

export interface ExportRequest {
  canvasId: string;
  name: string;
  /**
   * Runs once the person has picked where the file goes, before the server's copy is read: the
   * editor saves first. Resolves with the version that was saved; throws to stop, with its words.
   */
  prepare?: () => Promise<number | undefined>;
}

/** Exports one canvas with its images. Never throws: every outcome is a toast. */
export async function exportCanvas(request: ExportRequest): Promise<void> {
  const fileName = archiveFileName(request.name);
  try {
    if (isDesktop()) await exportOnDesktop(request, fileName);
    else await exportInBrowser(request, fileName);
  } catch (error) {
    if (!isAbort(error)) notifyError(failureCopy(error));
  }
}

async function exportOnDesktop(request: ExportRequest, fileName: string): Promise<void> {
  // The dialog asks before replacing a file, so the server may.
  const path = await saveDialog({ defaultPath: fileName, filters: [archiveFilter()] });
  if (!path) return;
  await request.prepare?.();
  let job: CanvasArchiveJob | undefined;
  let canceled = false;
  const progress = notifyProgress(
    { message: t("canvas.archive.export.progress", { name: request.name }) },
    () => {
      canceled = true;
      if (job) void cancelArchiveJob(job.jobId).catch(() => {});
    },
  );
  try {
    job = await exportCanvasTo(request.canvasId, path);
    // Cancel was pressed while the job was being made.
    if (canceled) void cancelArchiveJob(job.jobId).catch(() => {});
    const final = await followArchiveJob(job, {
      onUpdate: (next) => progress.update({ progress: jobFraction(next) }),
    });
    progress.close();
    if (final.state === "failed") notifyError(final.error?.userMessage ?? t("canvas.archive.export.failed"));
    if (final.state !== "done" || final.result?.kind !== "export") return;
    const saved = final.result.path ?? path;
    // There's no way to show the file from the page, so the toast says where it went.
    notify(t("canvas.archive.export.done", { name: baseName(saved) }), {
      tone: "success",
      description: [
        t("canvas.archive.export.savedIn", { folder: folderOf(saved) }),
        missingCopy(final.result.missing, "canvas.archive.export.missing"),
      ]
        .filter(Boolean)
        .join(" "),
    });
  } catch (error) {
    progress.close();
    if (!canceled) throw error;
  }
}

/** Chromium's File System Access save picker. Safari and Firefox don't have it. */
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

async function exportInBrowser(request: ExportRequest, fileName: string): Promise<void> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let handle: FileSystemFileHandle | null = null;
  if (typeof picker === "function") {
    try {
      // First, while the click still counts as one: the picker refuses to open later.
      handle = await picker({
        suggestedName: fileName,
        types: [{ description: t("canvas.archive.fileType"), accept: { "application/zip": [".zip"] } }],
      });
    } catch (error) {
      if (isAbort(error)) return;
      // Refused for some other reason: download it instead.
    }
  }

  const controller = new AbortController();
  let progress: ProgressToast | undefined;
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const graphVersion = await request.prepare?.();
    progress = notifyProgress({ message: t("canvas.archive.export.progress", { name: request.name }) }, () =>
      controller.abort(),
    );
    const res = await fetchCanvasArchive(request.canvasId, {
      ...(graphVersion !== undefined && { graphVersion }),
      signal: controller.signal,
    });
    const total = Number(res.headers.get(ZIP_BYTES_HEADER)) || 0;
    const chunks: Uint8Array[] = [];
    if (handle) writable = await handle.createWritable();
    const sink = writable;
    await readStream(res, {
      write: sink ? (chunk) => sink.write(chunk as BufferSource) : (chunk) => void chunks.push(chunk),
      onBytes: (done) => progress?.update({ progress: total > 0 ? Math.min(1, done / total) : undefined }),
    });
    if (sink) await sink.close();
    else saveBlob(new Blob(chunks as BlobPart[], { type: "application/zip" }), fileName);
    progress.close();
    notify(t("canvas.archive.export.done", { name: handle?.name ?? fileName }), {
      tone: "success",
      description: missingCopy(
        Number(res.headers.get(ARCHIVE_MISSING_HEADER)) || 0,
        "canvas.archive.export.missing",
      ),
    });
  } catch (error) {
    progress?.close();
    // Leave nothing half written where the person asked for the file.
    await writable?.abort().catch(() => {});
    await (handle as { remove?: () => Promise<void> } | null)?.remove?.().catch(() => {});
    throw error;
  }
}

/** Reads a response to the end, handing each chunk on and counting the bytes. */
export async function readStream(
  res: Response,
  sink: { write: (chunk: Uint8Array) => unknown; onBytes?: (done: number) => void },
): Promise<number> {
  if (!res.body) return 0;
  const reader = res.body.getReader();
  let done = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) return done;
    await sink.write(next.value);
    done += next.value.byteLength;
    sink.onBytes?.(done);
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the blob after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A path from the desktop app's open dialog, or files the browser sends up first. */
export type ImportSource = { kind: "path"; path: string } | { kind: "upload"; selection: ImportSelection };

/**
 * Imports a canvas with its images, then opens it with `open`. Never throws: every outcome is a
 * toast. Cancel stops whichever part is running; the server keeps nothing of a canceled import.
 */
export async function importCanvas(source: ImportSource, open: (canvasId: string) => void): Promise<void> {
  const uploaded = source.kind === "upload";
  const guess = source.kind === "path" ? canvasNameOf(baseName(source.path)) : source.selection.name;
  const message = (name: string | null) => t("canvas.archive.import.progress", { name: name ?? guess });

  const controller = new AbortController();
  let job: CanvasArchiveJob | undefined;
  let uploadId: string | undefined;
  const progress = notifyProgress({ message: message(null), ...(uploaded && { progress: 0 }) }, () => {
    controller.abort();
    if (job) void cancelArchiveJob(job.jobId).catch(() => {});
  });

  try {
    if (source.kind === "path") job = await startCanvasImport({ path: source.path });
    else {
      uploadId = (await createImportUpload()).uploadId;
      await sendSelection(uploadId, source.selection, {
        signal: controller.signal,
        onProgress: (sent, toSend) => progress.update({ progress: importFraction({ sent, toSend }) }),
      });
      job = await startCanvasImport({ uploadId });
      // The job owns the files now and clears them when it ends.
      uploadId = undefined;
    }
    // Cancel was pressed while the job was being made.
    if (controller.signal.aborted) void cancelArchiveJob(job.jobId).catch(() => {});

    const final = await followArchiveJob(job, {
      onUpdate: (next) =>
        progress.update({
          message: message(next.name),
          description: next.state === "waiting" ? t("canvas.archive.import.waiting") : undefined,
          progress: importFraction({ job: next, uploaded }),
        }),
    });
    progress.close();
    if (final.state === "failed") notifyError(final.error?.userMessage ?? t("canvas.archive.import.failed"));
    if (final.state !== "done" || final.result?.kind !== "import") return;

    const { canvasId, name, missing } = final.result;
    void queryClient.invalidateQueries({ queryKey: queryKeys.canvases, exact: true });
    // New images and the canvas's folder: the stream says which changed, not what's in each list.
    void queryClient.invalidateQueries({ queryKey: queryKeys.allAssets });
    void queryClient.invalidateQueries({ queryKey: libraryKeys.summaryRoot });
    open(canvasId);
    notify(t("canvas.archive.import.done", { name }), {
      tone: "success",
      description: missingCopy(missing, "canvas.archive.import.missing"),
    });
  } catch (error) {
    progress.close();
    if (uploadId) void dropImportUpload(uploadId).catch(() => {});
    if (!controller.signal.aborted && !isAbort(error)) notifyError(failureCopy(error));
  }
}

/**
 * Sends the chosen files into the upload. A folder with a manifest sends canvas.json and
 * manifest.json first, then asks which images the library lacks and sends only those.
 */
async function sendSelection(
  uploadId: string,
  selection: ImportSelection,
  opts: { signal: AbortSignal; onProgress: (sent: number, toSend: number) => void },
): Promise<void> {
  const lead = selection.files.slice(0, selection.lead);
  let rest = selection.files.slice(selection.lead);
  const size = (files: readonly { file: Blob }[]) => files.reduce((sum, { file }) => sum + file.size, 0);
  let toSend = size(selection.files);
  let sent = 0;
  const send = async (files: readonly { path: string; file: Blob }[]) => {
    for (const { path, file } of files) {
      await sendImportFile(uploadId, path, file, {
        signal: opts.signal,
        onBytes: (bytes) => {
          sent += bytes;
          opts.onProgress(sent, toSend);
        },
      });
    }
  };

  await send(lead);
  if (lead.some(({ path }) => baseName(path) === "manifest.json")) {
    try {
      const needed = new Set(await neededImportFiles(uploadId));
      rest = rest.filter(({ path }) => needed.has(path));
      toSend = sent + size(rest);
    } catch (error) {
      if (opts.signal.aborted) throw error;
      // Sending everything works too; it only takes longer.
    }
  }
  await send(rest);
}

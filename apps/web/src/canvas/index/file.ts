import { CANVAS_ARCHIVE_EXTENSION, type CanvasArchiveJob, t } from "@openfield/core";

// Canvas files (§7.8): a canvas exports as {name}.ofcanvas.zip, with every image it shows. Import
// takes that zip, the folder it unzips to, or an older {name}.ofcanvas.json (the document alone).
// The server reads all three; the page only picks what to send and says how far along it is.

/** Import failed before anything was sent; the message is ready to show. */
export class CanvasFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasFileError";
  }
}

/** "Lighthouse series.ofcanvas.zip", minus characters file systems refuse. */
export function archiveFileName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe || t("canvas.names.untitled")}${CANVAS_ARCHIVE_EXTENSION}`;
}

/** "Lighthouse series" for "Lighthouse series.ofcanvas.zip", its folder, or a .ofcanvas.json. */
export const canvasNameOf = (fileName: string) =>
  fileName.replace(/(\.ofcanvas)?(\.zip|\.json)?$/i, "").trim() || fileName;

/** The last part of a path, with either slash. */
export const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

/** The folder a file is in, for "Saved in …". */
export function folderOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at > 0 ? path.slice(0, at) : path;
}

/** Finder and Windows leave these in folders; they're never part of a canvas. */
const isClutter = (path: string) =>
  path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));

export interface ImportFile {
  /** Where it goes in the upload: the file's name, or its place inside the chosen folder. */
  path: string;
  file: Blob;
}

/** What the person chose, ready to send. */
export interface ImportSelection {
  /** The canvas's name until the server reads the real one. */
  name: string;
  files: ImportFile[];
  /**
   * How many files lead: a folder's canvas.json and manifest.json. With a manifest, the rest are
   * sent only when the library doesn't have them yet.
   */
  lead: number;
}

/** A file the browser picked; webkitRelativePath is set when it came from a folder. */
type PickedFile = Blob & { name: string; webkitRelativePath?: string };

/**
 * One .zip or .json file, or every file in a folder (an input with webkitdirectory). A folder
 * sends only what's under its canvas.json, which may sit a level or two down.
 */
export function importSelection(picked: readonly PickedFile[]): ImportSelection {
  const notCanvas = () => new CanvasFileError(t("canvas.archive.errors.notArchive"));
  if (!picked.some((file) => file.webkitRelativePath)) {
    const [file] = picked;
    if (!file || picked.length > 1 || !/\.(zip|json)$/i.test(file.name)) throw notCanvas();
    // A name, never a path: the server refuses slashes.
    const path = file.name.replace(/[\\/]/g, "_");
    return { name: canvasNameOf(file.name), files: [{ path, file }], lead: 0 };
  }

  const files = picked
    .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    .filter(({ path }) => !isClutter(path));
  // The shallowest canvas.json is the canvas; two side by side can't both be.
  const depth = (path: string) => path.split("/").length;
  const roots = files
    .filter(({ path }) => baseName(path) === "canvas.json")
    .map(({ path }) => path.slice(0, -"canvas.json".length))
    .sort((a, b) => depth(a) - depth(b));
  const root = roots[0];
  if (root === undefined || (roots[1] !== undefined && depth(roots[1]) === depth(root))) throw notCanvas();

  const order = (path: string) =>
    path === `${root}canvas.json` ? 0 : path === `${root}manifest.json` ? 1 : 2;
  const inside = files
    .filter(({ path }) => path.startsWith(root))
    .sort((a, b) => order(a.path) - order(b.path));
  return {
    name: canvasNameOf(baseName(root)),
    files: inside,
    lead: inside.filter(({ path }) => order(path) < 2).length,
  };
}

/** How far along a job is, 0 to 1, or undefined while its size isn't known. */
export const jobFraction = (job: CanvasArchiveJob): number | undefined =>
  job.total > 0 ? Math.min(1, job.done / job.total) : undefined;

/**
 * A browser import's progress line: sending the files is the first half, the library taking them
 * in the second. The desktop app hands over a path, so its import is all second half.
 */
export function importFraction(
  phase: { sent: number; toSend: number } | { job: CanvasArchiveJob; uploaded: boolean },
): number | undefined {
  if ("sent" in phase)
    return phase.toSend > 0 ? (Math.min(phase.sent, phase.toSend) / phase.toSend) * 0.5 : 0;
  const share = phase.uploaded ? 0.5 : 0;
  const fraction = jobFraction(phase.job);
  if (fraction === undefined) return phase.uploaded ? share : undefined;
  return share + fraction * (1 - share);
}

import { describeIssue, hasIssues } from "@openfield/canvas/store/issues";
import { remapDocument } from "@openfield/canvas/store/refs";
import { formatBytes, t } from "@openfield/core";
import { type CanvasDocument, CanvasVersionError, migrateCanvasDocument } from "@openfield/core/canvas";

// Canvas files (§7.8): export writes the document as {name}.ofcanvas.json; import reads one back,
// brings it up to the current version, checks it and gives every node and connection a new id,
// so the same file can be imported twice. The server checks it again on create.

/** Just under the server's cap on a canvas save, and a round number to show. */
export const IMPORT_MAX_BYTES = 8_000_000;

export { describeIssue };

/** Import failed; the message is ready to show. */
export class CanvasFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasFileError";
  }
}

/** A file's text, ready for POST /api/canvases. Throws CanvasFileError with the reason. */
export function parseCanvasFile(text: string): CanvasDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CanvasFileError(t("canvas.index.import.notCanvas"));
  }
  try {
    return remapDocument(migrateCanvasDocument(raw));
  } catch (error) {
    if (error instanceof CanvasVersionError) {
      throw new CanvasFileError(error.version === null ? t("canvas.index.import.notCanvas") : error.message);
    }
    if (hasIssues(error) && error.issues[0]) throw new CanvasFileError(describeIssue(error.issues[0]));
    throw new CanvasFileError(t("canvas.index.import.notCanvas"));
  }
}

export async function readCanvasFile(file: File): Promise<CanvasDocument> {
  if (file.size > IMPORT_MAX_BYTES) {
    throw new CanvasFileError(t("canvas.index.import.tooBig", { size: formatBytes(IMPORT_MAX_BYTES) }));
  }
  return parseCanvasFile(await file.text());
}

/** "Lighthouse series.ofcanvas.json", minus characters file systems refuse. */
export function exportFileName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe || t("canvas.names.untitled")}.ofcanvas.json`;
}

export function downloadCanvasFile(doc: CanvasDocument, name: string) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFileName(name);
  link.click();
  // Some browsers read the blob after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

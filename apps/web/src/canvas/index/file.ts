import { formatBytes, t } from "@openfield/core";
import { type CanvasDocument, CanvasVersionError, migrateCanvasDocument } from "@openfield/core/canvas";
import { newEdgeId, newNodeId } from "../store/graph";

// Canvas files (§7.8): export writes the document as {name}.ofcanvas.json; import reads one back,
// brings it up to the current version, checks it and gives every node and connection a new id,
// so the same file can be imported twice. The server checks it again on create.

/** Just under the server's cap on a canvas save, and a round number to show. */
export const IMPORT_MAX_BYTES = 8_000_000;

/** Import failed; the message is ready to show. */
export class CanvasFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasFileError";
  }
}

interface Issue {
  /** zod's kind of problem. Only "custom" ones (the document's own checks) carry our words. */
  code?: string;
  path: readonly PropertyKey[];
  message: string;
}

const hasIssues = (error: unknown): error is { issues: Issue[] } =>
  typeof error === "object" && error !== null && Array.isArray((error as { issues?: unknown }).issues);

/**
 * "Node 3: …" for the first problem, so the person can find it in the file. zod's own wording
 * ("Too big: expected number to be <=4") never reaches them: without words of ours, it says which
 * node can't be read.
 */
export function describeIssue(issue: Issue): string {
  const [list, index] = issue.path;
  const message = !issue.code || issue.code === "custom" ? issue.message : null;
  if (typeof index === "number") {
    const at = index + 1;
    if (list === "nodes")
      return message
        ? t("canvas.index.import.node", { index: at, message })
        : t("canvas.index.import.nodeUnreadable", { index: at });
    if (list === "edges")
      return message
        ? t("canvas.index.import.connection", { index: at, message })
        : t("canvas.index.import.connectionUnreadable", { index: at });
  }
  return message ?? t("canvas.index.import.notCanvas");
}

/** Fresh node and connection ids throughout; results, params and frames are kept. */
export function remapDocument(doc: CanvasDocument): CanvasDocument {
  const ids = new Map(doc.nodes.map((node) => [node.id, newNodeId()]));
  return {
    ...doc,
    nodes: doc.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId === null ? null : (ids.get(node.parentId) ?? null),
    })),
    edges: doc.edges.map((edge) => ({
      ...edge,
      id: newEdgeId(),
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
    })),
  };
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

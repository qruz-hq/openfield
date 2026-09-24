import { statSync } from "node:fs";
import {
  CANVAS_PREVIEW_MAX_NODES,
  type CanvasDetail,
  type CanvasSummary,
  type CanvasVersion,
  type CanvasVersionDetail,
} from "@openfield/core";
import type { CanvasGraph } from "@openfield/core/canvas";
import type { CanvasListRow, CanvasRow, CanvasVersionListRow } from "@openfield/db";
import { absolutePath, type HomePaths } from "../config/home";

// Canvas rows to wire shapes (§8.3). Preview files stay on the server; the browser gets a URL.

export const canvasPreviewUrl = (id: string, version: number): string =>
  `/files/canvas-preview/${id}?v=${version}`;

/** The card's rendered preview, or null past the node limit, when the fallback takes over (M4-15). */
function previewUrlOf(row: CanvasListRow, paths: HomePaths): string | null {
  if (!row.previewPath || row.nodeCount > CANVAS_PREVIEW_MAX_NODES) return null;
  // The file's age busts the browser cache when a new preview replaces it.
  const stat = statSync(absolutePath(paths, row.previewPath), { throwIfNoEntry: false });
  return stat ? canvasPreviewUrl(row.id, Math.trunc(stat.mtimeMs)) : null;
}

/** When the stored card picture was taken, or null when there's none in use. */
export function previewTakenAt(row: CanvasListRow, paths: HomePaths): string | null {
  if (!row.previewPath || row.nodeCount > CANVAS_PREVIEW_MAX_NODES) return null;
  const stat = statSync(absolutePath(paths, row.previewPath), { throwIfNoEntry: false });
  return stat ? new Date(stat.mtimeMs).toISOString() : null;
}

/** `liveCovers`: cover images still in the library, so a trashed one never shows on a card. */
export function toCanvasSummary(
  row: CanvasListRow,
  paths: HomePaths,
  liveCovers: Set<string>,
): CanvasSummary {
  return {
    id: row.id,
    name: row.name,
    previewUrl: previewUrlOf(row, paths),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nodeCount: row.nodeCount,
    coverAssetId: row.coverAssetId && liveCovers.has(row.coverAssetId) ? row.coverAssetId : null,
    graphVersion: row.graphVersion,
  };
}

/** `graph` is the migrated document; the row's copy may be an older shape. */
export function toCanvasDetail(row: CanvasRow, graph: CanvasGraph): CanvasDetail {
  return {
    id: row.id,
    name: row.name,
    graph,
    graphVersion: row.graphVersion,
    updatedAt: row.updatedAt,
  };
}

export function toCanvasVersion(row: CanvasVersionListRow): CanvasVersion {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    createdAt: row.createdAt,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    coverAssetId: row.coverAssetId,
  };
}

export function toCanvasVersionDetail(row: CanvasVersionListRow, graph: CanvasGraph): CanvasVersionDetail {
  return { ...toCanvasVersion(row), graph };
}

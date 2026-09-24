import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CANVAS_PREVIEW_THEMES, type CanvasPreviewTheme, newId } from "@openfield/core";
import type { CanvasDocument } from "@openfield/core/canvas";
import { absolutePath, type HomePaths } from "../config/home";

// Files a canvas keeps beside the database: the card preview (M4-15), in both themes, and, when
// the "Also save canvases as files" setting is on, a copy of each saved document (§7.8).
// Always written to tmp/ first and renamed into place, so a reader never sees half a file.

/**
 * Relative to the library root. The light one is what canvases.preview_path stores; the dark one
 * sits beside it with the same name plus ".dark".
 */
export const previewPath = (canvasId: string, theme: CanvasPreviewTheme = "light"): string =>
  theme === "dark" ? `canvases/previews/${canvasId}.dark.png` : `canvases/previews/${canvasId}.png`;

/** The dark twin of a stored (light) preview path. */
const darkOf = (relative: string) => relative.replace(/\.png$/, ".dark.png");

/** The stored preview in the theme asked for, falling back to the other when only one exists. */
export function previewFile(paths: HomePaths, relative: string, theme: CanvasPreviewTheme): string | null {
  const wanted = absolutePath(paths, theme === "dark" ? darkOf(relative) : relative);
  if (existsSync(wanted)) return wanted;
  const other = absolutePath(paths, theme === "dark" ? relative : darkOf(relative));
  return existsSync(other) ? other : null;
}
const documentPath = (canvasId: string): string => `canvases/${canvasId}.json`;

function placeAtomic(paths: HomePaths, relative: string, write: (tmp: string) => void): void {
  const target = absolutePath(paths, relative);
  const tmp = join(paths.tmp, `${newId()}.part`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    write(tmp);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Writes one theme's preview and returns the path canvases.preview_path keeps (the light one's). */
export function writePreview(
  paths: HomePaths,
  canvasId: string,
  png: Uint8Array,
  theme: CanvasPreviewTheme = "light",
): string {
  placeAtomic(paths, previewPath(canvasId, theme), (tmp) => writeFileSync(tmp, png, { mode: 0o600 }));
  return previewPath(canvasId);
}

/** A duplicate starts with the original's cards. Null when there's nothing to copy. */
export function copyPreview(paths: HomePaths, from: string | null, toCanvasId: string): string | null {
  if (!from) return null;
  let copied = false;
  for (const theme of CANVAS_PREVIEW_THEMES) {
    const source = absolutePath(paths, theme === "dark" ? darkOf(from) : from);
    if (!existsSync(source)) continue;
    try {
      placeAtomic(paths, previewPath(toCanvasId, theme), (tmp) => copyFileSync(source, tmp));
      copied = true;
    } catch {
      // A card that doesn't copy falls back to the cover image.
    }
  }
  return copied ? previewPath(toCanvasId) : null;
}

export function removePreview(paths: HomePaths, relative: string | null): void {
  if (!relative) return;
  rmSync(absolutePath(paths, relative), { force: true });
  rmSync(absolutePath(paths, darkOf(relative)), { force: true });
}

export function writeDocumentFile(paths: HomePaths, doc: CanvasDocument): void {
  placeAtomic(paths, documentPath(doc.id), (tmp) =>
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 }),
  );
}

export function removeDocumentFile(paths: HomePaths, canvasId: string): void {
  rmSync(absolutePath(paths, documentPath(canvasId)), { force: true });
}

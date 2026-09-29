import { statSync } from "node:fs";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import type { AssetRow } from "@openfield/db";
import { absolutePath } from "../config/home";
import { thumbSourceOf } from "../files/thumbs";
import type { ToolContext } from "./kit";

// How an agent sees an image: a small inline preview it can look at, and where the full one is:
// the file on disk and the page in the app.

/** Long edge of an inline preview. Enough to judge an image, small enough to keep context light. */
export const PREVIEW_EDGE = 512;
/** Without sharp an original is sent as is, but only a small one. */
const MAX_ORIGINAL_BYTES = 1_500_000;
const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface ImageInfo {
  assetId: string;
  width: number;
  height: number;
  /** The full image on disk. */
  file: string;
  /** The image open in Openfield's detail view. */
  url: string;
}

/** Opens the detail view (apps/web/src/detail/use-detail.ts, DETAIL_PARAM). */
export function appUrl(ctx: ToolContext, assetId: string): string {
  return `http://127.0.0.1:${ctx.svc.port}/image?asset=${assetId}`;
}

export function imageInfo(ctx: ToolContext, row: AssetRow): ImageInfo {
  return {
    assetId: row.id,
    width: row.width,
    height: row.height,
    file: absolutePath(ctx.svc.paths, row.path),
    url: appUrl(ctx, row.id),
  };
}

/** An inline preview, or null when neither sharp nor a small original can give one. */
export async function preview(
  ctx: ToolContext,
  row: AssetRow,
  edge = PREVIEW_EDGE,
): Promise<ImageContent | null> {
  // A video shows its poster frame, when it has one.
  const source = thumbSourceOf(row);
  if (!source) return null;
  const jpeg = await ctx.svc.thumbs.jpeg(source, edge);
  if (jpeg) return { type: "image", data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };
  if (!INLINE_MIMES.has(row.mime)) return null;
  const file = absolutePath(ctx.svc.paths, row.path);
  try {
    if (statSync(file).size > MAX_ORIGINAL_BYTES) return null;
    const bytes = await Bun.file(file).bytes();
    return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: row.mime };
  } catch {
    return null;
  }
}

/** Info for each image, and a preview for up to `max` of them. */
export async function describeImages(
  ctx: ToolContext,
  rows: readonly AssetRow[],
  opts: { previews: boolean; max?: number },
): Promise<{ images: ImageInfo[]; blocks: ImageContent[] }> {
  const images = rows.map((row) => imageInfo(ctx, row));
  const blocks: ImageContent[] = [];
  if (opts.previews) {
    for (const row of rows.slice(0, opts.max ?? rows.length)) {
      const block = await preview(ctx, row);
      if (block) blocks.push(block);
    }
  }
  return { images, blocks };
}

import { existsSync, statSync } from "node:fs";
import { zValidator } from "@hono/zod-validator";
import { canvasPreviewQuerySchema, idParamSchema, queryFlagSchema, thumbQuerySchema } from "@openfield/core";
import { getAsset } from "@openfield/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { previewFile } from "../canvas/files";
import { absolutePath } from "../config/home";
import type { Env } from "../context";
import { attachment, downloadName } from "../files/names";
import { stillMime, Thumbs, thumbSourceOf } from "../files/thumbs";
import { notFound, onInvalid } from "../http/errors";

// Binary under /files (§8.5.3). Plain HTTP; the browser fetches with the session header. A video
// is served whole or by byte ranges from /files/asset, like a full-size image; its thumbnails come
// from its poster frame, so /files/thumb answers with an image for images and videos alike.

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * An image in the Trash is served only when asked with ?trash=1 (M3a-04), which the Trash's own
 * URLs carry, so nothing else keeps showing a deleted image by accident. ?download=1 sends the
 * original as an attachment with a readable name (§4.4).
 */
const assetQuerySchema = z.object({
  trash: queryFlagSchema.optional(),
  download: queryFlagSchema.optional(),
});
const thumbFileQuerySchema = thumbQuerySchema.extend({ trash: queryFlagSchema.optional() });

export const filesRoutes = new Hono<Env>()
  .get(
    "/asset/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", assetQuerySchema, onInvalid),
    async (c) => {
      const { db, paths } = c.var.svc;
      const { trash, download } = c.req.valid("query");
      const asset = getAsset(db, c.req.valid("param").id, { includeDeleted: trash });
      const file = asset && absolutePath(paths, asset.path);
      if (!asset || !file || !existsSync(file)) return notFound(c, "That image");
      return sendFile(c, file, {
        type: asset.mime,
        etag: `"${asset.sha256}"`,
        cache: IMMUTABLE,
        ...(download && { disposition: attachment(downloadName(asset)) }),
      });
    },
  )
  .get(
    "/thumb/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", thumbFileQuerySchema, onInvalid),
    async (c) => {
      const { db, thumbs } = c.var.svc;
      const query = c.req.valid("query");
      const asset = getAsset(db, c.req.valid("param").id, { includeDeleted: query.trash });
      const source = asset && thumbSourceOf(asset);
      if (!asset || !source) return notFound(c, "That image");
      const thumb = await thumbs.get(source, Thumbs.sizeFor(query));
      if (!existsSync(thumb.file)) return notFound(c, "That image");
      if (thumb.kind === "original") {
        // Not immutable, so real thumbnails take over once sharp loads (§8.5.2).
        const type = asset.posterPath ? stillMime(asset.posterPath) : asset.mime;
        return sendFile(c, thumb.file, { type, cache: "no-cache" });
      }
      return sendFile(c, thumb.file, { type: "image/webp", etag: thumb.etag, cache: IMMUTABLE });
    },
  )
  // A video's poster frame at full size, for the player before it plays. Written once, with the
  // video, so it's as immutable as the video itself.
  .get(
    "/poster/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", assetQuerySchema.pick({ trash: true }), onInvalid),
    async (c) => {
      const { db, paths } = c.var.svc;
      const asset = getAsset(db, c.req.valid("param").id, { includeDeleted: c.req.valid("query").trash });
      const file = asset?.posterPath && absolutePath(paths, asset.posterPath);
      if (!asset || !file || !existsSync(file)) return notFound(c, "That poster");
      return sendFile(c, file, { type: stillMime(file), etag: `"${asset.sha256}-poster"`, cache: IMMUTABLE });
    },
  )
  // An index card's preview (M4-15), in the theme asked for: an internal file, never an asset.
  // Replaced in place, so revalidated.
  .get(
    "/canvas-preview/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", canvasPreviewQuerySchema, onInvalid),
    async (c) => {
      const { canvases, paths } = c.var.svc;
      const relative = canvases.previewPath(c.req.valid("param").id);
      const file = relative && previewFile(paths, relative, c.req.valid("query").theme ?? "light");
      if (!file) return notFound(c, "That preview");
      const stat = statSync(file);
      return sendFile(c, file, {
        type: "image/png",
        etag: `"${Math.trunc(stat.mtimeMs)}-${stat.size}"`,
        cache: "no-cache",
      });
    },
  );

/** Files at most this big are read whole before replying: thumbnails and card previews. */
const BUFFER_MAX_BYTES = 2 * 1024 * 1024;
/** A file written this recently is read whole too, whatever its size. */
const FRESH_MS = 30_000;

/**
 * Sends a file, with ETag revalidation and single byte ranges for the full-size viewer. Bun 1.3
 * sometimes never finishes a reply streamed straight from a file written a moment ago (several
 * fresh thumbnails at once, as when a canvas node finishes), so small and fresh files are read
 * before the reply goes out. Big originals still stream, so a 40 MB image isn't held in memory
 * once per request.
 */
async function sendFile(
  c: Context,
  file: string,
  opts: { type: string; etag?: string; cache: string; disposition?: string },
): Promise<Response> {
  const headers = new Headers({
    "content-type": opts.type,
    "cache-control": opts.cache,
    "accept-ranges": "bytes",
  });
  if (opts.disposition) headers.set("content-disposition", opts.disposition);
  if (opts.etag) {
    headers.set("etag", opts.etag);
    if (c.req.header("if-none-match") === opts.etag) return new Response(null, { status: 304, headers });
  }
  const blob = Bun.file(file);
  const size = blob.size;
  const buffered = size <= BUFFER_MAX_BYTES || Date.now() - blob.lastModified < FRESH_MS;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    const part = blob.slice(start, end + 1);
    return new Response(buffered ? await part.arrayBuffer() : part, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(buffered ? await blob.arrayBuffer() : blob, { status: 200, headers });
}

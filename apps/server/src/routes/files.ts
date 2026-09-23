import { existsSync } from "node:fs";
import { zValidator } from "@hono/zod-validator";
import { idParamSchema, thumbQuerySchema } from "@openfield/core";
import { getAsset } from "@openfield/db";
import { type Context, Hono } from "hono";
import { absolutePath } from "../config/home";
import type { Env } from "../context";
import { Thumbs } from "../files/thumbs";
import { notFound, onInvalid } from "../http/errors";

// Binary under /files (§8.5.3). Plain HTTP; the browser fetches with the session header.

const IMMUTABLE = "public, max-age=31536000, immutable";

export const filesRoutes = new Hono<Env>()
  .get("/asset/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { db, paths } = c.var.svc;
    const asset = getAsset(db, c.req.valid("param").id);
    const file = asset && absolutePath(paths, asset.path);
    if (!asset || !file || !existsSync(file)) return notFound(c, "That image");
    return sendFile(c, file, { type: asset.mime, etag: `"${asset.sha256}"`, cache: IMMUTABLE });
  })
  .get(
    "/thumb/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", thumbQuerySchema, onInvalid),
    async (c) => {
      const { db, thumbs } = c.var.svc;
      const asset = getAsset(db, c.req.valid("param").id);
      if (!asset) return notFound(c, "That image");
      const thumb = await thumbs.get(asset, Thumbs.sizeFor(c.req.valid("query")));
      if (!existsSync(thumb.file)) return notFound(c, "That image");
      if (thumb.kind === "original") {
        // Not immutable, so real thumbnails take over once sharp loads (§8.5.2).
        return sendFile(c, thumb.file, { type: asset.mime, cache: "no-cache" });
      }
      return sendFile(c, thumb.file, { type: "image/webp", etag: thumb.etag, cache: IMMUTABLE });
    },
  );

/** Streams a file, with ETag revalidation and single byte ranges for the full-size viewer. */
function sendFile(c: Context, file: string, opts: { type: string; etag?: string; cache: string }): Response {
  const headers = new Headers({
    "content-type": opts.type,
    "cache-control": opts.cache,
    "accept-ranges": "bytes",
  });
  if (opts.etag) {
    headers.set("etag", opts.etag);
    if (c.req.header("if-none-match") === opts.etag) return new Response(null, { status: 304, headers });
  }
  const blob = Bun.file(file);
  const size = blob.size;
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
    return new Response(blob.slice(start, end + 1), { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(blob, { status: 200, headers });
}

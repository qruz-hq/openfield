import { zValidator } from "@hono/zod-validator";
import {
  type CanvasArchiveJob,
  type CanvasImportNeededResponse,
  type CanvasImportUpload,
  type CanvasImportUploadFileResponse,
  canvasExportToBodySchema,
  canvasImportBodySchema,
  canvasImportUploadFileQuerySchema,
  idParamSchema,
  type OkResponse,
  t,
  ulidSchema,
} from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { attachment } from "../files/names";
import { ApiFailure, notFound, onInvalid } from "../http/errors";
import { ZIP_BYTES_HEADER, ZIP_COUNT_HEADER } from "./assets";

// Canvas archives (§7.8): a canvas with every image it shows, as one .ofcanvas.zip. The browser
// downloads it as a stream; the desktop app and agents have the server save it at a path. Imports
// run as jobs the event stream follows (canvas_archive.updated); the browser sends an archive's
// files up first, in pieces, since it has no path to give.

/** How many images the canvas shows that weren't in the library to pack. */
export const ARCHIVE_MISSING_HEADER = "x-openfield-archive-missing";

const exportQuerySchema = z.object({ graphVersion: z.coerce.number().int().positive().optional() });
const uploadParamSchema = z.object({ uploadId: ulidSchema });

/** Paths on this computer come from the desktop app's own dialogs, never from a browser tab. */
function desktopOnly(desktop: boolean): void {
  if (desktop) return;
  throw new ApiFailure(403, "bad_request", "Paths are only taken from the desktop app", {
    userMessage: t("canvas.archive.errors.desktopOnly"),
  });
}

export const canvasArchivesRoutes = new Hono<Env>()
  .get(
    "/canvases/:id/export",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", exportQuerySchema, onInvalid),
    (c) => {
      const { graphVersion } = c.req.valid("query");
      const archive = c.var.svc.archives.download(c.req.valid("param").id, {
        ...(graphVersion !== undefined && { graphVersion }),
      });
      // Bun sends a streamed body chunked and drops Content-Length, so the size for the progress
      // toast rides in a header of its own too.
      return new Response(archive.stream, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(archive.zip.length),
          [ZIP_BYTES_HEADER]: String(archive.zip.length),
          [ZIP_COUNT_HEADER]: String(archive.assets),
          [ARCHIVE_MISSING_HEADER]: String(archive.missing),
          "content-disposition": attachment(archive.fileName),
          "cache-control": "no-store",
        },
      });
    },
  )
  .post(
    "/canvases/:id/export-to",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasExportToBodySchema, onInvalid),
    (c) => {
      desktopOnly(c.var.svc.desktop);
      const { path, overwrite } = c.req.valid("json");
      const job = c.var.svc.archives.exportTo(c.req.valid("param").id, path, {
        ...(overwrite !== undefined && { overwrite }),
      });
      return c.json(job satisfies CanvasArchiveJob, 202);
    },
  )
  .post("/canvas-imports", zValidator("json", canvasImportBodySchema, onInvalid), (c) => {
    const { path, uploadId, name } = c.req.valid("json");
    if (path !== undefined) desktopOnly(c.var.svc.desktop);
    const job = c.var.svc.archives.startImport(path !== undefined ? { path } : { uploadId: uploadId! }, {
      ...(name && { name }),
    });
    return c.json(job satisfies CanvasArchiveJob, 202);
  })
  .post("/canvas-imports/uploads", (c) => {
    const upload = c.var.svc.archives.createUpload();
    return c.json(upload satisfies CanvasImportUpload, 201);
  })
  // Plain HTTP by design: the body is the file's bytes themselves.
  .put(
    "/canvas-imports/uploads/:uploadId/files",
    zValidator("param", uploadParamSchema, onInvalid),
    zValidator("query", canvasImportUploadFileQuerySchema, onInvalid),
    async (c) => {
      const { path, offset } = c.req.valid("query");
      const saved = await c.var.svc.archives.writeUpload(
        c.req.valid("param").uploadId,
        path,
        offset,
        c.req.raw.body,
      );
      return c.json(saved satisfies CanvasImportUploadFileResponse, 200);
    },
  )
  .post(
    "/canvas-imports/uploads/:uploadId/needed",
    zValidator("param", uploadParamSchema, onInvalid),
    async (c) => {
      const files = await c.var.svc.archives.needed(c.req.valid("param").uploadId);
      return c.json({ files } satisfies CanvasImportNeededResponse, 200);
    },
  )
  .delete("/canvas-imports/uploads/:uploadId", zValidator("param", uploadParamSchema, onInvalid), (c) => {
    c.var.svc.archives.dropUpload(c.req.valid("param").uploadId);
    return c.json({ ok: true } satisfies OkResponse, 200);
  })
  .get("/canvas-archive-jobs/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const job = c.var.svc.archives.job(c.req.valid("param").id);
    if (!job) return notFound(c, "That export or import");
    return c.json(job satisfies CanvasArchiveJob, 200);
  })
  // Cancel. A finished job, or an import already writing to the library, answers as it is.
  .delete("/canvas-archive-jobs/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const job = c.var.svc.archives.cancel(c.req.valid("param").id);
    if (!job) return notFound(c, "That export or import");
    return c.json(job satisfies CanvasArchiveJob, 200);
  });

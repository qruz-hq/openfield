import { zValidator } from "@hono/zod-validator";
import {
  type CanvasDetail,
  type CanvasPatchResponse,
  type CanvasPreviewResponse,
  type CanvasSummary,
  type CanvasTemplate,
  type CanvasVersion,
  type CanvasVersionDetail,
  canvasCreateBodySchema,
  canvasesListQuerySchema,
  canvasPatchBodySchema,
  canvasPreviewQuerySchema,
  canvasVersionCreateBodySchema,
  canvasVersionParamSchema,
  idParamSchema,
  type OkResponse,
} from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { envelope, onInvalid } from "../http/errors";

// Canvas documents (§8.3): the index, create, autosave with a 409 on a stale graphVersion,
// duplicate, delete, version history, templates and card previews.

export const canvasesRoutes = new Hono<Env>()
  .get("/canvases", zValidator("query", canvasesListQuerySchema, onInvalid), (c) => {
    const list = c.var.svc.canvases.list(c.req.valid("query").q);
    return c.json(list satisfies CanvasSummary[], 200);
  })
  .post("/canvases", zValidator("json", canvasCreateBodySchema, onInvalid), (c) => {
    const detail = c.var.svc.canvases.create(c.req.valid("json"));
    return c.json(detail satisfies CanvasDetail, 201);
  })
  .get("/canvases/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const detail = c.var.svc.canvases.get(c.req.valid("param").id);
    return c.json(detail satisfies CanvasDetail, 200);
  })
  .patch(
    "/canvases/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasPatchBodySchema, onInvalid),
    (c) => {
      const result = c.var.svc.canvases.save(c.req.valid("param").id, c.req.valid("json"));
      if (!result.ok) return c.json(result.conflict, 409);
      return c.json(result.saved satisfies CanvasPatchResponse, 200);
    },
  )
  .delete("/canvases/:id", zValidator("param", idParamSchema, onInvalid), (c) => {
    const { id } = c.req.valid("param");
    // Its runs stop before the rows they write to go away.
    c.var.svc.canvasRuns.forgetCanvas(id);
    c.var.svc.canvases.remove(id);
    return c.json({ ok: true } satisfies OkResponse, 200);
  })
  .post("/canvases/:id/duplicate", zValidator("param", idParamSchema, onInvalid), (c) => {
    const detail = c.var.svc.canvases.duplicate(c.req.valid("param").id);
    return c.json(detail satisfies CanvasDetail, 201);
  })
  .get("/canvases/:id/versions", zValidator("param", idParamSchema, onInvalid), (c) => {
    const versions = c.var.svc.canvases.versions(c.req.valid("param").id);
    return c.json(versions satisfies CanvasVersion[], 200);
  })
  .post(
    "/canvases/:id/versions",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasVersionCreateBodySchema, onInvalid),
    (c) => {
      const version = c.var.svc.canvases.createVersion(c.req.valid("param").id, c.req.valid("json"));
      return c.json(version satisfies CanvasVersion, 201);
    },
  )
  .get("/canvases/:id/versions/:vid", zValidator("param", canvasVersionParamSchema, onInvalid), (c) => {
    const { id, vid } = c.req.valid("param");
    const version = c.var.svc.canvases.version(id, vid);
    return c.json(version satisfies CanvasVersionDetail, 200);
  })
  .post(
    "/canvases/:id/versions/:vid/restore",
    zValidator("param", canvasVersionParamSchema, onInvalid),
    (c) => {
      const { id, vid } = c.req.valid("param");
      const detail = c.var.svc.canvases.restore(id, vid);
      return c.json(detail satisfies CanvasDetail, 200);
    },
  )
  // Plain HTTP by design (§8.3.3): the body is the PNG itself, rendered by the browser.
  .put(
    "/canvases/:id/preview",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", canvasPreviewQuerySchema, onInvalid),
    async (c) => {
      if (!c.req.header("content-type")?.startsWith("image/png")) {
        return c.json(envelope("bad_request", "Send the preview as image/png"), 400);
      }
      const png = new Uint8Array(await c.req.arrayBuffer());
      const saved = c.var.svc.canvases.setPreview(c.req.valid("param").id, png, c.req.valid("query").theme);
      return c.json(saved satisfies CanvasPreviewResponse, 200);
    },
  )
  // Outside /canvases/ so a template id can never be read as a canvas id.
  .get("/canvas-templates", (c) => {
    const templates = c.var.svc.canvases.listTemplates();
    return c.json(templates satisfies CanvasTemplate[], 200);
  });

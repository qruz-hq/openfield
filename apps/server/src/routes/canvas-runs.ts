import { zValidator } from "@hono/zod-validator";
import {
  type CancelResponse,
  type CanvasRunResponse,
  type CanvasRunsResponse,
  canvasRunBodySchema,
  canvasRunNodeParamSchema,
  canvasRunParamSchema,
  canvasRunsQuerySchema,
  idParamSchema,
} from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Canvas runs (§7.7, §8.3). The browser sends a compiled plan; the server orders, queues, retries
// and recovers it, and reports progress on canvas_run.updated.

export const canvasRunsRoutes = new Hono<Env>()
  .post(
    "/canvases/:id/run",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasRunBodySchema, onInvalid),
    async (c) => {
      const body = c.req.valid("json");
      const result = await c.var.svc.canvasRuns.run(c.req.valid("param").id, body);
      // A dry run writes nothing, so it creates nothing.
      if (result.runId === null) return c.json(result satisfies CanvasRunResponse, 200);
      return c.json(result satisfies CanvasRunResponse, 201);
    },
  )
  .post("/canvases/:id/runs/:runId/cancel", zValidator("param", canvasRunParamSchema, onInvalid), (c) => {
    const { id, runId } = c.req.valid("param");
    const result = c.var.svc.canvasRuns.cancel(id, runId);
    return c.json(result satisfies CancelResponse, 200);
  })
  // A node band's Cancel: that node and what reads from it; the rest of the run carries on.
  .post(
    "/canvases/:id/runs/:runId/nodes/:nodeId/cancel",
    zValidator("param", canvasRunNodeParamSchema, onInvalid),
    (c) => {
      const { id, runId, nodeId } = c.req.valid("param");
      const result = c.var.svc.canvasRuns.cancelNode(id, runId, nodeId);
      return c.json(result satisfies CancelResponse, 200);
    },
  )
  .get(
    "/canvases/:id/runs",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("query", canvasRunsQuerySchema, onInvalid),
    (c) => {
      const runs = c.var.svc.canvasRuns.list(c.req.valid("param").id, c.req.valid("query").since);
      return c.json({ runs } satisfies CanvasRunsResponse, 200);
    },
  );

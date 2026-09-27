import { zValidator } from "@hono/zod-validator";
import {
  type CanvasEditsResponse,
  type CanvasRunScopeResponse,
  canvasEditsBodySchema,
  canvasRunScopeBodySchema,
  idParamSchema,
  navigateTargetSchema,
  tabIdSchema,
} from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Fake mode only (OPENFIELD_FAKE_PROVIDERS=1), mounted at /api/dev: requests that act as an agent,
// so tests and a developer can watch live edits, runs and presence without connecting one (§7.11).

const agent = z.object({
  name: z.string().trim().min(1).max(80).default("Test agent"),
  sessionId: z.string().min(1).max(128).default("dev-session"),
});

export const devAgentRoutes = new Hono<Env>()
  .post(
    "/agent/canvases/:id/edits",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasEditsBodySchema.extend({ agent: agent.prefault({}) }), onInvalid),
    (c) => {
      const { edits, graphVersion, agent: who } = c.req.valid("json");
      const result = c.var.svc.canvases.edit(
        c.req.valid("param").id,
        edits,
        { kind: "agent", ...who },
        { ...(graphVersion !== undefined && { graphVersion }) },
      );
      return c.json(result satisfies CanvasEditsResponse, 200);
    },
  )
  .post(
    "/agent/canvases/:id/run",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", canvasRunScopeBodySchema.extend({ agent: agent.prefault({}) }), onInvalid),
    async (c) => {
      const { agent: who, ...body } = c.req.valid("json");
      const result = await c.var.svc.canvasRuns.runScope(c.req.valid("param").id, body, {
        kind: "agent",
        ...who,
      });
      return c.json(result satisfies CanvasRunScopeResponse, 200);
    },
  )
  .get("/agent/active", (c) => c.json({ tab: c.var.svc.presence.active() }, 200))
  // A tab id picks the tab, so tests running side by side on one server don't meet.
  .post(
    "/agent/navigate",
    zValidator("json", z.object({ to: navigateTargetSchema, tabId: tabIdSchema.optional() }), onInvalid),
    (c) => {
      const { to, tabId } = c.req.valid("json");
      return c.json({ tabId: c.var.svc.presence.navigate(to, tabId) }, 200);
    },
  );

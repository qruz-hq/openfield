import { zValidator } from "@hono/zod-validator";
import { type AgentsStatus, agentsPutBodySchema } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Settings > Agents: turn agents on or off, make a new key, and see what they did today. The
// limits are ordinary settings (PATCH /api/settings). Session-guarded like every /api route, so
// only this app's own pages can read the key.

export const agentsRoutes = new Hono<Env>()
  .get("/agents", (c) => c.json(c.var.svc.agents.status() satisfies AgentsStatus, 200))
  .put("/agents", zValidator("json", agentsPutBodySchema, onInvalid), (c) => {
    c.var.svc.agents.setEnabled(c.req.valid("json").enabled);
    return c.json(c.var.svc.agents.status() satisfies AgentsStatus, 200);
  })
  .post("/agents/key", (c) => {
    c.var.svc.agents.newKey();
    return c.json(c.var.svc.agents.status() satisfies AgentsStatus, 200);
  });

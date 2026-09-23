import type { HealthResponse } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";

export const healthRoutes = new Hono<Env>().get("/health", (c) => {
  const { version, schemaTag, paths } = c.var.svc;
  return c.json({ ok: true, version, schema: schemaTag, home: paths.root } satisfies HealthResponse, 200);
});

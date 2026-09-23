import { zValidator } from "@hono/zod-validator";
import { generateBodySchema, type JobSetAccepted } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Returns 202 with placeholders sized for the result, before any provider call (§8.3.1).
export const generateRoutes = new Hono<Env>().post(
  "/generate",
  zValidator("json", generateBodySchema, onInvalid),
  async (c) => {
    const accepted = await c.var.svc.runner.createJobSet(c.req.valid("json"));
    return c.json(accepted satisfies JobSetAccepted, 202);
  },
);

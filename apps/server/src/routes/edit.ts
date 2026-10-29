import { zValidator } from "@hono/zod-validator";
import { editBodySchema, type JobSetAccepted } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// POST /api/edit (§0.6): every op but "generate", in the same body as /api/generate. The base and
// mask are checked before the job set exists, and the reply is the same 202 with placeholders.
export const editRoutes = new Hono<Env>().post(
  "/edit",
  zValidator("json", editBodySchema, onInvalid),
  async (c) => {
    const accepted = await c.var.svc.runner.createJobSet(c.req.valid("json"));
    return c.json(accepted satisfies JobSetAccepted, 202);
  },
);

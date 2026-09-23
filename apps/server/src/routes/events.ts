import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Plain HTTP by design (§8.3.3). ?since= and Last-Event-ID are accepted, and a reconnect always
// starts with a fresh snapshot rather than a replay (§8.3.2).
const eventsQuerySchema = z.object({ since: z.string().max(64).optional() });

export const eventsRoutes = new Hono<Env>().get(
  "/events",
  zValidator("query", eventsQuerySchema, onInvalid),
  (c) => c.var.svc.events.connect(c.req.raw.signal),
);

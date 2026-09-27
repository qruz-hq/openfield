import { zValidator } from "@hono/zod-validator";
import { tabIdSchema } from "@openfield/core";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Plain HTTP by design (§8.3.3). ?since= and Last-Event-ID are accepted, and a reconnect always
// starts with a fresh snapshot rather than a replay (§8.3.2). ?tab= names the tab, which is
// forgotten when its stream closes (§7.11).
const eventsQuerySchema = z.object({ since: z.string().max(64).optional(), tab: tabIdSchema.optional() });

export const eventsRoutes = new Hono<Env>().get(
  "/events",
  zValidator("query", eventsQuerySchema, onInvalid),
  (c) => {
    const { tab } = c.req.valid("query");
    const signal = c.req.raw.signal;
    if (tab) {
      c.var.svc.presence.connected(tab);
      signal.addEventListener("abort", () => c.var.svc.presence.drop(tab), { once: true });
    }
    return c.var.svc.events.connect(signal);
  },
);

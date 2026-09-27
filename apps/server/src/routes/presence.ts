import { zValidator } from "@hono/zod-validator";
import { type OkResponse, presenceBodySchema } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// Where a tab is (§7.11): its route, the canvas it shows and the selection there. Sent on every
// change and on focus, so "the canvas I have open" always means the tab the person used last.

export const presenceRoutes = new Hono<Env>().post(
  "/presence",
  zValidator("json", presenceBodySchema, onInvalid),
  (c) => {
    c.var.svc.presence.report(c.req.valid("json"));
    return c.json({ ok: true } satisfies OkResponse, 200);
  },
);

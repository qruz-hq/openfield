import { zValidator } from "@hono/zod-validator";
import { type Settings, settingsPatchSchema } from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { onInvalid } from "../http/errors";

// §6.17. Changes apply at once; the service tells whatever depends on them.
export const settingsRoutes = new Hono<Env>()
  .get("/settings", (c) => c.json(c.var.svc.settings.get() satisfies Settings, 200))
  .patch("/settings", zValidator("json", settingsPatchSchema, onInvalid), (c) => {
    // The server owns the model list timestamp.
    const { modelRefreshedAt: _, ...patch } = c.req.valid("json");
    return c.json(c.var.svc.settings.update(patch) satisfies Settings, 200);
  });

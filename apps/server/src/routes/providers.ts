import { zValidator } from "@hono/zod-validator";
import {
  CONCURRENCY_CAP_FIELD,
  idParamSchema,
  type ProviderSettingsResponse,
  type ProviderSummary,
  providerPatchBodySchema,
  providerSettingsPatchBodySchema,
} from "@openfield/core";
import { getProvider, updateProvider } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { notFound, onInvalid } from "../http/errors";
import { toProviderSummary } from "../mappers/provider";
import { providerSummaries as summaries } from "../services/provider-summaries";

export const providersRoutes = new Hono<Env>()
  .get("/providers", (c) => c.json(summaries(c.var.svc) satisfies ProviderSummary[], 200))
  .patch(
    "/providers/:id",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", providerPatchBodySchema, onInvalid),
    (c) => {
      const svc = c.var.svc;
      const { id } = c.req.valid("param");
      const provider = svc.providers.find((p) => p.meta.id === id);
      if (!provider || !getProvider(svc.db, id)) return notFound(c, "That company");
      const row = updateProvider(svc.db, id, c.req.valid("json"))!;
      // A new cap takes effect on the next tick, no restart needed.
      svc.runner.tick();
      return c.json(
        toProviderSummary(row, provider, svc.credentials.status(id)) satisfies ProviderSummary,
        200,
      );
    },
  )
  // The company settings modal (§6.17): the adapter's panels, then Openfield's Limits panel.
  .get("/providers/:id/settings", zValidator("param", idParamSchema, onInvalid), (c) => {
    const view = c.var.svc.providerSettings.view(c.req.valid("param").id);
    return c.json(view satisfies ProviderSettingsResponse, 200);
  })
  .patch(
    "/providers/:id/settings",
    zValidator("param", idParamSchema, onInvalid),
    zValidator("json", providerSettingsPatchBodySchema, onInvalid),
    (c) => {
      const svc = c.var.svc;
      const { values } = c.req.valid("json");
      const view = svc.providerSettings.update(c.req.valid("param").id, values);
      // New runs pick the rest up at submit; a new cap needs the scheduler to look again.
      if (CONCURRENCY_CAP_FIELD in values) svc.runner.tick();
      return c.json(view satisfies ProviderSettingsResponse, 200);
    },
  );

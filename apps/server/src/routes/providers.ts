import { zValidator } from "@hono/zod-validator";
import { idParamSchema, type ProviderSummary, providerPatchBodySchema } from "@openfield/core";
import { getProvider, listProviders, updateProvider } from "@openfield/db";
import { Hono } from "hono";
import type { Env, Services } from "../context";
import { notFound, onInvalid } from "../http/errors";
import { toProviderSummary } from "../mappers/provider";

function summaries(svc: Services): ProviderSummary[] {
  return listProviders(svc.db).flatMap((row) => {
    const provider = svc.providers.find((p) => p.meta.id === row.id);
    return provider ? [toProviderSummary(row, provider, svc.credentials.status(row.id))] : [];
  });
}

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
  );

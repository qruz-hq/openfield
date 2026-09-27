import { zValidator } from "@hono/zod-validator";
import {
  type CostEstimate,
  estimateBodySchema,
  type ModelListItem,
  type ModelsListResponse,
  type ModelsRefreshResponse,
  modelParamSchema,
  modelsListQuerySchema,
  modelsRefreshBodySchema,
} from "@openfield/core";
import { estimate, pricedOp, resolveProviderSettings } from "@openfield/providers/manifest";
import { Hono } from "hono";
import type { Env } from "../context";
import { notFound, onInvalid } from "../http/errors";
import { asksForPrice } from "../services/remote-prices";

export const modelsRoutes = new Hono<Env>()
  .get("/models", zValidator("query", modelsListQuerySchema, onInvalid), async (c) => {
    const { provider, modality, refresh } = c.req.valid("query");
    const { models } = c.var.svc;
    if (refresh === "1") await models.refresh(provider);
    return c.json(models.list({ provider, modality }) satisfies ModelsListResponse, 200);
  })
  .post("/models/refresh", zValidator("json", modelsRefreshBodySchema, onInvalid), async (c) => {
    const { providerId } = c.req.valid("json");
    return c.json((await c.var.svc.models.refresh(providerId)) satisfies ModelsRefreshResponse, 200);
  })
  .get("/models/:providerId/:modelId", zValidator("param", modelParamSchema, onInvalid), (c) => {
    const { providerId, modelId } = c.req.valid("param");
    const item = c.var.svc.models.list({ provider: providerId }).models.find((m) => m.modelId === modelId);
    if (!item) return notFound(c, "That model");
    return c.json(item satisfies ModelListItem, 200);
  })
  // For server-side callers and the canvas preview, priced at the speed the company's settings
  // resolve to for this model (§0.13). The composer prices locally with the same code, except for a
  // model its company prices per request (Higgsfield), which it asks here (§6.9).
  .post(
    "/models/:providerId/:modelId/estimate",
    zValidator("param", modelParamSchema, onInvalid),
    zValidator("json", estimateBodySchema, onInvalid),
    async (c) => {
      const { providerId, modelId } = c.req.valid("param");
      const svc = c.var.svc;
      const manifest = svc.models.get(`${providerId}:${modelId}`);
      if (!manifest) return notFound(c, "That model");
      const body = c.req.valid("json");
      // No answer (no key, a failure, a price with no amount) falls through to "Cost unknown".
      const asked = asksForPrice(manifest) ? await svc.prices.estimateFor(manifest, body) : null;
      if (asked) return c.json(asked satisfies CostEstimate, 200);
      const { schema, stored } = svc.providerSettings.forRun(providerId);
      const { speed } = resolveProviderSettings(schema, stored, manifest, pricedOp(body.op));
      const size =
        body.size?.kind === "pixels" ? { width: body.size.width, height: body.size.height } : undefined;
      const cost = estimate(manifest, {
        op: body.op,
        batch: body.batch,
        prompt: body.prompt ?? "",
        speed,
        ...(body.resolution && { resolution: body.resolution }),
        ...(body.quality && { quality: body.quality }),
        ...(size && { size }),
      });
      return c.json(cost satisfies CostEstimate, 200);
    },
  );

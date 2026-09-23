import { zValidator } from "@hono/zod-validator";
import {
  type ModelListItem,
  type ModelsListResponse,
  type ModelsRefreshResponse,
  modelParamSchema,
  modelsListQuerySchema,
  modelsRefreshBodySchema,
} from "@openfield/core";
import { Hono } from "hono";
import type { Env } from "../context";
import { notFound, onInvalid } from "../http/errors";

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
  });

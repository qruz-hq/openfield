import { zValidator } from "@hono/zod-validator";
import {
  type KeyStatus,
  type KeyTestResponse,
  keyPutBodySchema,
  keyTestBodySchema,
  providerParamSchema,
  t,
} from "@openfield/core";
import { getProvider } from "@openfield/db";
import { Hono } from "hono";
import type { Env } from "../context";
import { ApiFailure, onInvalid } from "../http/errors";
import { noWrites } from "../runner/provider-fetch";

// Status only (§6.11). No route returns a key; PUT takes one and answers with its status.

const KEY_TEST_TIMEOUT_MS = 20_000;

export const keysRoutes = new Hono<Env>()
  .get("/settings/keys", (c) => c.json(c.var.svc.credentials.statusAll() satisfies KeyStatus[], 200))
  .put(
    "/settings/keys/:providerId",
    zValidator("param", providerParamSchema, onInvalid),
    zValidator("json", keyPutBodySchema, onInvalid),
    (c) => {
      const { providerId } = c.req.valid("param");
      const { credentials, models, logger } = c.var.svc;
      const status = credentials.save(providerId, c.req.valid("json"));
      logger.info("Saved a key", { providerId });
      // A new key can unlock models the old one couldn't see.
      void models
        .refresh(providerId)
        .catch((error) => logger.warn("Couldn't update the model list", { error }));
      return c.json(status satisfies KeyStatus, 200);
    },
  )
  .delete("/settings/keys/:providerId", zValidator("param", providerParamSchema, onInvalid), (c) => {
    const { providerId } = c.req.valid("param");
    const status = c.var.svc.credentials.remove(providerId);
    c.var.svc.logger.info("Removed a key", { providerId });
    return c.json(status satisfies KeyStatus, 200);
  })
  .post(
    "/settings/keys/:providerId/test",
    zValidator("param", providerParamSchema, onInvalid),
    zValidator("json", keyTestBodySchema, onInvalid),
    async (c) => {
      const { providerId } = c.req.valid("param");
      const body = c.req.valid("json");
      const { credentials, contexts, ingest, settings, models, logger } = c.var.svc;
      const provider = credentials.provider(providerId);
      if (getProvider(c.var.svc.db, providerId)?.enabled === false) {
        throw new ApiFailure(409, "conflict", `${providerId} is turned off`, {
          userMessage: t("errors.companyOff", { company: provider.meta.displayName }),
        });
      }
      // A key sent with the check is only saved once it works (§2.10 step 5).
      const candidate = Object.keys(body).length ? credentials.candidate(providerId, body) : undefined;
      const ctx = contexts.for(
        provider,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(KEY_TEST_TIMEOUT_MS)]),
        noWrites((id) => ingest.read(id)),
        candidate && { candidate },
      );
      const result = await credentials.test(providerId, ctx, candidate);
      if (candidate && result.ok) {
        logger.info("Saved a key", { providerId });
        void models
          .refresh(providerId)
          .catch((error) => logger.warn("Couldn't update the model list", { error }));
      }
      // First run (§2.10 step 5): the first key that works picks the default model, the head of
      // that company's catalog. A default the person chose is never replaced.
      const first = provider.catalog()[0];
      if (result.ok && first && settings.get().defaultModel === null) {
        settings.update({ defaultModel: first.key });
      }
      return c.json(result satisfies KeyTestResponse, 200);
    },
  );

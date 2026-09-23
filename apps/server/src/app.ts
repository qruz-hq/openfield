import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Services } from "./context";
import { envelope, toErrorResponse } from "./http/errors";
import { crossSiteGuard, hostGuard, responseHeaders, sessionGuard } from "./http/guards";
import { spaHandler } from "./http/spa";
import { assetsRoutes } from "./routes/assets";
import { eventsRoutes } from "./routes/events";
import { filesRoutes } from "./routes/files";
import { generateRoutes } from "./routes/generate";
import { healthRoutes } from "./routes/health";
import { jobSetsRoutes } from "./routes/job-sets";
import { keysRoutes } from "./routes/keys";
import { modelsRoutes } from "./routes/models";
import { providersRoutes } from "./routes/providers";
import { settingsRoutes } from "./routes/settings";
import { statsRoutes } from "./routes/stats";
import { usageRoutes } from "./routes/usage";

// App composition (§8.3.3): the guards first, then /api and /files, then the web app.
// Routes are chained so `hc<AppType>` in apps/web can infer every JSON route.

const api = new Hono<Env>()
  .route("/", healthRoutes)
  .route("/", settingsRoutes)
  .route("/", statsRoutes)
  .route("/", keysRoutes)
  .route("/", providersRoutes)
  .route("/", modelsRoutes)
  .route("/", generateRoutes)
  .route("/", jobSetsRoutes)
  .route("/", assetsRoutes)
  .route("/", usageRoutes)
  .route("/", eventsRoutes);

const isBackendPath = (path: string) => /^\/(api|files)(\/|$)/.test(path);

/**
 * Every /api body today is small JSON. Uploads and masks get their own, larger caps when they
 * land (the PRD allows 20 MB references); Bun.serve's limit must then be raised to match.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export function createApp(svc: Services) {
  const app = new Hono<Env>()
    .use("*", responseHeaders(), hostGuard(svc.port), crossSiteGuard())
    .use("/api/*", sessionGuard(svc.token))
    .use(
      "/api/*",
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json(envelope("payload_too_large", "The request body is too large"), 413),
      }),
    )
    .use("/files/*", sessionGuard(svc.token))
    .use("*", async (c, next) => {
      c.set("svc", svc);
      await next();
    })
    .route("/api", api)
    .route("/files", filesRoutes);

  const spa = spaHandler({
    token: svc.token,
    dev: svc.dev,
    webDist: svc.webDist,
    viteOrigin: svc.viteOrigin,
  });
  app.get("*", (c) =>
    isBackendPath(c.req.path) ? c.json(envelope("not_found", "No such route"), 404) : spa(c),
  );
  app.notFound((c) =>
    isBackendPath(c.req.path)
      ? c.json(envelope("not_found", "No such route"), 404)
      : c.text("Not found", 404),
  );
  app.onError((err, c) => toErrorResponse(err, c, (msg, data) => svc.logger.error(msg, data)));
  return app;
}

export type AppType = ReturnType<typeof createApp>;

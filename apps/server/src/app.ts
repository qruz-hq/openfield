import { formatBytes, t, UPLOAD_MAX_BYTES } from "@openfield/core";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Services } from "./context";
import { envelope, toErrorResponse } from "./http/errors";
import { crossSiteGuard, hostGuard, responseHeaders, sessionGuard } from "./http/guards";
import { spaHandler } from "./http/spa";
import { assetsRoutes } from "./routes/assets";
import { canvasRunsRoutes } from "./routes/canvas-runs";
import { canvasesRoutes } from "./routes/canvases";
import { devAgentRoutes } from "./routes/dev-agent";
import { eventsRoutes } from "./routes/events";
import { filesRoutes } from "./routes/files";
import { foldersRoutes } from "./routes/folders";
import { generateRoutes } from "./routes/generate";
import { healthRoutes } from "./routes/health";
import { jobSetsRoutes } from "./routes/job-sets";
import { keysRoutes } from "./routes/keys";
import { libraryRoutes } from "./routes/library";
import { modelsRoutes } from "./routes/models";
import { presenceRoutes } from "./routes/presence";
import { providersRoutes } from "./routes/providers";
import { settingsRoutes } from "./routes/settings";
import { statsRoutes } from "./routes/stats";
import { uploadsRoutes } from "./routes/uploads";
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
  .route("/", foldersRoutes)
  .route("/", libraryRoutes)
  .route("/", usageRoutes)
  .route("/", uploadsRoutes)
  .route("/", canvasesRoutes)
  .route("/", canvasRunsRoutes)
  .route("/", presenceRoutes)
  .route("/", eventsRoutes);

const isBackendPath = (path: string) => /^\/(api|files)(\/|$)/.test(path);

/** Most /api bodies are small JSON. */
export const MAX_BODY_BYTES = 1024 * 1024;
const CANVAS_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** The routes that take more: an image, a whole canvas document, a run plan or a card preview. */
export const LARGER_BODIES: { method: string; path: RegExp; maxSize: number; userMessage?: () => string }[] =
  [
    // Room for the multipart envelope around the largest image.
    {
      method: "POST",
      path: /^\/api\/uploads$/,
      maxSize: UPLOAD_MAX_BYTES + 64 * 1024,
      userMessage: () => t("uploads.tooLarge", { size: formatBytes(UPLOAD_MAX_BYTES) }),
    },
    { method: "POST", path: /^\/api\/canvases$/, maxSize: CANVAS_DOCUMENT_BYTES },
    { method: "PATCH", path: /^\/api\/canvases\/[^/]+$/, maxSize: CANVAS_DOCUMENT_BYTES },
    // A batch of edits can add a node per edit, each with its settings.
    { method: "POST", path: /^\/api\/canvases\/[^/]+\/edits$/, maxSize: CANVAS_DOCUMENT_BYTES },
    // A plan names at most every node of a document, so it fits where the document does.
    { method: "POST", path: /^\/api\/canvases\/[^/]+\/run$/, maxSize: CANVAS_DOCUMENT_BYTES },
    { method: "PUT", path: /^\/api\/canvases\/[^/]+\/preview$/, maxSize: 4 * 1024 * 1024 },
  ];

/**
 * What Bun.serve lets through. Twice the largest route limit, so a body a little too big still
 * reaches the route's own limit and gets a reply that says why; past this, Bun answers a bare 413.
 */
export const MAX_REQUEST_BYTES = 2 * Math.max(MAX_BODY_BYTES, ...LARGER_BODIES.map((b) => b.maxSize));

const limiters = new Map<(typeof LARGER_BODIES)[number] | null, MiddlewareHandler>();
function limitFor(route: (typeof LARGER_BODIES)[number] | undefined): MiddlewareHandler {
  const key = route ?? null;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = bodyLimit({
      maxSize: route?.maxSize ?? MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          envelope("payload_too_large", "The request body is too large", {
            userMessage: route?.userMessage?.(),
          }),
          413,
        ),
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

const bodyLimits: MiddlewareHandler = (c, next) => {
  const larger = LARGER_BODIES.find((b) => b.method === c.req.method && b.path.test(c.req.path));
  return limitFor(larger)(c, next);
};

export function createApp(svc: Services) {
  const app = new Hono<Env>()
    .use("*", responseHeaders(), hostGuard(svc.port), crossSiteGuard())
    .use("/api/*", sessionGuard(svc.token))
    .use("/api/*", bodyLimits)
    .use("/files/*", sessionGuard(svc.token))
    .use("*", async (c, next) => {
      c.set("svc", svc);
      await next();
    })
    .route("/api", api)
    .route("/files", filesRoutes);
  // Fake mode only: stand in for an agent, so tests can watch a live edit arrive (§7.11).
  if (svc.fake) app.route("/api/dev", devAgentRoutes);

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

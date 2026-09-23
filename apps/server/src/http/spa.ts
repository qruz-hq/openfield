import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Context } from "hono";

// Everything outside /api and /files is the web app. In dev it comes from Vite, in production
// from apps/web/dist. Either way the session token goes into index.html, so the app has one
// origin and the guards behave the same in both (§0.16).

export const VITE_ORIGIN = "http://127.0.0.1:5173";

export interface SpaOptions {
  token: string;
  dev: boolean;
  /** Built web app. Null when it hasn't been built. */
  webDist: string | null;
  viteOrigin?: string;
}

export function injectToken(html: string, token: string): string {
  const meta = `<meta name="openfield-session" content="${token}" />`;
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (tag) => `${tag}\n    ${meta}`) : `${meta}\n${html}`;
}

/** index.html must never be cached: the token changes on every boot. */
function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"];

export function spaHandler(opts: SpaOptions) {
  const vite = opts.viteOrigin ?? VITE_ORIGIN;
  return (c: Context): Promise<Response> | Response =>
    opts.dev ? proxyToVite(c, vite, opts.token) : serveDist(c, opts);
}

async function proxyToVite(c: Context, origin: string, token: string): Promise<Response> {
  const url = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  for (const name of ["host", "connection", "origin", "cookie"]) headers.delete(name);
  // Uncompressed, so index.html can be edited on the way through.
  headers.set("accept-encoding", "identity");
  // Vite sends pages opened on its own port here; this marks the ones that came through us.
  headers.set("x-openfield-proxied", "1");

  let res: Response;
  try {
    res = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    });
  } catch {
    return c.text("The web app isn't running yet. Start Openfield with bun dev.", 502);
  }

  const out = new Headers(res.headers);
  for (const name of HOP_HEADERS) out.delete(name);
  if (res.headers.get("content-type")?.includes("text/html")) {
    const html = injectToken(await res.text(), token);
    out.set("content-type", "text/html; charset=utf-8");
    out.set("cache-control", "no-store");
    return new Response(html, { status: res.status, headers: out });
  }
  return new Response(res.body, { status: res.status, headers: out });
}

const NOT_BUILT = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Openfield</title></head>
  <body>
    <p>The web app hasn't been built yet. Run <code>bun run build</code>, then <code>bun start</code>.</p>
    <p>Or use <code>bun dev</code> while you work on it.</p>
  </body>
</html>
`;

async function serveDist(c: Context, opts: SpaOptions): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Not found", 404);
  // Absolute, so a relative OPENFIELD_WEB_DIST still passes the containment check below.
  const dist = opts.webDist && resolve(opts.webDist);
  const index = dist && resolve(dist, "index.html");
  if (!dist || !index || !existsSync(index)) return htmlResponse(injectToken(NOT_BUILT, opts.token));

  let relative: string;
  try {
    relative = decodeURIComponent(c.req.path).replace(/^\/+/, "");
  } catch {
    return c.text("Not found", 404);
  }
  const file = resolve(dist, relative);
  const inside = file.startsWith(dist + sep);
  if (inside && relative && existsSync(file) && statSync(file).isFile() && file !== index) {
    // Vite fingerprints everything under assets/, so those never change.
    const immutable = relative.startsWith("assets/");
    return new Response(Bun.file(file), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }
  // A path with an extension is a missing file; anything else is a client-side route.
  if (extname(relative)) return c.text("Not found", 404);
  return htmlResponse(injectToken(await Bun.file(index).text(), opts.token));
}

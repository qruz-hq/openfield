import { timingSafeEqual } from "node:crypto";
import { SESSION_HEADER } from "@openfield/core";
import type { Context, MiddlewareHandler } from "hono";
import { envelope } from "./errors";

// The four guards (§0.6). A loopback server is reachable from any page the browser has open,
// so all four run on every method, GET included.

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");
const isFilesPath = (path: string) => path === "/files" || path.startsWith("/files/");

function reject(c: Context, why: string): Response {
  if (isApiPath(c.req.path) || isFilesPath(c.req.path)) {
    return c.json(envelope("bad_request", why), 403);
  }
  return c.text(why, 403);
}

/** 1. Host allow-list: stops DNS rebinding, where evil.example resolves to 127.0.0.1. */
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !allowed.has(host)) {
      return reject(c, `Openfield only answers at http://127.0.0.1:${port}.`);
    }
    await next();
  };
}

const SUBRESOURCE_DESTS = new Set(["image", "script", "style"]);

/**
 * 3. Cross-site guard. Runs after the Host check, so the Host header is one of ours and
 * `http://<host>` is the app's own origin.
 */
export function crossSiteGuard(): MiddlewareHandler {
  return async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    const dest = c.req.header("sec-fetch-dest");
    const origin = c.req.header("origin");
    if (site === "cross-site") {
      return reject(c, "Open Openfield by typing its address into your browser.");
    }
    if (isApiPath(c.req.path) && dest && SUBRESOURCE_DESTS.has(dest)) {
      return reject(c, "This address can't be loaded by another page.");
    }
    if (origin !== undefined && origin !== `http://${c.req.header("host")}`) {
      return reject(c, "Requests from other sites aren't allowed.");
    }
    await next();
  };
}

/** 4. Session token: minted at boot, injected into index.html, required on /api and /files. */
export function sessionGuard(token: string): MiddlewareHandler {
  const expected = Buffer.from(token);
  return async (c, next) => {
    const sent = Buffer.from(c.req.header(SESSION_HEADER) ?? "");
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      return reject(c, "Missing or wrong session token. Reload the page.");
    }
    await next();
  };
}

const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "timing-allow-origin",
];

/**
 * 2. No CORS, ever, plus the defensive headers every response gets. Proxied responses (Vite in
 * dev) can carry CORS headers of their own, so they're stripped here, after every handler.
 */
export function responseHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    let headers = c.res.headers;
    try {
      for (const name of CORS_HEADERS) headers.delete(name);
    } catch {
      // Headers from fetch() are immutable; copy the response to edit them.
      c.res = new Response(c.res.body, c.res);
      headers = c.res.headers;
      for (const name of CORS_HEADERS) headers.delete(name);
    }
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-frame-options", "DENY");
    headers.set("cross-origin-resource-policy", "same-origin");
    headers.set("cross-origin-opener-policy", "same-origin");
  };
}

/** 32 random bytes, base64url. New on every boot, so a stale tab has to reload. */
export function mintSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

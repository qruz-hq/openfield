import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, expect } from "@playwright/test";
import { SESSION_HEADER } from "../packages/core/src/constants.ts";
import { newId } from "../packages/core/src/ids.ts";

// Helpers the e2e suites share. They talk to the server the way the web app does: with the session
// token from index.html.

export { SESSION_HEADER };

/** Any key works with the fake models, except one containing "invalid". */
export const FAKE_KEY = "AIzaFakeKeyForTheEndToEndSuite0000";

/** The token the server put in index.html, as the web app reads it. */
export async function sessionToken(request: APIRequestContext): Promise<string> {
  const html = await (await request.get("/")).text();
  const token = /<meta name="openfield-session" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("index.html has no session token");
  return token;
}

/** A JSON call with the session header. Fails the test on anything but a 2xx answer. */
export async function api<T>(
  request: APIRequestContext,
  token: string,
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await request.fetch(path, { method, headers: { [SESSION_HEADER]: token }, data });
  expect(res.ok(), `${method} ${path} answered ${res.status()}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** Where this server keeps its library, as it reports it. */
export async function libraryRoot(request: APIRequestContext, token: string): Promise<string> {
  return (await api<{ home: string }>(request, token, "GET", "/api/health")).home;
}

const queryScript = fileURLToPath(new URL("./query-db.ts", import.meta.url));

/** A read-only query against the library's SQLite file. */
export function queryDb<T>(home: string, sql: string, ...params: (string | number)[]): T[] {
  const out = execFileSync("bun", [queryScript, join(home, "openfield.db"), sql, JSON.stringify(params)]);
  return JSON.parse(out.toString()) as T[];
}

/**
 * Restarts the suite's server on the same library and port (e2e/serve.ts), and waits until the new
 * one answers. Each server mints its own session token, so the new token is how we know. Returns it.
 * `crash` kills it with SIGKILL instead of stopping it, so nothing it was doing gets to finish.
 */
export async function restartServer(
  request: APIRequestContext,
  home: string,
  opts: { crash?: boolean; timeout?: number } = {},
): Promise<string> {
  const before = await sessionToken(request);
  const serve = Number(readFileSync(join(dirname(home), "serve.pid"), "utf8"));
  process.kill(serve, opts.crash ? "SIGUSR1" : "SIGUSR2");
  let token = before;
  await expect
    .poll(
      async () => {
        token = await sessionToken(request).catch(() => before);
        return token !== before;
      },
      { timeout: opts.timeout ?? 30_000 },
    )
    .toBe(true);
  return token;
}

export const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Adds the fake key and makes one image through the API. Returns the new image's row id. */
export async function makeImage(request: APIRequestContext, token: string, prompt: string): Promise<string> {
  await api(request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
  const accepted = await api<{ jobSet: { id: string } }>(request, token, "POST", "/api/generate", {
    idempotencyKey: newId(),
    model: "google:gemini-3.1-flash-lite-image",
    op: "generate",
    prompt,
    size: { kind: "aspect", ratio: "1:1" },
    batch: 1,
    source: "api",
  });
  let assetId: string | null = null;
  await expect
    .poll(
      async () => {
        const sets = await api<{ items: { jobSet: { id: string }; jobs: { assetId: string | null }[] }[] }>(
          request,
          token,
          "GET",
          "/api/job-sets?status=all",
        );
        assetId = sets.items.find((s) => s.jobSet.id === accepted.jobSet.id)?.jobs[0]?.assetId ?? null;
        return assetId;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return assetId!;
}

import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { api, libraryRoot, makeImage, queryDb, SESSION_HEADER, sessionToken } from "./support";

// §0.6: a page on another origin can't list images, read key status, or cause a thumbnail to be
// made. The other pages are real sites served from this computer, so the browser applies its own
// rules exactly as it would to any page you have open.

let other: Server;
let otherPort: number;

test.beforeAll(async () => {
  other = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Another site</title>");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherPort = (other.address() as AddressInfo).port;
});

test.afterAll(() => new Promise<void>((resolve) => other.close(() => resolve())));

// localhost and 127.0.0.1 are different sites; another port on 127.0.0.1 is the same site but a
// different origin. Both must be refused.
const origins = [
  { name: "another site", url: () => `http://localhost:${otherPort}/` },
  { name: "another port on this computer", url: () => `http://127.0.0.1:${otherPort}/` },
];

/**
 * Every answer the app sent this page, read from Chrome's network log. The page's own events miss
 * answers the browser blocked, and those are exactly the ones this suite is about.
 */
async function watchApp(page: Page, appOrigin: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const urls = new Map<string, string>();
  const seen: { path: string; status: number; cors: boolean }[] = [];
  cdp.on("Network.requestWillBeSent", (event) => urls.set(event.requestId, event.request.url));
  cdp.on("Network.responseReceivedExtraInfo", (event) => {
    const url = new URL(urls.get(event.requestId) ?? "about:blank");
    if (url.origin !== appOrigin) return;
    const headers = Object.keys(event.headers).map((name) => name.toLowerCase());
    seen.push({
      path: url.pathname,
      status: event.statusCode,
      cors: headers.some((name) => name.startsWith("access-control-allow-")),
    });
  });
  return seen;
}

for (const origin of origins) {
  test(`${origin.name} can't list images or read key status`, async ({ page, request, baseURL }) => {
    const app = new URL(baseURL!).origin;
    const token = await sessionToken(request);
    await makeImage(request, token, "Something private");
    // The app itself can read both, so every refusal below is the guards at work.
    expect(
      (await api<{ items: unknown[] }>(request, token, "GET", "/api/assets")).items.length,
    ).toBeGreaterThan(0);
    await api(request, token, "GET", "/api/settings/keys");

    await page.goto(origin.url());
    const seen = await watchApp(page, app);
    const results = await page.evaluate(async (app) => {
      const attempt = async (path: string, init?: RequestInit) => {
        try {
          const res = await fetch(app + path, init);
          return { read: true, status: res.status, body: await res.text() };
        } catch {
          return { read: false };
        }
      };
      return {
        assets: await attempt("/api/assets"),
        keys: await attempt("/api/settings/keys"),
        guessedToken: await attempt("/api/settings/keys", { headers: { "X-Openfield-Session": "guess" } }),
        // no-cors skips the CORS check; the server must refuse it on its own.
        blind: await attempt("/api/assets", { mode: "no-cors" }),
      };
    }, app);

    expect(results).toEqual({
      assets: { read: false },
      keys: { read: false },
      guessedToken: { read: false },
      blind: { read: false },
    });

    // Each attempt reached the server and was refused there, with no CORS header on any answer.
    await expect.poll(() => seen.length).toBeGreaterThanOrEqual(4);
    for (const answer of seen) expect(answer, answer.path).toMatchObject({ status: 403, cors: false });
  });

  test(`${origin.name} can't cause a thumbnail to be made`, async ({ page, request, baseURL }) => {
    const app = new URL(baseURL!).origin;
    const token = await sessionToken(request);
    const home = await libraryRoot(request, token);
    const assetId = await makeImage(request, token, "A thumbnail nobody asked for");
    const [row] = queryDb<{ sha256: string }>(home, "SELECT sha256 FROM assets WHERE id = ?", assetId);
    // A size the app never asked for, so it can't already be in the cache.
    const thumb = join(home, "thumbs", row!.sha256.slice(0, 2), `${row!.sha256}@h640.webp`);
    expect(existsSync(thumb)).toBe(false);

    await page.goto(origin.url());
    const seen = await watchApp(page, app);
    const loaded = await page.evaluate(
      (src) =>
        new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = src;
        }),
      `${app}/files/thumb/${assetId}?h=640`,
    );

    expect(loaded).toBe(false);
    await expect
      .poll(() => seen)
      .toContainEqual({ path: `/files/thumb/${assetId}`, status: 403, cors: false });
    expect(existsSync(thumb)).toBe(false);
  });
}

test("a request under another host name is refused", async ({ baseURL }) => {
  // DNS rebinding: evil.example resolves to 127.0.0.1, so the browser sends its own Host header.
  const app = new URL(baseURL!);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: app.hostname,
        port: app.port,
        path: "/api/settings/keys",
        headers: { host: `evil.example:${app.port}`, [SESSION_HEADER]: "not-needed-to-fail" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(status).toBe(403);
});

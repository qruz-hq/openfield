import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { feedPage } from "@openfield/db";
import { completed, generate, HOST, ORIGIN, saveKey, startTestServer, type TestServer } from "./helpers";

// §0.6: a cross-origin page can't list assets, read key status or cause a thumbnail to be made.

const CORS = ["access-control-allow-origin", "access-control-allow-credentials", "timing-allow-origin"];

let server: TestServer;
afterEach(() => server?.close());

const thumbFiles = (home: string) => {
  const dir = join(home, "thumbs");
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".webp"))
    : [];
};

describe("guards", () => {
  test("the app's own requests get through", async () => {
    server = await startTestServer();
    const res = await server.request("/api/health", {
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; schema: string };
    expect(body.ok).toBe(true);
    expect(body.schema).toBe("0004_job_error_action");
  });

  test("a wrong Host is rejected, even with the token", async () => {
    server = await startTestServer();
    for (const host of ["evil.example", "evil.example:4317", "127.0.0.1:9999", "0.0.0.0:4317"]) {
      const res = await server.request("/api/health", { headers: { host } });
      expect(res.status).toBe(403);
    }
    expect((await server.request("/api/health", { headers: { host: "localhost:4317" } })).status).toBe(200);
  });

  test("a missing or wrong session token is rejected on /api and /files", async () => {
    server = await startTestServer();
    expect((await server.request("/api/health", { session: false })).status).toBe(403);
    expect((await server.request("/api/health", { headers: { "x-openfield-session": "nope" } })).status).toBe(
      403,
    );
    const almost = `${server.token.slice(0, -1)}x`;
    expect(
      (await server.request("/api/settings", { headers: { "x-openfield-session": almost } })).status,
    ).toBe(403);
    expect((await server.request("/files/thumb/01K6BQ8A1C4D7E9F0000000000", { session: false })).status).toBe(
      403,
    );
    const body = (await (await server.request("/api/assets", { session: false })).json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("bad_request");
  });

  test("a cross-origin page can't list assets, read key status or make a thumbnail", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    await server.services.thumbs.idle();
    const assetId = feedPage(server.services.db).items[0]!.id;
    rmSync(join(server.home, "thumbs"), { recursive: true, force: true });

    // Even a page that somehow had the token is stopped by the cross-site guard.
    const attacks: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { origin: "http://127.0.0.1:4318", "sec-fetch-site": "same-site" },
    ];
    for (const headers of attacks) {
      for (const path of ["/api/assets", "/api/settings/keys", `/files/thumb/${assetId}?h=200`]) {
        const res = await server.request(path, { headers });
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(assetId);
      }
    }
    // And without the token at all.
    for (const path of ["/api/assets", "/api/settings/keys", `/files/thumb/${assetId}?h=200`]) {
      expect((await server.request(path, { session: false })).status).toBe(403);
    }
    expect(thumbFiles(server.home)).toEqual([]);

    // The same request from the app itself does make one.
    expect((await server.request(`/files/thumb/${assetId}?h=200`)).status).toBe(200);
    expect(thumbFiles(server.home).length).toBe(1);
  });

  test("an /api path can't be loaded as an image, script or style", async () => {
    server = await startTestServer();
    for (const dest of ["image", "script", "style"]) {
      const res = await server.request("/api/assets", { headers: { "sec-fetch-dest": dest } });
      expect(res.status).toBe(403);
    }
    expect((await server.request("/api/assets", { headers: { "sec-fetch-dest": "empty" } })).status).toBe(
      200,
    );
  });

  test("an oversized /api body is refused before it's parsed", async () => {
    server = await startTestServer();
    const big = JSON.stringify({ apiKey: "x".repeat(2 * 1024 * 1024) });
    const res = await server.request("/api/settings/keys/google", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
  });

  test("no response ever carries CORS headers, preflights included", async () => {
    server = await startTestServer();
    const responses = [
      await server.request("/api/health"),
      await server.request("/api/health", { session: false }),
      await server.request("/api/assets", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      await server.request("/api/nope"),
      await server.request("/"),
      await server.request("/api/health", { headers: { host: "evil.example" } }),
    ];
    for (const res of responses) {
      for (const name of CORS) expect(res.headers.get(name)).toBeNull();
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });
});

describe("the web app", () => {
  test("production: index.html gets the session token and is never cached", async () => {
    const dist = mkdtempSync(join(tmpdir(), "openfield-dist-"));
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    writeFileSync(join(dist, "app.js"), "console.log(1)");
    try {
      server = await startTestServer({ webDist: dist });
      for (const path of ["/", "/image", "/settings/keys"]) {
        const res = await server.request(path, { session: false });
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toContain(`<meta name="openfield-session" content="${server.token}" />`);
      }
      expect(await (await server.request("/app.js", { session: false })).text()).toBe("console.log(1)");
      expect((await server.request("/missing.js", { session: false })).status).toBe(404);
      // A path that climbs out of dist gets the app, never the file.
      const climbed = await server.request("/..%2f..%2fetc%2fpasswd", { session: false });
      expect(await climbed.text()).toContain('name="openfield-session"');
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("production: a relative dist path serves its assets too", async () => {
    const dist = mkdtempSync(join(tmpdir(), "openfield-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(2)");
    try {
      server = await startTestServer({ webDist: relative(process.cwd(), dist) });
      const res = await server.request("/assets/index-abc.js", { session: false });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("console.log(2)");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("production without a build still hands out the token", async () => {
    server = await startTestServer({ webDist: null });
    const html = await (await server.request("/", { session: false })).text();
    expect(html).toContain(server.token);
  });

  test("dev: proxies to Vite, injects the token and strips Vite's CORS headers", async () => {
    const vite = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        const cors = { "access-control-allow-origin": "*", "timing-allow-origin": "*" };
        if (path === "/src/main.tsx") {
          return new Response("export {}", { headers: { "content-type": "text/javascript", ...cors } });
        }
        return new Response("<html><head></head><body>vite</body></html>", {
          headers: { "content-type": "text/html", ...cors },
        });
      },
    });
    try {
      server = await startTestServer({ dev: true, viteOrigin: `http://127.0.0.1:${vite.port}` });
      const page = await server.request("/image", { session: false, headers: { host: HOST } });
      expect(await page.text()).toContain(server.token);
      const script = await server.request("/src/main.tsx", { session: false });
      expect(await script.text()).toBe("export {}");
      for (const res of [page, script]) for (const name of CORS) expect(res.headers.get(name)).toBeNull();
    } finally {
      vite.stop(true);
    }
  });
});

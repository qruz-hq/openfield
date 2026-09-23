import { afterEach, describe, expect, test } from "bun:test";
import { errorEnvelopeSchema, type ProviderSummary, SETTINGS_DEFAULTS, type Settings } from "@openfield/core";
import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "../src/app-type";
import { HOST, startTestServer, type TestServer } from "./helpers";

// §6.17 settings through GET/PATCH, live without a restart, plus the typed client's view of the app.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("settings", () => {
  test("GET returns every default; PATCH saves only what changed", async () => {
    server = await startTestServer();
    expect((await server.json<Settings>("/api/settings")).body).toEqual(SETTINGS_DEFAULTS);
    const patched = await server.json<Settings>("/api/settings", {
      method: "PATCH",
      body: { feedZoom: 2, theme: "light", trashRetentionDays: 30 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      feedZoom: 2,
      theme: "light",
      trashRetentionDays: 30,
      tipsCard: true,
    });
    expect((await server.json<Settings>("/api/settings")).body.feedZoom).toBe(2);
  });

  test("bad values and unknown keys are refused with the field named", async () => {
    server = await startTestServer();
    const zoom = await server.json("/api/settings", { method: "PATCH", body: { feedZoom: 9 } });
    expect(zoom.status).toBe(400);
    expect(errorEnvelopeSchema.parse(zoom.body).error).toMatchObject({
      code: "bad_request",
      field: "feedZoom",
    });
    const unknown = await server.json("/api/settings", { method: "PATCH", body: { colour: "red" } });
    expect(unknown.status).toBe(400);
  });

  test("changes apply without a restart", async () => {
    server = await startTestServer();
    await server.json("/api/settings", {
      method: "PATCH",
      body: { logLevel: "debug", globalConcurrency: 1 },
    });
    expect(server.services.settings.get()).toMatchObject({ logLevel: "debug", globalConcurrency: 1 });
  });

  test("the model list timestamp belongs to the server", async () => {
    server = await startTestServer();
    await server.json("/api/settings", {
      method: "PATCH",
      body: { modelRefreshedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(server.services.settings.get().modelRefreshedAt).toBeNull();
  });
});

describe("typed client", () => {
  test("hc<AppType> reaches the same routes", async () => {
    server = await startTestServer();
    // The client runs in a page on our own origin, where the browser sets Host itself.
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("host", HOST);
      return server!.app.request(String(input instanceof Request ? input.url : input), { ...init, headers });
    }) as typeof globalThis.fetch;
    const client = hc<AppType>(`http://${HOST}`, { fetch, headers: { "X-Openfield-Session": server.token } });

    const res = await client.api.providers.$get();
    const providers: ProviderSummary[] = await res.json();
    expect(providers.map((p) => p.id)).toEqual(["google"]);

    // Compile-time: the 202 body of POST /api/generate is the accepted job set.
    type Accepted = InferResponseType<typeof client.api.generate.$post, 202>;
    const check = (a: Accepted) => a.jobs[0]?.width;
    expect(typeof check).toBe("function");
  });
});

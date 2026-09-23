import { afterEach, describe, expect, test } from "bun:test";
import {
  errorEnvelopeSchema,
  type ProviderSettingsResponse,
  type ProviderSummary,
  providerSettingsResponseSchema,
} from "@openfield/core";
import { getProvider } from "@openfield/db";
import { hc } from "hono/client";
import type { AppType } from "../src/app-type";
import { HOST, ORIGIN, startTestServer, type TestServer } from "./helpers";

// §0.3, §6.17 and §8.3: the company settings modal's schema and values, stored per company.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PATH = "/api/providers/google/settings";
const patch = (s: TestServer, values: Record<string, unknown>) =>
  s.json<ProviderSettingsResponse>(PATH, { method: "PATCH", body: { values } });

describe("GET /api/providers/:id/settings", () => {
  test("works without a key: Google's panels, then Openfield's Limits panel, every value filled", async () => {
    server = await startTestServer();
    const res = await server.json<ProviderSettingsResponse>(PATH);
    expect(res.status).toBe(200);
    const body = providerSettingsResponseSchema.parse(res.body);
    expect(body.schema.panels.map((p) => p.label)).toEqual(["Speed", "When it's busy", "Limits"]);
    const speed = body.schema.panels[0]!.fields.find((f) => f.id === "speed");
    expect(speed?.kind === "select" && speed.options.map((o) => o.label)).toEqual([
      "Standard",
      "Flex",
      "Batch",
      "Priority",
    ]);
    const limits = body.schema.panels[2]!;
    expect(limits.label).toBe("Limits");
    expect(limits.fields[0]).toMatchObject({ id: "concurrencyCap", label: "Runs at once", default: 4 });
    expect(body.values).toEqual({ speed: "standard", flexBusy: "wait", concurrencyCap: 4 });
  });

  test("an unknown company is a 404", async () => {
    server = await startTestServer();
    const res = await server.json(`/api/providers/nope/settings`);
    expect(res.status).toBe(404);
    expect(errorEnvelopeSchema.parse(res.body).error.code).toBe("not_found");
  });
});

describe("PATCH /api/providers/:id/settings", () => {
  test("stores only what differs from the default, and returns the same shape as GET", async () => {
    server = await startTestServer();
    const res = await patch(server, { speed: "flex", flexBusy: "standard" });
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({ speed: "flex", flexBusy: "standard", concurrencyCap: 4 });
    expect(res.body.schema.panels.map((p) => p.id)).toEqual(["speed", "flexBusy", "limits"]);
    expect(getProvider(server.services.db, "google")!.settings).toEqual({
      speed: "flex",
      flexBusy: "standard",
    });

    // Back to a default: removed from the stored object, so a changed default reaches this person.
    await patch(server, { flexBusy: "wait" });
    expect(getProvider(server.services.db, "google")!.settings).toEqual({ speed: "flex" });
    await patch(server, { speed: "standard" });
    expect(getProvider(server.services.db, "google")!.settings).toBeNull();
    expect((await server.json<ProviderSettingsResponse>(PATH)).body.values.speed).toBe("standard");
  });

  test("Runs at once writes providers.concurrency_cap, never the company's own settings", async () => {
    server = await startTestServer();
    const res = await patch(server, { concurrencyCap: 2 });
    expect(res.body.values.concurrencyCap).toBe(2);
    const row = getProvider(server.services.db, "google")!;
    expect([row.concurrencyCap, row.settings]).toEqual([2, null]);
    const providers = await server.json<ProviderSummary[]>("/api/providers");
    expect(providers.body[0]!.concurrencyCap).toBe(2);
  });

  test("an unknown field or a value that doesn't fit is refused with the field named", async () => {
    server = await startTestServer();
    const cases: [Record<string, unknown>, string][] = [
      [{ turbo: true }, "values.turbo"],
      [{ speed: "turbo" }, "values.speed"],
      [{ flexBusy: 1 }, "values.flexBusy"],
      [{ concurrencyCap: 99 }, "values.concurrencyCap"],
      [{ concurrencyCap: 1.5 }, "values.concurrencyCap"],
    ];
    for (const [values, field] of cases) {
      const res = await patch(server, values);
      expect(res.status).toBe(400);
      expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({ code: "bad_request", field });
    }
    const extra = await server.json(PATH, { method: "PATCH", body: { values: {}, speed: "flex" } });
    expect(extra.status).toBe(400);
    // Nothing was saved along the way.
    expect(getProvider(server.services.db, "google")!.settings).toBeNull();
    expect(getProvider(server.services.db, "google")!.concurrencyCap).toBe(4);
  });

  test("a stored value that no longer fits reads as its default and isn't rewritten", async () => {
    server = await startTestServer();
    server.services.db.$client.run(
      `UPDATE providers SET settings = '{"speed":"warp","gone":1}' WHERE id = 'google'`,
    );
    const res = await server.json<ProviderSettingsResponse>(PATH);
    expect(res.body.values).toMatchObject({ speed: "standard", flexBusy: "wait" });
    expect(getProvider(server.services.db, "google")!.settings).toEqual({ speed: "warp", gone: 1 });
  });
});

describe("guards", () => {
  test("the settings routes need the session token and refuse other sites, GET included", async () => {
    server = await startTestServer();
    for (const method of ["GET", "PATCH"]) {
      const body = method === "PATCH" ? JSON.stringify({ values: { speed: "batch" } }) : undefined;
      const headers = { "content-type": "application/json" };
      expect((await server.request(PATH, { method, body, headers, session: false })).status).toBe(403);
      const hostiles: Record<string, string>[] = [
        { origin: "https://evil.example" },
        { "sec-fetch-site": "cross-site" },
      ];
      for (const hostile of hostiles) {
        const res = await server.request(PATH, { method, body, headers: { ...headers, ...hostile } });
        expect(res.status).toBe(403);
      }
      expect(
        (await server.request(PATH, { method, body, headers: { ...headers, host: "evil.example" } })).status,
      ).toBe(403);
    }
    expect(getProvider(server.services.db, "google")!.settings).toBeNull();
    const own = await server.request(PATH, { headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } });
    expect(own.status).toBe(200);
  });

  test("the typed client reaches both routes", async () => {
    server = await startTestServer();
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("host", HOST);
      return server!.app.request(String(input instanceof Request ? input.url : input), { ...init, headers });
    }) as typeof globalThis.fetch;
    const client = hc<AppType>(`http://${HOST}`, { fetch, headers: { "X-Openfield-Session": server.token } });
    const saved = await client.api.providers[":id"].settings.$patch({
      param: { id: "google" },
      json: { values: { speed: "batch" } },
    });
    expect(saved.status).toBe(200);
    const read = await client.api.providers[":id"].settings.$get({ param: { id: "google" } });
    if (read.status !== 200) throw new Error(`Unexpected ${read.status}`);
    expect((await read.json()).values.speed).toBe("batch");
  });
});

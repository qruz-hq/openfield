import { afterEach, describe, expect, test } from "bun:test";
import type { CanvasDetail, ModelsListResponse, ProviderSummary, Settings } from "@openfield/core";
import { getJobSet, jobsOf } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import { completed, generate, startTestServer, type TestServer } from "./helpers";

// The Higgsfield adapter through the whole server, against its fake: a queue call that the runner
// follows by id, and an image downloaded from the declared image host past the host allow-list.
// It's an early company (meta.stable false), so its models show only with Settings > Experimental
// > Show early models on, and are never picked for the person.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("Higgsfield through the runner", () => {
  test("a SOUL V2 image is followed by its request id and saved from the image host", async () => {
    server = await startTestServer();
    const saved = await server.json("/api/settings/keys/higgsfield", {
      method: "PUT",
      body: { apiKey: "hf-test-id:hf-test-secret-4d1a" },
    });
    expect(saved.status).toBe(200);

    const accepted = await generate(server, {
      model: "higgsfield:soul-v2",
      size: { kind: "aspect", ratio: "3:4" },
    });
    const done = await completed(server, accepted.jobSet.id, 20_000);
    expect(done.status).toBe("succeeded");

    const db = server.services.db;
    expect(getJobSet(db, accepted.jobSet.id)?.providerId).toBe("higgsfield");
    const [job] = jobsOf(db, accepted.jobSet.id);
    // Resumable: the request id was stored before the first status read.
    expect(job?.providerJobId).toBeTruthy();
    const usage = db.$client
      .query<{ outcome: string }, [string]>("SELECT outcome FROM usage_log WHERE job_set_id = ?")
      .all(accepted.jobSet.id);
    expect(usage).toEqual([{ outcome: "succeeded" }]);
  }, 30_000);
});

describe("Higgsfield is an early company", () => {
  const HF_KEY = "hf-test-id:hf-test-secret-4d1a";
  const higgsfieldModels = async (s: TestServer) =>
    (await s.json<ModelsListResponse>("/api/models")).body.models.filter(
      (m) => m.providerId === "higgsfield",
    );

  test("its models stay off the list until Show early models is on", async () => {
    server = await startTestServer();
    expect(await higgsfieldModels(server)).toEqual([]);
    expect((await server.json("/api/models/higgsfield/soul-v2")).status).toBe(404);
    // The company itself stays listed, so its name still labels past work and spending.
    const providers = (await server.json<ProviderSummary[]>("/api/providers")).body;
    expect(providers.find((p) => p.id === "higgsfield")?.meta.stable).toBe(false);

    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    const shown = await higgsfieldModels(server);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((m) => !m.ready)).toBe(true);
  });

  test("while hidden, the model check never calls it, even with a key", async () => {
    const calls: string[] = [];
    const inner = createFakeFetch({ delayMs: 0 });
    server = await startTestServer({
      fetch: (input, init) => {
        calls.push(new URL(input instanceof Request ? input.url : input).host);
        return inner(input, init);
      },
    });
    await server.json("/api/settings/keys/higgsfield", { method: "PUT", body: { apiKey: HF_KEY } });
    await server.json("/api/models/refresh", { method: "POST", body: {} });
    expect(calls).not.toContain("api.higgsfield.ai");

    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    await server.json("/api/models/refresh", { method: "POST", body: {} });
    expect(calls).toContain("api.higgsfield.ai");
  });

  test("a working key never makes it the default model", async () => {
    server = await startTestServer();
    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    const check = await server.json("/api/settings/keys/higgsfield/test", {
      method: "POST",
      body: { apiKey: HF_KEY },
    });
    expect(check.body).toMatchObject({ ok: true });
    expect((await higgsfieldModels(server)).every((m) => m.ready)).toBe(true);
    expect((await server.json<Settings>("/api/settings")).body.defaultModel).toBeNull();

    // A new canvas has nothing to fill its Generate node with either.
    const canvas = await server.json<CanvasDetail>("/api/canvases", {
      method: "POST",
      body: { templateId: "storyboard" },
    });
    expect(canvas.status).toBe(201);
    expect(canvas.body.graph.nodes.some((n) => typeof n.params.model === "string")).toBe(false);
  });
});

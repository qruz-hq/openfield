import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ModelsListResponse,
  type ModelsRefreshResponse,
  modelsListResponseSchema,
} from "@openfield/core";
import { listModels } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import { saveKey, startTestServer, TEST_KEY, type TestServer, waitFor } from "./helpers";

// §6.4 and M0-08: static catalogs with no key, recognised discoveries with one, 24 h staleness.

/** A key that sees Nano Banana Pro only as a preview, so discovery has something to add. */
const previewOnly = () => createFakeFetch({ delayMs: 0, hiddenModels: ["gemini-3-pro-image"] });

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("model registry", () => {
  test("with no key the static catalog is listed, none of it ready", async () => {
    server = await startTestServer();
    const res = await server.json<ModelsListResponse>("/api/models");
    const list = modelsListResponseSchema.parse(res.body);
    // Higgsfield is an early company, off the list until Settings > Experimental (higgsfield.test.ts).
    expect(list.models.map((m) => m.key)).toEqual([
      "google:gemini-3-pro-image",
      "google:gemini-3.1-flash-image",
      "google:gemini-3.1-flash-lite-image",
      "openai:gpt-image-2.5-sunburst",
      "openai:gpt-image-2.5-flare",
      "openai:gpt-image-2",
    ]);
    expect(list.models.every((m) => !m.ready && m.enabled)).toBe(true);
    expect(list.staleAt).toBeNull();
    // The models table keeps every company's rows; only the list hides early ones.
    const rows = listModels(server.services.db).filter((r) => r.providerId !== "higgsfield");
    expect(rows).toHaveLength(6);
    // Speeds travel with the manifest (and into the models table); the batch path never does.
    expect(list.models.map((m) => m.speeds?.map((o) => o.id))).toEqual([
      ["batch", "flex", "priority"],
      ["batch"],
      ["batch"],
      // OpenAI: only GPT Image 2 offers Batch.
      undefined,
      undefined,
      ["batch"],
    ]);
    expect((res.body as { models: object[] }).models.every((m) => !("batch" in m))).toBe(true);
    expect(rows.map((r) => r.speeds?.length)).toEqual([3, 1, 1, undefined, undefined, 1]);
  });

  test("a discovered model's manifest carries its speeds but never the batch path", async () => {
    server = await startTestServer({ fetch: previewOnly() });
    await saveKey(server);
    await server.json("/api/models/refresh", { method: "POST", body: {} });
    const home = server.home;
    await server.close({ keepHome: true });
    // After a restart, discoveries are rebuilt from their ids through the adapter.
    server = await startTestServer({ home, fetch: previewOnly() });
    const res = await server.json<{ models: Record<string, unknown>[] }>("/api/models");
    const preview = res.body.models.find((m) => m.modelId === "gemini-3-pro-image-preview");
    expect(preview).toBeDefined();
    expect("batch" in preview!).toBe(false);
  });

  test("refresh adds recognised models, lists the rest as not supported, and sets the next check 24 h out", async () => {
    server = await startTestServer({ fetch: previewOnly() });
    await saveKey(server);
    const res = await server.json<ModelsRefreshResponse>("/api/models/refresh", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const list = modelsListResponseSchema.parse((await server.json("/api/models")).body);
    expect(list.models.map((m) => m.modelId)).toContain("gemini-3-pro-image-preview");
    expect(server.services.models.unrecognised("google").map((u) => u.modelId)).toContain(
      "gemini-embedding-001",
    );

    const refreshedAt = Date.parse(server.services.settings.get().modelRefreshedAt!);
    expect(Date.parse(list.staleAt!) - refreshedAt).toBe(24 * 3_600_000);
    expect(server.services.models.isStale()).toBe(false);
    expect(server.services.models.isStale(Date.now() + 25 * 3_600_000)).toBe(true);
  });

  test("saving a key refreshes that company's models in the background", async () => {
    server = await startTestServer({ fetch: previewOnly() });
    await saveKey(server);
    await waitFor(() => server!.services.models.get("google:gemini-3-pro-image-preview"));
    expect(server.events.some((e) => e.event === "models.updated")).toBe(true);
  });

  test("discovered models survive a restart", async () => {
    server = await startTestServer({ fetch: previewOnly() });
    await saveKey(server);
    await server.json("/api/models/refresh", { method: "POST", body: { providerId: "google" } });
    const home = server.home;
    await server.close({ keepHome: true });

    server = await startTestServer({ home, fetch: previewOnly() });
    const model = await server.json<{ source: string; ready: boolean }>(
      "/api/models/google/gemini-3-pro-image-preview",
    );
    expect(model.status).toBe(200);
    expect(model.body).toMatchObject({ source: "discovered", ready: true });
  });

  test("a failed refresh keeps the last good list and says why", async () => {
    server = await startTestServer();
    await saveKey(server, "a-key-that-is-invalid-000");
    const res = await server.json<ModelsRefreshResponse>("/api/models/refresh", { method: "POST", body: {} });
    expect(res.body.errors).toEqual([
      { providerId: "google", code: "auth_invalid", message: "This key was rejected." },
    ]);
    // Google's last good list stays. The companies with no key were never asked.
    const models = (await server.json<ModelsListResponse>("/api/models")).body.models;
    expect(models.filter((m) => m.providerId === "google")).toHaveLength(3);
    expect(server.services.settings.get().modelRefreshedAt).toBeNull();
  });

  test("models.json adds the person's own entries and skips broken ones", async () => {
    server = await startTestServer();
    const base = server.services.models.get("google:gemini-3.1-flash-image")!;
    const home = server.home;
    await server.close({ keepHome: true });
    writeFileSync(
      join(home, "models.json"),
      JSON.stringify({
        models: [
          { ...base, key: "google:my-tuned-image", modelId: "my-tuned-image", displayName: "My tuned model" },
          { key: "google:broken" },
        ],
      }),
    );
    server = await startTestServer({ home });
    const list = (await server.json<ModelsListResponse>("/api/models")).body.models;
    expect(list.find((m) => m.modelId === "my-tuned-image")).toMatchObject({
      source: "user",
      displayName: "My tuned model",
    });
    expect(list.find((m) => m.modelId === "broken")).toBeUndefined();
  });

  test("models.json can't change whether a model picks up after a restart", async () => {
    server = await startTestServer({ env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    const google = server.services.models.get("google:gemini-3.1-flash-image")!;
    const resumable = server.services.models.get("fake:resumable-image")!;
    expect(resumable).toMatchObject({ resumableSpeeds: ["standard"], idempotentSubmit: true });
    const home = server.home;
    const cases: [label: string, entries: unknown[]][] = [
      // An entry written only to change a price leaves both fields out.
      [
        "a price change",
        [{ ...google }, { ...resumable, resumableSpeeds: undefined, idempotentSubmit: undefined }],
      ],
      // A blocking Google call marked resumable would be lost to a crash instead of running again,
      // and a queue call marked blocking would be sent a second time instead of picked up.
      [
        "a changed claim",
        [
          { ...google, resumableSpeeds: ["standard"], idempotentSubmit: true },
          { ...resumable, resumableSpeeds: [] },
        ],
      ],
    ];
    for (const [label, entries] of cases) {
      await server.close({ keepHome: true });
      writeFileSync(join(home, "models.json"), JSON.stringify(entries));
      server = await startTestServer({ home, env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
      const models = server.services.models;
      expect(models.get("google:gemini-3.1-flash-image"), label).toMatchObject({ source: "user" });
      expect(models.get("google:gemini-3.1-flash-image")?.resumableSpeeds, label).toBeUndefined();
      expect(models.get("google:gemini-3.1-flash-image")?.idempotentSubmit, label).toBeUndefined();
      expect(models.get("fake:resumable-image"), label).toMatchObject({
        source: "user",
        resumableSpeeds: ["standard"],
        idempotentSubmit: true,
      });
    }
  });

  test("an unknown company is a 404", async () => {
    server = await startTestServer();
    const res = await server.json("/api/models/refresh", { method: "POST", body: { providerId: "nobody" } });
    expect(res.status).toBe(404);
    expect((await server.request("/api/models/google/not-a-model")).status).toBe(404);
  });
});

describe("key check", () => {
  test("a good key says how many models are ready; a rejected key says so", async () => {
    server = await startTestServer();
    const none = await server.json<{ ok: boolean; error: { code: string } }>(
      "/api/settings/keys/google/test",
      {
        method: "POST",
      },
    );
    expect(none.body).toMatchObject({ ok: false, error: { code: "auth_missing" } });

    await saveKey(server);
    const good = await server.json<{ ok: boolean; modelCount: number }>("/api/settings/keys/google/test", {
      method: "POST",
    });
    expect(good.body.ok).toBe(true);
    expect(good.body.modelCount).toBeGreaterThan(0);

    await saveKey(server, "this-one-is-invalid-0000");
    const bad = await server.json<{ ok: boolean; error: { code: string; message: string } }>(
      "/api/settings/keys/google/test",
      { method: "POST" },
    );
    expect(bad.body).toMatchObject({
      ok: false,
      error: { code: "auth_invalid", message: "This key was rejected." },
    });
    const status = await server.json<{ lastErrorCode: string }[]>("/api/settings/keys");
    expect(status.body[0]!.lastErrorCode).toBe("auth_invalid");
  });

  test("a key sent with the check is saved only when it works (§2.10 step 5)", async () => {
    server = await startTestServer();
    const check = (apiKey: string) =>
      server!.json<{ ok: boolean; error?: { code: string } }>("/api/settings/keys/google/test", {
        method: "POST",
        body: { apiKey },
      });
    const ready = async () =>
      (await server!.json<ModelsListResponse>("/api/models")).body.models.some((m) => m.ready);
    const configFile = join(server.home, "config.json");

    const bad = await check("AIza-this-key-is-invalid-000000");
    expect(bad.body).toMatchObject({ ok: false, error: { code: "auth_invalid" } });
    expect(existsSync(configFile)).toBe(false);
    expect(await ready()).toBe(false);
    const status =
      await server.json<{ present: boolean; lastErrorCode: string | null }[]>("/api/settings/keys");
    expect(status.body[0]).toMatchObject({ present: false, lastErrorCode: null });

    expect((await check(TEST_KEY)).body.ok).toBe(true);
    expect(readFileSync(configFile, "utf8")).toContain(TEST_KEY);
    expect(await ready()).toBe(true);

    // A failed replacement leaves the working key in place.
    expect((await check("AIza-this-key-is-invalid-111111")).body.ok).toBe(false);
    expect(readFileSync(configFile, "utf8")).toContain(TEST_KEY);
    expect(await ready()).toBe(true);
  });

  test("a saved key that has only ever been rejected doesn't count as ready", async () => {
    server = await startTestServer();
    await saveKey(server, "this-one-is-invalid-0000");
    await server.json("/api/settings/keys/google/test", { method: "POST" });
    const models = (await server.json<ModelsListResponse>("/api/models")).body.models;
    expect(models.every((m) => !m.ready)).toBe(true);
  });

  test("the first key that works picks the default model, and never overrides a chosen one", async () => {
    server = await startTestServer();
    const defaultModel = async () =>
      (await server!.json<{ defaultModel: string | null }>("/api/settings")).body.defaultModel;
    const check = () => server!.json("/api/settings/keys/google/test", { method: "POST" });

    await saveKey(server, "this-one-is-invalid-0000");
    await check();
    expect(await defaultModel()).toBeNull();

    await saveKey(server);
    await check();
    expect(await defaultModel()).toBe("google:gemini-3-pro-image");

    await server.json("/api/settings", {
      method: "PATCH",
      body: { defaultModel: "google:gemini-3.1-flash-image" },
    });
    await check();
    expect(await defaultModel()).toBe("google:gemini-3.1-flash-image");
  });
});

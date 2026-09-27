import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  assetDetailResponseSchema,
  assetsListResponseSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  jobSetAcceptedSchema,
  jobSetsListResponseSchema,
  keyStatusSchema,
  keysStatusResponseSchema,
  modelsListResponseSchema,
  providersListResponseSchema,
  settingsSchema,
  usageResponseSchema,
} from "@openfield/core";
import { getAsset } from "@openfield/db";
import sharp from "sharp";
import { completed, generateBody, startTestServer, TEST_KEY, type TestServer } from "./helpers";

// The M0 path end to end with fake providers: key, generate, image on disk, row, thumbnail.
// Every response is parsed with its core schema, as the web app does (§8.3.3).

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("generate to asset", () => {
  test("paste a key, generate, and the images land in the library with thumbnails", async () => {
    server = await startTestServer();
    const seen: string[] = [];
    const call = async (path: string, init: Omit<RequestInit, "body"> & { body?: unknown } = {}) => {
      const res = await server!.json(path, init);
      seen.push(JSON.stringify(res.body));
      return res;
    };

    healthResponseSchema.parse((await call("/api/health")).body);
    settingsSchema.parse((await call("/api/settings")).body);
    providersListResponseSchema.parse((await call("/api/providers")).body);

    const before = modelsListResponseSchema.parse((await call("/api/models")).body);
    const names = (company: string) =>
      before.models.filter((m) => m.providerId === company).map((m) => m.displayName);
    expect(names("google")).toEqual(["Nano Banana Pro", "Nano Banana 2", "Nano Banana 2 Lite"]);
    expect(names("openai")).toEqual(["GPT Image 2.5 Sunburst", "GPT Image 2.5 Flare", "GPT Image 2"]);
    expect(before.models.every((m) => !m.ready)).toBe(true);

    const saved = keyStatusSchema.parse(
      (await call("/api/settings/keys/google", { method: "PUT", body: { apiKey: TEST_KEY } })).body,
    );
    expect(saved).toMatchObject({ present: true, source: "file", hint: TEST_KEY.slice(-4) });
    keysStatusResponseSchema.parse((await call("/api/settings/keys")).body);
    const check = await call("/api/settings/keys/google/test", { method: "POST" });
    expect(check.body).toMatchObject({ ok: true });

    const after = modelsListResponseSchema.parse((await call("/api/models")).body);
    // A Google key readies Google's models only. The other companies wait for their own key.
    expect(after.models.filter((m) => m.providerId === "google").every((m) => m.ready)).toBe(true);
    expect(after.models.filter((m) => m.providerId !== "google").some((m) => m.ready)).toBe(false);

    const body = generateBody({ batch: 2 });
    const accepted = await call("/api/generate", { method: "POST", body });
    expect(accepted.status).toBe(202);
    const run = jobSetAcceptedSchema.parse(accepted.body);
    // Placeholders know their shape before any call: 3:4 at the model's default 1K.
    expect(run.jobs.map((j) => [j.width, j.height])).toEqual([
      [768, 1024],
      [768, 1024],
    ]);
    expect(run.jobSet).toMatchObject({ status: "pending", model: body.model, batchSize: 2 });
    expect(run.jobSet.costEstimateUsd).toBeGreaterThan(0);

    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    await server.services.thumbs.idle();

    const sets = jobSetsListResponseSchema.parse((await call("/api/job-sets?status=all")).body);
    expect(sets.items[0]!.jobs.every((j) => j.status === "succeeded" && j.assetId)).toBe(true);

    const list = assetsListResponseSchema.parse((await call("/api/assets")).body);
    expect(list.items).toHaveLength(2);
    expect(list.nextCursor).toBeNull();
    for (const item of list.items) {
      const row = getAsset(server.services.db, item.id)!;
      expect(existsSync(join(server.home, row.path))).toBe(true);
      expect(item.thumbUrl).toBe(`/files/thumb/${item.id}?h=456`);

      const detail = assetDetailResponseSchema.parse((await call(`/api/assets/${item.id}`)).body);
      expect(detail.jobSet?.id).toBe(run.jobSet.id);
      expect(detail.asset.params).toMatchObject({ prompt: body.prompt, model: body.model });

      const original = await server.request(item.fileUrl);
      expect(original.headers.get("content-type")).toBe("image/png");
      const thumb = await server.request(item.thumbUrl);
      expect(thumb.headers.get("content-type")).toBe("image/webp");
      const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
      expect(meta.format).toBe("webp");
    }

    const usage = usageResponseSchema.parse((await call("/api/usage?groupBy=model")).body);
    expect(usage.rows[0]).toMatchObject({
      providerId: "google",
      modelId: "gemini-3.1-flash-image",
      images: 2,
    });
    expect(usage.totalUsd).toBeGreaterThan(0);

    for (const text of seen) expect(text).not.toContain(TEST_KEY);
  });

  test("Recreate replays the frozen request as a new run", async () => {
    server = await startTestServer();
    await server.json("/api/settings/keys/google", { method: "PUT", body: { apiKey: TEST_KEY } });
    const first = jobSetAcceptedSchema.parse(
      (
        await server.json("/api/generate", {
          method: "POST",
          body: generateBody({ prompt: "a quiet harbour" }),
        })
      ).body,
    );
    await completed(server, first.jobSet.id);
    const res = await server.json(`/api/job-sets/${first.jobSet.id}/recreate`, { method: "POST" });
    expect(res.status).toBe(202);
    const again = jobSetAcceptedSchema.parse(res.body);
    expect(again.jobSet.id).not.toBe(first.jobSet.id);
    expect(again.jobSet).toMatchObject({
      source: "recreate",
      prompt: "a quiet harbour",
      model: first.jobSet.model,
    });
    await completed(server, again.jobSet.id);
  });
});

describe("references and lineage", () => {
  test("an image used as a reference is recorded and shows in the detail view", async () => {
    server = await startTestServer();
    await server.json("/api/settings/keys/google", { method: "PUT", body: { apiKey: TEST_KEY } });
    const first = jobSetAcceptedSchema.parse(
      (await server.json("/api/generate", { method: "POST", body: generateBody() })).body,
    );
    await completed(server, first.jobSet.id);
    const reference = assetsListResponseSchema.parse((await server.json("/api/assets")).body).items[0]!;

    const body = generateBody({ references: [{ assetId: reference.id, role: "style" }] });
    const second = jobSetAcceptedSchema.parse(
      (await server.json("/api/generate", { method: "POST", body })).body,
    );
    expect((await completed(server, second.jobSet.id)).status).toBe("succeeded");

    const made = assetsListResponseSchema.parse((await server.json("/api/assets")).body).items[0]!;
    const detail = assetDetailResponseSchema.parse((await server.json(`/api/assets/${made.id}`)).body);
    expect(detail.references.map((r) => r.id)).toEqual([reference.id]);
    expect(detail.asset.params).toMatchObject({ references: [{ assetId: reference.id, role: "style" }] });

    // The detail preview: long edge 1440, never larger than the original.
    const preview = await server.request(`/files/thumb/${made.id}?p=1440`);
    expect(preview.headers.get("etag")).toBe(`"${made.sha256}@p1440"`);
    const meta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(Math.max(made.width, made.height));
  });
});

describe("request validation", () => {
  test("a bad body is a 400 bad_request naming the field", async () => {
    server = await startTestServer();
    const bad = await server.json("/api/generate", { method: "POST", body: generateBody({ batch: 9 }) });
    expect(bad.status).toBe(400);
    const envelope = errorEnvelopeSchema.parse(bad.body);
    expect(envelope.error).toMatchObject({ code: "bad_request", field: "batch", retryable: false });

    const editOp = await server.json("/api/generate", { method: "POST", body: generateBody({ op: "edit" }) });
    expect(errorEnvelopeSchema.parse(editOp.body).error.field).toBe("op");

    const malformed = await server.request("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await malformed.json()).error.code).toBe("bad_request");
  });

  test("an unknown model or an impossible setting is refused before anything runs", async () => {
    server = await startTestServer();
    const unknown = await server.json("/api/generate", {
      method: "POST",
      body: generateBody({ model: "google:nope" }),
    });
    expect(unknown.status).toBe(400);
    expect(errorEnvelopeSchema.parse(unknown.body).error).toMatchObject({
      code: "bad_request",
      field: "model",
    });

    const empty = await server.json("/api/generate", {
      method: "POST",
      body: generateBody({ prompt: "  " }),
    });
    expect(empty.status).toBe(400);
    expect(errorEnvelopeSchema.parse(empty.body).error).toMatchObject({
      code: "invalid_request",
      field: "prompt",
    });
  });

  test("unknown ids are a 404, bad cursors a 400", async () => {
    server = await startTestServer();
    expect((await server.request("/api/assets/01K6BQ8A1C4D7E9F0000000000")).status).toBe(404);
    expect(
      (await server.request("/api/job-sets/01K6BQ8A1C4D7E9F0000000000/cancel", { method: "POST" })).status,
    ).toBe(404);
    expect((await server.request("/files/asset/01K6BQ8A1C4D7E9F0000000000")).status).toBe(404);
    expect((await server.request("/api/assets?cursor=bogus")).status).toBe(400);
    expect((await server.request("/api/nope")).status).toBe(404);
  });
});

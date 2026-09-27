import { describe, expect, test } from "bun:test";
import { type GenerateRequest, jobHandleSchema, modelManifestSchema, newId } from "@openfield/core";
import { resumesAfterRestart } from "../src/manifest/speed";
import { normalize } from "../src/normalize";
import { builtinProviders, fakeOnlyProviders, providersFor } from "../src/registry";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch, type FakeFetch } from "../src/testing/fake-fetch";
import { createResumableFakeProvider, RESUMABLE_TEST_MODEL } from "../src/testing/resumable";
import { type JobUpdate, notFoundError, ProviderError } from "../src/types";

// The fake-mode test company (§6.12): a create call that answers at once with an id, and status
// reads by id that walk queued, running, then the image, surviving a restart. Plus the other half
// of the contract: Google stays blocking, and only its Batch runs resume.

const provider = createResumableFakeProvider();
const credentials = { apiKey: "fake-key-5b1d" };
const T0 = Date.parse("2026-09-24T12:00:00.000Z");

/** One "process": its own fake API store, asset sink and context, on a clock the test moves. */
function processAt(clock: { now: number }, opts: { scenario?: "resume_slow" | "resume_gone" } = {}) {
  const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32, now: () => clock.now, ...opts });
  const ctx = createTestContext({ fetch, credentials, now: () => clock.now });
  return { fetch, ctx };
}

/** One normalized call to the test model. */
async function planCall(prompt = "A lighthouse at dusk") {
  const req: GenerateRequest = {
    idempotencyKey: newId(),
    model: RESUMABLE_TEST_MODEL.key,
    op: "generate",
    prompt,
    size: { kind: "aspect", ratio: "16:9" },
    batch: 1,
    source: "api",
  };
  const normalized = await normalize(RESUMABLE_TEST_MODEL, req, { jobSetId: newId() });
  if (normalized.error) throw normalized.error;
  return normalized.calls[0]!;
}

const creates = (fetch: FakeFetch) => fetch.calls.filter((c) => c.method === "POST").length;

describe("the resumable test model", () => {
  test("its manifest parses and declares Standard resumable", () => {
    expect(modelManifestSchema.safeParse(RESUMABLE_TEST_MODEL).error?.issues ?? []).toEqual([]);
    expect(RESUMABLE_TEST_MODEL.resumableSpeeds).toEqual(["standard"]);
    expect(resumesAfterRestart(RESUMABLE_TEST_MODEL, "standard")).toBe(true);
    expect(provider.meta.networkHosts).toEqual(["fake.openfield.invalid"]);
  });

  test("create answers at once with an id; reads walk queued, running, then the image", async () => {
    const clock = { now: T0 };
    const { fetch, ctx } = processAt(clock);
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const handle = await model.submit(await planCall(), ctx);
    expect(handle.providerRef).toMatch(/^img_/);
    expect(ctx.assets.written).toHaveLength(0);

    expect((await model.poll(handle, ctx)).state).toBe("queued");
    clock.now = T0 + 2_500;
    const running = await model.poll(handle, ctx);
    expect([running.state, running.progress]).toEqual(["running", 50]);
    clock.now = T0 + 4_000;
    const done = await model.poll(handle, ctx);
    expect(done.state).toBe("succeeded");
    expect(done.result?.images[0]).toMatchObject({ index: 0, width: 32, height: 18, mimeType: "image/png" });
    expect(done.result?.speedUsed).toBe("standard");
    expect(creates(fetch)).toBe(1);
  });

  test("a restarted process finishes the call from the stored handle alone", async () => {
    const clock = { now: T0 };
    const before = processAt(clock);
    const handle = await provider.model(RESUMABLE_TEST_MODEL.key).submit(await planCall(), before.ctx);
    const stored = jobHandleSchema.parse(JSON.parse(JSON.stringify(handle)));

    clock.now = T0 + 30_000;
    const after = processAt(clock);
    const restarted = provider.model(RESUMABLE_TEST_MODEL.key);
    const done = await restarted.poll(stored, after.ctx);
    expect(done.state).toBe("succeeded");
    expect(after.ctx.assets.written).toHaveLength(1);
    // Polling again returns the same image instead of writing a second copy.
    expect(await restarted.poll(stored, after.ctx)).toEqual(done);
    expect(after.ctx.assets.written).toHaveLength(1);
    expect([creates(before.fetch), creates(after.fetch)]).toEqual([1, 0]);
  });

  test("#fake:resume_slow runs for about a minute", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const handle = await model.submit(await planCall("A slow one #fake:resume_slow"), ctx);
    clock.now = T0 + 45_000;
    expect((await model.poll(handle, ctx)).state).toBe("running");
    clock.now = T0 + 60_000;
    expect((await model.poll(handle, ctx)).state).toBe("succeeded");
  });

  test("resumeSlowMs shortens #fake:resume_slow, and a process started without it agrees", async () => {
    const clock = { now: T0 };
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32, now: () => clock.now, resumeSlowMs: 8_000 });
    const ctx = createTestContext({ fetch, credentials, now: () => clock.now });
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const handle = await model.submit(await planCall("A quicker slow one #fake:resume_slow"), ctx);
    clock.now = T0 + 7_000;
    expect((await model.poll(handle, ctx)).state).toBe("running");
    // The end is in the id, so a restart with the default minute still finishes it on time.
    clock.now = T0 + 8_000;
    expect((await model.poll(handle, processAt(clock).ctx)).state).toBe("succeeded");
  });

  test("#fake:resume_gone forgets the call after 10 seconds: not found, never retried", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock, { scenario: "resume_gone" });
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const handle = await model.submit(await planCall(), ctx);
    clock.now = T0 + 5_000;
    expect((await model.poll(handle, ctx)).state).toBe("running");
    clock.now = T0 + 10_000;
    const err = await model.poll(handle, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const gone = err as ProviderError;
    expect([gone.code, gone.notFound, gone.retryable, gone.httpStatus]).toEqual([
      "provider_error",
      true,
      false,
      404,
    ]);
    expect(gone.userMessage).toBe("Test company no longer has this image.");
    expect(gone.toJSON()).toMatchObject({ code: "provider_error", notFound: true });
  });

  test("cancel stops it at the company", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const handle = await model.submit(await planCall(), ctx);
    clock.now = T0 + 1_500;
    await model.cancel!(handle, ctx);
    clock.now = T0 + 10_000;
    const update: JobUpdate = await model.poll(handle, ctx);
    expect([update.state, update.error?.code]).toEqual(["canceled", "canceled"]);
    expect(ctx.assets.written).toHaveLength(0);
    // A call that's gone has nothing to stop.
    await expect(model.cancel!({ ...handle, providerRef: "img_nope" }, ctx)).resolves.toBeUndefined();
  });

  test("a create sent again with the same key gets the first call back", async () => {
    const clock = { now: T0 };
    const { fetch, ctx } = processAt(clock);
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const req = await planCall();
    const first = await model.submit(req, ctx);
    const again = await model.submit(req, ctx);
    expect(again.providerRef).toBe(first.providerRef);
    expect(creates(fetch)).toBe(2);
  });

  test("keys: missing is auth_missing, rejected is auth_invalid", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const model = provider.model(RESUMABLE_TEST_MODEL.key);
    const none = createTestContext({ fetch });
    expect(((await model.submit(await planCall(), none).catch((e) => e)) as ProviderError).code).toBe(
      "auth_missing",
    );
    const bad = createTestContext({ fetch, credentials: { apiKey: "an-invalid-key" } });
    expect(((await provider.verifyCredentials(bad).catch((e) => e)) as ProviderError).code).toBe(
      "auth_invalid",
    );
    expect(await provider.verifyCredentials(createTestContext({ fetch, credentials }))).toEqual({
      ok: true,
      modelCount: 1,
    });
  });

  test("only runs at Standard", async () => {
    const { ctx } = processAt({ now: T0 });
    ctx.speed = "flex";
    const err = (await provider
      .model(RESUMABLE_TEST_MODEL.key)
      .submit(await planCall(), ctx)
      .catch((e) => e)) as ProviderError;
    expect([err.code, err.field]).toEqual(["unsupported_param", "speed"]);
  });
});

describe("registration", () => {
  test("the test company exists only in fake mode", () => {
    const builtin = builtinProviders.map((p) => p.meta.id);
    expect(builtin).not.toContain("fake");
    expect(fakeOnlyProviders.map((p) => p.meta.id)).toEqual(["fake"]);
    expect(providersFor({ fake: false }).map((p) => p.meta.id)).toEqual(builtin);
    expect(providersFor({ fake: true }).map((p) => p.meta.id)).toEqual([...builtin, "fake"]);
  });

  test("the default fake fetch answers for it", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const res = await fetch("https://fake.openfield.invalid/v1/models", {
      headers: { authorization: "Bearer k" },
    });
    expect(await res.json()).toEqual({ data: [{ id: "resumable-image" }] });
  });
});

describe("Google stays blocking; only Batch resumes", () => {
  const google = builtinProviders[0]!;

  test("no Google model lists a resumable speed, and Batch always resumes", () => {
    for (const manifest of google.catalog()) {
      expect(manifest.resumableSpeeds).toBeUndefined();
      for (const speed of ["standard", "flex", "priority"] as const) {
        expect(resumesAfterRestart(manifest, speed)).toBe(false);
      }
      expect(resumesAfterRestart(manifest, "batch")).toBe(true);
    }
  });

  test("#fake:slow holds a blocking call open, and a stop mid-call cancels it", async () => {
    const manifest = google.catalog().find((m) => m.modelId === "gemini-3.1-flash-lite-image")!;
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32, slowMs: 150 });
    const req: GenerateRequest = {
      idempotencyKey: newId(),
      model: manifest.key,
      op: "generate",
      prompt: "A slow teapot #fake:slow",
      size: { kind: "aspect", ratio: "1:1" },
      batch: 1,
      source: "api",
    };
    const normalized = await normalize(manifest, req, { jobSetId: newId() });
    const model = google.model(manifest.key);

    const ctx = createTestContext({ fetch, credentials });
    const started = performance.now();
    const handle = await model.submit(normalized.calls[0]!, ctx);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    // The image came back with the answer: there is no id to pick up after a restart.
    expect(ctx.assets.written).toHaveLength(1);
    expect((await model.poll(handle, ctx)).state).toBe("succeeded");

    const stop = new AbortController();
    const cut = createTestContext({ fetch, credentials, signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    const err = (await model.submit(normalized.calls[0]!, cut).catch((e) => e)) as ProviderError;
    expect(err.code).toBe("canceled");
    expect(cut.assets.written).toHaveLength(0);
  });
});

describe("notFoundError", () => {
  test("names the company in our copy and is never retried", () => {
    const err = notFoundError("OpenAI");
    expect([err.code, err.retryable, err.notFound]).toEqual(["provider_error", false, true]);
    expect(err.userMessage).toBe("OpenAI no longer has this image.");
  });
});

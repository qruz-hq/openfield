import { describe, expect, test } from "bun:test";
import { type GenerateRequest, type JobHandle, type NormalizedRequest, newId } from "@openfield/core";
import { createHiggsfieldProvider } from "../src/higgsfield";
import { CONCURRENCY_WAIT_MS, mapError } from "../src/higgsfield/errors";
import { toHiggsfieldBody } from "../src/higgsfield/map-request";
import { HIGGSFIELD_MODELS, specFor } from "../src/higgsfield/models";
import { normalize } from "../src/normalize";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import type { ImageModel, JobUpdate } from "../src/types";

// What the conformance suite can't reach for a queue adapter: an image host that isn't declared
// only shows up on a status read, a cancel after the start, and each workflow's own field rules.

const provider = createHiggsfieldProvider();
const credentials = { apiKey: "hf-key-id:hf-key-secret-9c2e" };
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

function processAt(clock: { now: number }) {
  const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32, now: () => clock.now });
  const ctx = createTestContext({ fetch, credentials, now: () => clock.now });
  return { fetch, ctx };
}

const manifest = (modelId: string) => HIGGSFIELD_MODELS.find((m) => m.modelId === modelId)!;

async function call(modelId: string, overrides: Partial<GenerateRequest> = {}): Promise<NormalizedRequest> {
  const m = manifest(modelId);
  const req: GenerateRequest = {
    idempotencyKey: newId(),
    model: m.key,
    op: "generate",
    prompt: "A lighthouse at dusk",
    size: {
      kind: "aspect",
      ratio: m.capabilities.size.mode === "aspect" ? m.capabilities.size.default : "1:1",
    },
    batch: 1,
    source: "api",
    ...overrides,
  };
  const normalized = await normalize(m, req, { jobSetId: newId(), randomSeed: () => 7 });
  if (normalized.error) throw normalized.error;
  return normalized.calls[0]!;
}

async function finish(
  model: ImageModel,
  handle: JobHandle,
  ctx: ReturnType<typeof processAt>["ctx"],
  clock: { now: number },
) {
  for (let i = 0; i < 100; i++) {
    const update: JobUpdate = await model.poll(handle, ctx);
    if (["succeeded", "failed", "canceled"].includes(update.state)) return update;
    clock.now += 2_000;
  }
  throw new Error("never finished");
}

describe("the Higgsfield adapter", () => {
  test("model ids are slugs, so the model routes keep working", () => {
    for (const m of HIGGSFIELD_MODELS) expect(m.modelId).not.toContain("/");
    expect(specFor("soul-v2")?.path).toBe("higgsfield-ai/soul/v2/standard");
  });

  test("the key goes in the Authorization header as Higgsfield gives it", async () => {
    const seen: string[] = [];
    const fake = createFakeFetch({ delayMs: 0 });
    const ctx = createTestContext({
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return fake(input, init);
      },
      credentials,
    });
    await provider.verifyCredentials(ctx);
    expect(seen).toEqual([`Key ${credentials.apiKey}`]);
  });

  test("an image from an undeclared host is refused, and the log names the host", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("soul-v2").key);
    const handle = await model.submit(await call("soul-v2", { prompt: "A kite #fake:foreign_asset" }), ctx);
    const err = await finish(model, handle, ctx, clock).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_error" });
    expect((err as Error).message).toContain("files.unknown-host.example");
    expect(ctx.assets.written).toHaveLength(0);
  });

  test("a queued request cancels; one that has started runs on, without an error", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("soul").key);

    const queued = await model.submit(await call("soul"), ctx);
    await model.cancel!(queued, ctx);
    expect((await model.poll(queued, ctx)).state).toBe("canceled");

    const started = await model.submit(await call("soul"), ctx);
    clock.now += 2_000;
    expect((await model.poll(started, ctx)).state).toBe("running");
    await model.cancel!(started, ctx);
    expect((await finish(model, started, ctx, clock)).state).toBe("succeeded");
  });

  test("a flagged result is refused and never retried", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("z-image-turbo").key);
    const handle = await model.submit(await call("z-image-turbo", { prompt: "A kite #fake:refused" }), ctx);
    const update = await finish(model, handle, ctx, clock);
    expect(update.state).toBe("failed");
    expect(update.error).toMatchObject({ code: "content_refused", retryable: false });
  });

  test("the image is saved with where it came from, never a signed query string", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("grok-imagine-image-2.0").key);
    const handle = await model.submit(await call("grok-imagine-image-2.0"), ctx);
    const done = await finish(model, handle, ctx, clock);
    expect(done.result?.images).toHaveLength(1);
    expect(JSON.stringify(done.result?.providerRaw)).not.toContain("?");
  });

  test("estimateRemote asks Higgsfield and scales by the image count", async () => {
    const { ctx } = processAt({ now: T0 });
    const model = provider.model(manifest("soul-v2").key);
    const cost = await model.estimateRemote!({ ...(await call("soul-v2")), batch: 2 }, ctx);
    expect(cost).toMatchObject({ currency: "USD", min: 0.188, max: 0.188, confidence: "estimated" });
  });
});

describe("request bodies follow each workflow", () => {
  test("Qwen's thinking goes off with its prompt rewriting", async () => {
    const qwen = specFor("qwen-image-3")!;
    expect(toHiggsfieldBody(qwen, await call("qwen-image-3", { enhancePrompt: false }))).toMatchObject({
      prompt_extend: false,
      enable_thinking: false,
    });
    const on = await call("qwen-image-3", { enhancePrompt: true, providerOptions: { thinking: false } });
    expect(toHiggsfieldBody(qwen, on)).toMatchObject({ prompt_extend: true, enable_thinking: false });
    // Left alone, the workflow's defaults stand.
    const plain = toHiggsfieldBody(qwen, await call("qwen-image-3"));
    expect("prompt_extend" in plain || "enable_thinking" in plain).toBe(false);
  });

  test("Recraft spells JPEG jpg; SOUL's style and character go by their wire names", async () => {
    const recraft = await call("recraft-v4.1", { output: { format: "jpeg" } });
    expect(toHiggsfieldBody(specFor("recraft-v4.1")!, recraft).output_format).toBe("jpg");

    const soul = await call("soul", {
      providerOptions: {
        styleId: "464ea177-8d40-4940-8d9d-b438bab269c7",
        styleStrength: 0.5,
        characterId: "1cb4b936-77bf-4f9a-9039-f3d349a4cdbe",
      },
    });
    expect(toHiggsfieldBody(specFor("soul")!, soul)).toMatchObject({
      style_id: "464ea177-8d40-4940-8d9d-b438bab269c7",
      style_strength: 0.5,
      custom_reference_id: "1cb4b936-77bf-4f9a-9039-f3d349a4cdbe",
    });
  });

  test("Ideogram's quality chip is its rendering speed, and it has no resolution", async () => {
    const body = toHiggsfieldBody(specFor("ideogram-4.0")!, await call("ideogram-4.0", { quality: "TURBO" }));
    expect(body).toMatchObject({ rendering_speed: "TURBO" });
    expect("resolution" in body || "quality" in body).toBe(false);
  });
});

describe("errors", () => {
  const res = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("concurrency is a short wait, not a bad request", async () => {
    const err = await mapError(
      res(400, { detail: "Maximum number of concurrent requests (2) has been reached" }),
    );
    expect(err).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: CONCURRENCY_WAIT_MS });
    expect((await mapError(res(400, { detail: "Invalid input image" }))).code).toBe("invalid_request");
  });

  test("403 is out of credits; 423 is a model that comes back on its own", async () => {
    expect((await mapError(res(403, { detail: "Not enough credits" }))).code).toBe("billing_required");
    expect((await mapError(res(423, { detail: "Model is temporarily blocked" }))).code).toBe(
      "provider_unavailable",
    );
  });

  test("a 422 names the control it came from", async () => {
    const err = await mapError(
      res(422, { detail: [{ loc: ["body", "aspect_ratio"], msg: "Input should be 1:1", type: "enum" }] }),
    );
    expect(err).toMatchObject({ code: "invalid_request", field: "aspect" });
    expect(err.message).toContain("body.aspect_ratio");
  });
});

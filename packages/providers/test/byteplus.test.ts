import { describe, expect, test } from "bun:test";
import {
  type GenerateRequest,
  type JobHandle,
  type ModelManifest,
  modelManifestSchema,
  type NormalizedRequest,
  newId,
} from "@openfield/core";
import { createByteplusProvider } from "../src/byteplus";
import badKey from "../src/byteplus/__fixtures__/bad-key.json";
import inputFlagged from "../src/byteplus/__fixtures__/input-flagged.json";
import invalid from "../src/byteplus/__fixtures__/invalid.json";
import notActivated from "../src/byteplus/__fixtures__/not-activated.json";
import overdue from "../src/byteplus/__fixtures__/overdue.json";
import overloaded from "../src/byteplus/__fixtures__/overloaded.json";
import rateLimited from "../src/byteplus/__fixtures__/rate-limited.json";
import serverError from "../src/byteplus/__fixtures__/server-error.json";
import serviceNotOpen from "../src/byteplus/__fixtures__/service-not-open.json";
import spendLimit from "../src/byteplus/__fixtures__/spend-limit.json";
import { errorFor, mapError, RATE_LIMIT_WAIT_MS } from "../src/byteplus/errors";
import { toSeedanceBody } from "../src/byteplus/map-request";
import { pollAfterMs } from "../src/byteplus/map-response";
import { BYTEPLUS_MODELS, specFor } from "../src/byteplus/models";
import { estimate } from "../src/manifest/estimate";
import { videoTokens } from "../src/manifest/video";
import { normalize } from "../src/normalize";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { gradientPng } from "../src/testing/png";
import type { RecordedExchange } from "../src/testing/types";
import type { ImageModel, JobUpdate } from "../src/types";

// What the conformance suite doesn't pin down for the video adapter: the exact payloads per mode,
// the price math against BytePlus's own examples, each error code, and the task lifecycle.

const provider = createByteplusProvider();
const credentials = { apiKey: "ark-key-3f9a1c7e" };
const T0 = Date.parse("2026-09-29T12:00:00.000Z");

const manifest = (modelId: string): ModelManifest => BYTEPLUS_MODELS.find((m) => m.modelId === modelId)!;

function processAt(clock: { now: number }) {
  const fetch = createFakeFetch({ delayMs: 0, now: () => clock.now });
  const ctx = createTestContext({ fetch, credentials, now: () => clock.now });
  return { fetch, ctx };
}

function requestFor(modelId: string, overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    idempotencyKey: newId(),
    model: manifest(modelId).key,
    op: "generate",
    prompt: "The kitten is yawning at the camera.",
    size: { kind: "aspect", ratio: "16:9" },
    batch: 1,
    source: "api",
    ...overrides,
  };
}

async function call(modelId: string, overrides: Partial<GenerateRequest> = {}): Promise<NormalizedRequest> {
  const normalized = await normalize(manifest(modelId), requestFor(modelId, overrides), {
    jobSetId: newId(),
    randomSeed: () => 11,
  });
  if (normalized.error) throw normalized.error;
  return normalized.calls[0]!;
}

async function finish(
  model: ImageModel,
  handle: JobHandle,
  ctx: ReturnType<typeof processAt>["ctx"],
  clock: { now: number },
) {
  for (let i = 0; i < 200; i++) {
    const update: JobUpdate = await model.poll(handle, ctx);
    if (["succeeded", "failed", "canceled"].includes(update.state)) return update;
    clock.now += 2_000;
  }
  throw new Error("never finished");
}

const response = (exchange: RecordedExchange) =>
  new Response(JSON.stringify(exchange.response.body), {
    status: exchange.response.status,
    headers: exchange.response.headers ?? {},
  });

describe("the BytePlus catalog", () => {
  test("seven Seedance models, every one a video model that parses strictly", () => {
    expect(BYTEPLUS_MODELS.map((m) => m.displayName)).toEqual([
      "Seedance 2.5",
      "Seedance 2.0",
      "Seedance 2.0 Fast",
      "Seedance 2.0 Mini",
      "Seedance 1.5 Pro",
      "Seedance 1.0 Pro",
      "Seedance 1.0 Pro Fast",
    ]);
    for (const m of BYTEPLUS_MODELS) {
      expect(modelManifestSchema.safeParse(m).error?.issues ?? []).toEqual([]);
      expect(m.modality).toBe("video");
      expect(m.capabilities.batch.max).toBe(1);
      expect(m.description!.length).toBeLessThanOrEqual(90);
      expect(m.description).not.toContain("—");
    }
  });

  test("capabilities follow the reference: sound, end frames, seeds and resolutions", () => {
    const caps = (id: string) => manifest(id).capabilities;
    expect(caps("seedance-1-0-pro-fast-251015").video?.frames.end).toBe(false);
    expect(caps("seedance-1-0-pro-250528").video?.frames.end).toBe(true);
    for (const id of ["seedance-1-0-pro-250528", "seedance-1-0-pro-fast-251015"])
      expect(caps(id).video?.audio.supported).toBe(false);
    for (const id of [
      "dreamina-seedance-2-5-260628",
      "dreamina-seedance-2-0-260128",
      "seedance-1-5-pro-251215",
    ])
      expect(caps(id).video?.audio).toEqual({ supported: true, default: true });
    expect(caps("dreamina-seedance-2-0-260128").video?.resolutions).toContain("4k");
    expect(caps("dreamina-seedance-2-0-fast-260128").video?.resolutions).toEqual(["480p", "720p"]);
    expect(caps("dreamina-seedance-2-5-260628").video?.durations.at(-1)).toBe(30);
    expect(caps("seedance-1-0-pro-250528").video?.durations[0]).toBe(2);
    expect(caps("dreamina-seedance-2-0-260128").seed.supported).toBe(false);
    expect(caps("seedance-1-5-pro-251215").seed.supported).toBe(true);
    expect(caps("seedance-1-5-pro-251215").video?.cameraFixed).toBe(true);
  });
});

describe("request mapping", () => {
  test("text to video", async () => {
    const req = await call("seedance-1-5-pro-251215", { video: { seconds: 5, resolution: "720p" } });
    expect(toSeedanceBody(specFor("seedance-1-5-pro-251215")!, req, {})).toEqual({
      model: "seedance-1-5-pro-251215",
      content: [{ type: "text", text: "The kitten is yawning at the camera." }],
      resolution: "720p",
      ratio: "16:9",
      duration: 5,
      seed: 11,
      camera_fixed: false,
      generate_audio: true,
      watermark: false,
      return_last_frame: true,
      execution_expires_after: 7200,
    });
  });

  test("a start frame, and a start and end frame, go in that order with their roles", async () => {
    const start = newId();
    const end = newId();
    const req = await call("seedance-1-0-pro-250528", {
      video: { startFrame: { assetId: start }, endFrame: { assetId: end } },
    });
    const body = toSeedanceBody(specFor("seedance-1-0-pro-250528")!, req, {
      start: "data:image/png;base64,AAAA",
      end: "data:image/jpeg;base64,BBBB",
    });
    expect(body.content).toEqual([
      { type: "text", text: "The kitten is yawning at the camera." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" }, role: "last_frame" },
    ]);
    expect(body).not.toHaveProperty("generate_audio");
    expect(body.resolution).toBe("1080p");

    const first = await call("seedance-1-0-pro-fast-251015", { video: { startFrame: { assetId: start } } });
    expect(
      toSeedanceBody(specFor("seedance-1-0-pro-fast-251015")!, first, { start: "data:image/png;base64,AAAA" })
        .content,
    ).toHaveLength(2);
  });

  test("Seedance 2.5 takes the start frame's shape: adaptive, whatever ratio was picked", async () => {
    const req = await call("dreamina-seedance-2-5-260628", {
      size: { kind: "aspect", ratio: "9:16" },
      video: { startFrame: { assetId: newId() } },
    });
    expect(req.size).toEqual({ aspect: "auto" });
    const body = toSeedanceBody(specFor("dreamina-seedance-2-5-260628")!, req, {
      start: "data:image/png;base64,AAAA",
    });
    expect(body.ratio).toBe("adaptive");
    // Without a frame, the ratio picked stands.
    const plain = await call("dreamina-seedance-2-5-260628", { size: { kind: "aspect", ratio: "9:16" } });
    expect(toSeedanceBody(specFor("dreamina-seedance-2-5-260628")!, plain, {}).ratio).toBe("9:16");
  });

  test("an end frame on a model without one, and without a start frame", async () => {
    const warned = await normalize(
      manifest("seedance-1-0-pro-fast-251015"),
      requestFor("seedance-1-0-pro-fast-251015", {
        video: { startFrame: { assetId: newId() }, endFrame: { assetId: newId() } },
      }),
      { jobSetId: newId() },
    );
    expect(warned.error).toBeUndefined();
    expect(warned.request.video?.endFrame).toBeUndefined();
    expect(warned.diagnostics.map((d) => d.field)).toContain("video.endFrame");

    const refused = await normalize(
      manifest("seedance-1-0-pro-250528"),
      requestFor("seedance-1-0-pro-250528", { video: { endFrame: { assetId: newId() } } }),
      { jobSetId: newId() },
    );
    expect(refused.error?.field).toBe("video.endFrame");
  });

  test("durations snap to the nearest the model makes; sound and a still camera only where they exist", async () => {
    const snapped = await normalize(
      manifest("dreamina-seedance-2-0-260128"),
      requestFor("dreamina-seedance-2-0-260128", { video: { seconds: 40, cameraFixed: true } }),
      { jobSetId: newId() },
    );
    expect(snapped.request.video?.seconds).toBe(15);
    expect(snapped.request.video?.cameraFixed).toBeUndefined();
    expect(snapped.diagnostics.map((d) => d.field).sort()).toEqual(["video.cameraFixed", "video.seconds"]);

    const silent = await normalize(
      manifest("seedance-1-0-pro-250528"),
      requestFor("seedance-1-0-pro-250528", { video: { audio: true } }),
      { jobSetId: newId() },
    );
    expect(silent.request.video?.audio).toBeUndefined();
    expect(silent.diagnostics.map((d) => d.field)).toEqual(["video.audio"]);
  });

  test("1.0 needs a ratio of its own for text to video; auto only with a start frame", async () => {
    const text = await normalize(
      manifest("seedance-1-0-pro-250528"),
      requestFor("seedance-1-0-pro-250528", { size: { kind: "auto" } }),
      { jobSetId: newId() },
    );
    expect(text.request.size).toEqual({ aspect: "16:9" });
    expect(text.diagnostics.map((d) => d.field)).toEqual(["size"]);

    const framed = await normalize(
      manifest("seedance-1-0-pro-250528"),
      requestFor("seedance-1-0-pro-250528", {
        size: { kind: "auto" },
        video: { startFrame: { assetId: newId() } },
      }),
      { jobSetId: newId() },
    );
    expect(framed.request.size).toEqual({ aspect: "auto" });
    expect(framed.diagnostics).toEqual([]);
  });

  test("a start frame alone is enough: no prompt needed", async () => {
    const req = await call("dreamina-seedance-2-0-260128", {
      prompt: "",
      video: { startFrame: { assetId: newId() } },
    });
    expect(
      toSeedanceBody(specFor("dreamina-seedance-2-0-260128")!, req, { start: "data:image/png;base64,AAAA" })
        .content,
    ).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" }, role: "first_frame" }]);
  });

  test("random seeds fold into BytePlus's range instead of piling up at the top", async () => {
    const req = await normalize(manifest("seedance-1-0-pro-250528"), requestFor("seedance-1-0-pro-250528"), {
      jobSetId: newId(),
      randomSeed: () => 4_000_000_000,
    });
    const body = toSeedanceBody(specFor("seedance-1-0-pro-250528")!, req.calls[0]!, {});
    expect(body.seed).toBe(4_000_000_000 % 2_147_483_648);
  });
});

describe("pricing", () => {
  test("BytePlus's own examples: 1.0 Pro at 720p 16:9 for 5 s is 102,960 tokens, about $0.26", () => {
    expect(videoTokens({ width: 1248, height: 704 }, 24, 5)).toBe(102_960);
    const cost = estimate(manifest("seedance-1-0-pro-250528"), {
      batch: 1,
      size: { aspect: "16:9" },
      video: { seconds: 5, resolution: "720p" },
    });
    expect(cost.min).toBeCloseTo(0.2574, 6);
    expect(cost.max).toBe(cost.min);
    expect(cost.confidence).toBe("estimated");
    expect(cost.basis).toContain("1248×704");
  });

  test("480p for 5 s is 48,600 tokens", () => {
    expect(videoTokens({ width: 864, height: 480 }, 24, 5)).toBe(48_600);
    const cost = estimate(manifest("seedance-1-0-pro-250528"), {
      batch: 1,
      size: { aspect: "16:9" },
      video: { seconds: 5, resolution: "480p" },
    });
    expect(cost.min).toBeCloseTo((48_600 * 2.5) / 1e6, 6);
  });

  test("rates by resolution and by sound", () => {
    const at = (id: string, video: GenerateRequest["video"]) =>
      estimate(manifest(id), { batch: 1, size: { aspect: "1:1" }, video }).min;
    const tokens1080 = videoTokens({ width: 1440, height: 1440 }, 24, 5);
    expect(at("dreamina-seedance-2-5-260628", { resolution: "1080p" })).toBeCloseTo(
      (tokens1080 * 11.7) / 1e6,
      6,
    );
    expect(at("dreamina-seedance-2-0-260128", { resolution: "4k" })).toBeCloseTo(
      (videoTokens({ width: 2880, height: 2880 }, 24, 5) * 4.0) / 1e6,
      6,
    );
    const tokens720 = videoTokens({ width: 960, height: 960 }, 24, 5);
    expect(at("seedance-1-5-pro-251215", { audio: true })).toBeCloseTo((tokens720 * 2.4) / 1e6, 6);
    expect(at("seedance-1-5-pro-251215", { audio: false })).toBeCloseTo((tokens720 * 1.2) / 1e6, 6);
  });

  test("auto could be any shape at its resolution, so it's the range over them", () => {
    const cost = estimate(manifest("dreamina-seedance-2-0-260128"), {
      batch: 1,
      size: { aspect: "auto" },
      video: { seconds: 5, resolution: "720p" },
    });
    expect(cost.min).toBeLessThan(cost.max);
    expect(cost.min).toBeCloseTo((videoTokens({ width: 1280, height: 720 }, 24, 5) * 7) / 1e6, 6);
    expect(cost.max).toBeCloseTo((videoTokens({ width: 1112, height: 834 }, 24, 5) * 7) / 1e6, 6);
  });

  test("the defaults price when nothing is chosen, and longer videos cost more", () => {
    const m = manifest("dreamina-seedance-2-0-fast-260128");
    const five = estimate(m, { batch: 1 });
    const ten = estimate(m, { batch: 1, video: { seconds: 10 } });
    expect(five.confidence).toBe("estimated");
    expect(ten.min).toBeCloseTo(five.min * 2, 6);
  });
});

describe("errors", () => {
  const mapped = async (exchange: RecordedExchange) =>
    mapError(response(exchange), undefined, "Seedance 2.0");

  test("each documented code maps to its §0.5 code", async () => {
    expect((await mapped(badKey)).code).toBe("auth_invalid");
    const off = await mapped(notActivated);
    expect([off.code, off.userMessage]).toEqual([
      "auth_forbidden",
      "Turn on Seedance 2.0 in BytePlus first, then try again.",
    ]);
    expect((await mapped(serviceNotOpen)).userMessage).toContain("Turn on Seedance 2.0 in BytePlus");
    expect((await mapped(overdue)).code).toBe("billing_required");
    const limited = await mapped(rateLimited);
    expect([limited.code, limited.retryAfterMs, limited.retryable]).toEqual(["rate_limited", 12_000, true]);
    const busy = await mapped(overloaded);
    expect([busy.code, busy.retryAfterMs, busy.retryable]).toEqual([
      "provider_unavailable",
      RATE_LIMIT_WAIT_MS,
      true,
    ]);
    const paused = await mapped(spendLimit);
    expect([paused.code, paused.retryable]).toEqual(["quota_exceeded", false]);
    expect((await mapped(serverError)).code).toBe("provider_unavailable");
    const bad = await mapped(invalid);
    expect([bad.code, bad.field]).toEqual(["invalid_request", "video.seconds"]);
    expect((await mapped(inputFlagged)).code).toBe("content_flagged_input");
  });

  test("a failed task's code maps the same way, with no HTTP status", () => {
    expect(errorFor({ code: "OutputVideoSensitiveContentDetected", message: "x" }).code).toBe(
      "content_refused",
    );
    expect(errorFor({ code: "InputTextSensitiveContentDetected.PolicyViolation" }).code).toBe(
      "content_refused",
    );
    expect(errorFor({ code: "InternalServiceError" }).code).toBe("provider_unavailable");
    expect(errorFor({ code: "SomethingNew" }).code).toBe("provider_error");
  });

  test("the key never lands in an error", async () => {
    const err = await mapped(badKey);
    expect(JSON.stringify({ ...err.toJSON(), message: err.message })).not.toContain(credentials.apiKey);
  });
});

describe("the task lifecycle", () => {
  test("queued, then running, then a video with its last frame, billed from the reported tokens", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("seedance-1-0-pro-250528").key);
    const req = await call("seedance-1-0-pro-250528", { video: { resolution: "720p" } });
    const handle = await model.submit(req, ctx);
    expect(handle.providerRef).toMatch(/^cgt-/);
    expect((await model.poll(handle, ctx)).state).toBe("queued");
    clock.now += 2_000;
    const running = await model.poll(handle, ctx);
    expect([running.state, running.nextPollAfterMs]).toEqual(["running", 5_000]);
    const done = await finish(model, handle, ctx, clock);
    expect(done.state).toBe("succeeded");
    const clip = done.result!.images[0]!;
    expect(clip.mimeType).toBe("video/mp4");
    expect([clip.width, clip.height]).toEqual([1280, 720]);
    expect(clip.durationMs).toBe(1000);
    expect(clip.hasAudio).toBe(false);
    expect(clip.seed).toBe(11);
    expect(ctx.assets.written.find((a) => a.assetId === clip.poster?.assetId)?.mimeType).toBe("image/jpeg");
    const tokens = done.result!.usage!.outputVideoTokens!;
    expect(done.result!.cost).toMatchObject({
      confidence: "reconciled",
      amount: Math.round(tokens * 2.5) / 1e6,
    });
    // The signed URL's query never reaches the stored payload.
    expect(JSON.stringify(done.result!.providerRaw)).not.toContain("X-Tos-Signature");
  });

  test("reads back off after the first minute", () => {
    expect([pollAfterMs(0), pollAfterMs(90_000), pollAfterMs(600_000)]).toEqual([5_000, 10_000, 20_000]);
  });

  test("cancel stops a queued task; a running one runs to the end and cancel ends quietly", async () => {
    const clock = { now: T0 };
    const { ctx, fetch } = processAt(clock);
    const model = provider.model(manifest("dreamina-seedance-2-0-fast-260128").key);
    const queued = await model.submit(
      await call("dreamina-seedance-2-0-fast-260128", { prompt: "#fake:slow waves" }),
      ctx,
    );
    await model.cancel!(queued, ctx);
    expect((await model.poll(queued, ctx)).state).toBe("canceled");
    expect(fetch.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);

    const started = await model.submit(await call("dreamina-seedance-2-0-fast-260128"), ctx);
    clock.now += 3_000;
    expect((await model.poll(started, ctx)).state).toBe("running");
    await model.cancel!(started, ctx);
    expect((await finish(model, started, ctx, clock)).state).toBe("succeeded");
  });

  test("a task BytePlus no longer has is gone, not a hiccup", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("dreamina-seedance-2-0-260128").key);
    const handle = await model.submit(
      await call("dreamina-seedance-2-0-260128", { prompt: "#fake:resume_gone" }),
      ctx,
    );
    clock.now += 11_000;
    const err = await model.poll(handle, ctx).then(
      () => undefined,
      (e: unknown) => e as { code: string; notFound?: boolean },
    );
    expect([err?.code, err?.notFound]).toEqual(["provider_error", true]);
  });

  test("an expired task is a timeout, and nothing is written", async () => {
    const clock = { now: T0 };
    const { ctx } = processAt(clock);
    const model = provider.model(manifest("dreamina-seedance-2-0-260128").key);
    const handle = await model.submit(
      await call("dreamina-seedance-2-0-260128", { prompt: "#fake:expired" }),
      ctx,
    );
    const update = await finish(model, handle, ctx, clock);
    expect([update.state, update.error?.code]).toEqual(["failed", "timeout"]);
    expect(ctx.assets.written).toHaveLength(0);
  });

  test("a frame outside BytePlus's limits fails before anything is sent", async () => {
    const clock = { now: T0 };
    const { ctx, fetch } = processAt(clock);
    const small = await ctx.assets.add(await gradientPng(120, 120, 1));
    const model = provider.model(manifest("dreamina-seedance-2-0-260128").key);
    const req = await call("dreamina-seedance-2-0-260128", { video: { startFrame: { assetId: small } } });
    const err = await model.submit(req, ctx).then(
      () => undefined,
      (e: unknown) => e as { code: string; field?: string },
    );
    expect([err?.code, err?.field]).toEqual(["invalid_request", "video.startFrame"]);
    expect(fetch.calls).toHaveLength(0);
  });

  test("the key goes in the Authorization header as a Bearer token, never the URL", async () => {
    const seen: string[] = [];
    const fake = createFakeFetch({ delayMs: 0 });
    const ctx = createTestContext({
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        expect(String(input instanceof Request ? input.url : input)).not.toContain(credentials.apiKey);
        return fake(input, init);
      },
      credentials,
    });
    await provider.verifyCredentials(ctx);
    expect(seen).toEqual([`Bearer ${credentials.apiKey}`]);
  });
});

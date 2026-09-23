import { beforeAll, describe, expect, test } from "bun:test";
import {
  type BatchHandle,
  batchHandleSchema,
  type NormalizedRequest,
  newId,
  providerSettingsSchemaSchema,
  type SettingValue,
  type SpeedId,
  setFormatLocale,
  speedName,
} from "@openfield/core";
import { createGoogleProvider } from "../src/google";
import batchCancelled from "../src/google/__fixtures__/batch-cancelled.json";
import batchCreate from "../src/google/__fixtures__/batch-create.json";
import batchExpired from "../src/google/__fixtures__/batch-expired.json";
import batchList from "../src/google/__fixtures__/batch-list.json";
import batchPartial from "../src/google/__fixtures__/batch-partial.json";
import batchRunning from "../src/google/__fixtures__/batch-running.json";
import batchSucceeded from "../src/google/__fixtures__/batch-succeeded.json";
import flexBusy from "../src/google/__fixtures__/flex-busy.json";
import noBilling from "../src/google/__fixtures__/no-billing.json";
import priorityStandard from "../src/google/__fixtures__/priority-standard.json";
import rateLimited from "../src/google/__fixtures__/rate-limited.json";
import speedRejected from "../src/google/__fixtures__/speed-rejected.json";
import { INLINE_LIMIT_BYTES } from "../src/google/batch";
import { isFlexBusy, mapError, mapRpcStatus } from "../src/google/errors";
import { serviceTierFor, toGeminiRequest } from "../src/google/map-request";
import { speedServed } from "../src/google/map-response";
import { GOOGLE_MODELS } from "../src/google/models";
import { GOOGLE_SETTINGS, parseGoogleSettings } from "../src/google/settings";
import { createTestContext, type TestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { gradientPng } from "../src/testing/png";
import type { RecordedExchange } from "../src/testing/types";
import { type FetchLike, ProviderError } from "../src/types";

beforeAll(() => setFormatLocale("en-US"));

const byId = (id: string) => GOOGLE_MODELS.find((m) => m.modelId === id)!;
const pro = byId("gemini-3-pro-image");
const flash = byId("gemini-3.1-flash-image");
const provider = createGoogleProvider();
const KEY = "google-speed-test-key-9f2c";

const call = (overrides: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  idempotencyKey: newId(),
  model: pro.key,
  op: "generate",
  prompt: "A fox in snow",
  promptAfterPreset: "A fox in snow",
  size: { aspect: "16:9" },
  resolution: "1K",
  batch: 1,
  source: "api",
  jobId: newId(),
  jobSetId: newId(),
  batchIndex: 0,
  manifestVersion: "2",
  paramsHash: `sha256:${"a".repeat(64)}`,
  speed: "standard",
  speedRequested: "standard",
  providerSettings: {},
  ...overrides,
});

const response = (exchange: RecordedExchange, status = exchange.response.status) =>
  new Response(JSON.stringify(exchange.response.body), { status, headers: exchange.response.headers });

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/** A context whose fetch records every request and answers from `answer`. */
function stubbed(
  answer: (req: Sent) => Response,
  opts: { speed?: SpeedId; settings?: Record<string, SettingValue> } = {},
) {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (input, init) => {
    const text = typeof init?.body === "string" ? init.body : undefined;
    const req = {
      method: init?.method ?? "GET",
      url: String(input),
      body: text ? JSON.parse(text) : undefined,
    };
    sent.push(req);
    return answer(req);
  };
  return { ctx: createTestContext({ fetch, credentials: { apiKey: KEY }, ...opts }), sent };
}

function faked(
  opts: {
    speed?: SpeedId;
    settings?: Record<string, SettingValue>;
    scenario?: "flex_busy" | "priority_standard";
  } = {},
) {
  const fetch = createFakeFetch({
    delayMs: 0,
    maxEdge: 32,
    ...(opts.scenario && { scenario: opts.scenario }),
  });
  const sent: unknown[] = [];
  const spy: FetchLike = (input, init) => {
    if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
    return fetch(input, init);
  };
  const ctx = createTestContext({
    fetch: spy,
    credentials: { apiKey: KEY },
    ...(opts.speed && { speed: opts.speed }),
    ...(opts.settings && { settings: opts.settings }),
  });
  return { ctx, sent, fetch };
}

const rejection = async (promise: Promise<unknown>): Promise<ProviderError> => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
};

describe("Google settings", () => {
  test("the schema obeys §0.3's rules and binds Speed to the manifests' offers", () => {
    expect(providerSettingsSchemaSchema.safeParse(GOOGLE_SETTINGS).error?.issues ?? []).toEqual([]);
    expect(provider.settings).toBe(GOOGLE_SETTINGS);
    const speed = GOOGLE_SETTINGS.panels[0]!.fields[0]!;
    if (speed.kind !== "select") throw new Error("speed is a select");
    const offered = new Set(GOOGLE_MODELS.flatMap((m) => m.speeds?.map((o) => o.id) ?? []));
    expect(speed.options.map((o) => o.value)).toEqual(["standard", "flex", "batch", "priority"]);
    for (const id of offered) expect(speed.options.map((o) => o.value)).toContain(id);
  });

  test("copy is short, plain and sentence case, with Google's own speed names", () => {
    const strings: string[] = [];
    for (const panel of GOOGLE_SETTINGS.panels) {
      strings.push(panel.label, panel.description ?? "");
      for (const field of panel.fields) {
        strings.push(field.label, field.description ?? "");
        if (field.kind === "select")
          for (const o of field.options) strings.push(o.label, o.description ?? "");
      }
    }
    const banned = /\b(tier|tiers|SLA|async|adapter|manifest|capabilit|provider|endpoint|simply|just)\b|—/i;
    for (const s of strings.filter(Boolean)) {
      expect(banned.test(s), s).toBe(false);
      expect(s.length, s).toBeLessThanOrEqual(80);
      expect(s[0], s).toBe(s[0]!.toUpperCase());
    }
    const name = (speed: SpeedId) => speedName(GOOGLE_SETTINGS, speed);
    expect([name("flex"), name("batch"), name("priority")]).toEqual(["Flex", "Batch", "Priority"]);
  });

  test("When it's busy is its own panel, so it stays in view while Speed isn't Flex", () => {
    expect(GOOGLE_SETTINGS.panels.map((p) => p.label)).toEqual(["Speed", "When it's busy"]);
    const busy = GOOGLE_SETTINGS.panels[1]!.fields[0]!;
    if (busy.kind !== "select") throw new Error("flexBusy is a select");
    expect(busy.showWhen).toEqual([{ field: "speed", in: ["flex"] }]);
    // Each choice shows what it bills at.
    expect(busy.options.map((o) => [o.value, o.priceAt])).toEqual([
      ["wait", "flex"],
      ["standard", "standard"],
    ]);
  });

  test("the adapter reads its settings defensively", () => {
    expect(parseGoogleSettings(undefined)).toEqual({ flexBusy: "wait" });
    expect(parseGoogleSettings({ flexBusy: "standard" })).toEqual({ flexBusy: "standard" });
    expect(parseGoogleSettings({ flexBusy: 42 })).toEqual({ flexBusy: "wait" });
  });
});

describe("speed on the wire", () => {
  test("serviceTier sits at the top level, only for Flex and Priority", () => {
    expect([serviceTierFor("standard"), serviceTierFor("batch"), serviceTierFor("flex")]).toEqual([
      undefined,
      undefined,
      "flex",
    ]);
    const flex = toGeminiRequest(pro, call(), [], { serviceTier: "flex" });
    expect(flex.serviceTier).toBe("flex");
    expect(JSON.stringify(flex.generationConfig)).not.toContain("serviceTier");
    expect("serviceTier" in toGeminiRequest(pro, call(), [])).toBe(false);
  });

  test("the speed served comes from usageMetadata, then the header, then the request", () => {
    expect(speedServed(priorityStandard.response.body, undefined, "priority")).toBe("standard");
    expect(speedServed({ usageMetadata: { serviceTier: "SERVICE_TIER_FLEX" } }, undefined, "standard")).toBe(
      "flex",
    );
    expect(speedServed({}, new Headers({ "x-gemini-service-tier": "standard" }), "priority")).toBe(
      "standard",
    );
    expect(speedServed({}, new Headers(), "flex")).toBe("flex");
    expect(speedServed({ usageMetadata: { serviceTier: "unspecified" } }, undefined, "flex")).toBe(
      "standard",
    );
  });
});

describe("errors for speeds and billing", () => {
  test("a free-tier quota of zero means billing is off (decision 9)", async () => {
    const err = await mapError(response(noBilling));
    expect(err.code).toBe("billing_required");
    expect(err.retryable).toBe(false);
    expect(err.userMessage).toBe("Turn on billing for this key in Google AI Studio to make images.");
  });

  test("Flex busy: a 503, or a 429 without a quota failure; never a quota or rate limit", () => {
    expect(isFlexBusy(response(flexBusy), flexBusy.response.body)).toBe(true);
    const bare = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource exhausted." } };
    expect(isFlexBusy(new Response(null, { status: 429 }), bare)).toBe(true);
    expect(isFlexBusy(response(rateLimited), rateLimited.response.body)).toBe(false);
    expect(isFlexBusy(response(noBilling), noBilling.response.body)).toBe(false);
    // Billing off, even when the body carries only the message.
    const billingOff = { error: { ...bare.error, message: "Quota exceeded for metric: x, limit: 0" } };
    expect(isFlexBusy(new Response(null, { status: 429 }), billingOff)).toBe(false);
    expect(isFlexBusy(new Response(null, { status: 500 }), {})).toBe(false);
  });

  test("a speed Google won't take names the speed field", async () => {
    const err = await mapError(response(speedRejected));
    expect([err.code, err.field]).toEqual(["unsupported_param", "speed"]);
  });

  test("batch item statuses map like HTTP errors", async () => {
    expect((await mapRpcStatus({ code: 13, message: "Internal error encountered." })).code).toBe(
      "provider_unavailable",
    );
    expect((await mapRpcStatus({ code: 3, message: "Bad" })).code).toBe("invalid_request");
    expect((await mapRpcStatus({ code: 7, message: "No" })).code).toBe("auth_forbidden");
    expect((await mapRpcStatus({ code: 4 })).code).toBe("timeout");
    expect((await mapRpcStatus({ code: 400, message: "Unsupported aspect ratio: 7:3" })).field).toBe("size");
    expect((await mapRpcStatus(undefined)).code).toBe("provider_unavailable");
  });

  test("AQ. keys never survive into a message", async () => {
    const key = "AQ.Xy7FakeTmZ0xq4FwT9tY2kPz1QbV7cD3eH5jK";
    const body = { error: { code: 400, status: "INVALID_ARGUMENT", message: `API key ${key} is malformed` } };
    const err = await mapError(new Response(JSON.stringify(body), { status: 400 }));
    expect(err.message).not.toContain(key);
    expect(err.message).toContain("[hidden]");
  });
});

describe("submit at a speed", () => {
  test("Flex on Nano Banana Pro asks for Flex and bills what Google says it served", async () => {
    const h = faked({ speed: "flex" });
    const handle = await provider.model(pro.key).submit(call(), h.ctx);
    expect((h.sent[0] as { serviceTier?: string }).serviceTier).toBe("flex");
    const result = (await provider.model(pro.key).poll(handle, h.ctx)).result;
    expect(result?.speedUsed).toBe("flex");
  });

  test("Standard sends no serviceTier and reports Standard", async () => {
    const h = faked();
    const handle = await provider.model(pro.key).submit(call(), h.ctx);
    expect("serviceTier" in (h.sent[0] as object)).toBe(false);
    expect((handle.resume?.result as { speedUsed?: string } | undefined)?.speedUsed).toBe("standard");
  });

  test("Priority that Google served at Standard bills Standard", async () => {
    const h = faked({ speed: "priority", scenario: "priority_standard" });
    const handle = await provider.model(pro.key).submit(call(), h.ctx);
    expect((h.sent[0] as { serviceTier?: string }).serviceTier).toBe("priority");
    expect((handle.resume?.result as { speedUsed?: string } | undefined)?.speedUsed).toBe("standard");
  });

  test("Flex busy, keep trying: a busy error the runner waits out, not a retry", async () => {
    const h = faked({ speed: "flex", scenario: "flex_busy", settings: { flexBusy: "wait" } });
    const err = await rejection(provider.model(pro.key).submit(call(), h.ctx));
    expect([err.code, err.busy, err.retryable]).toEqual(["provider_unavailable", true, true]);
    expect(err.toJSON().busy).toBe(true);
    // The fake's Retry-After reaches the runner, which lets it win over the busy schedule.
    expect(err.retryAfterMs).toBe(2000);
    expect(h.sent).toHaveLength(1);
    expect(h.ctx.assets.written).toHaveLength(0);
  });

  test("Flex busy, switch to Standard: sends again without serviceTier in the same attempt", async () => {
    const h = faked({
      speed: "flex",
      scenario: "flex_busy",
      settings: { speed: "flex", flexBusy: "standard" },
    });
    const handle = await provider.model(pro.key).submit(call(), h.ctx);
    expect(h.sent).toHaveLength(2);
    expect((h.sent[0] as { serviceTier?: string }).serviceTier).toBe("flex");
    expect("serviceTier" in (h.sent[1] as object)).toBe(false);
    expect((handle.resume?.result as { speedUsed?: string } | undefined)?.speedUsed).toBe("standard");
  });

  test("a speed the model lacks fails with a reason that points at the setting", async () => {
    const h = faked({ speed: "flex" });
    const err = await rejection(provider.model(flash.key).submit(call({ model: flash.key }), h.ctx));
    expect([err.code, err.field, err.hint?.action]).toEqual(["unsupported_param", "speed", "open-settings"]);
    expect(err.userMessage).toBe(
      "Google doesn't offer Flex for this model. Choose another speed in Google settings.",
    );
  });

  test("a Batch run never goes through submit", async () => {
    const h = faked({ speed: "batch" });
    const err = await rejection(provider.model(pro.key).submit(call(), h.ctx));
    expect(err.code).toBe("invalid_request");
    expect(h.sent).toHaveLength(0);
  });
});

describe("batch path, on hand-made fixtures", () => {
  const A = "01K6BQ8A1C4D7E9F2G3H4J5K6M";
  const B = "01K6BQ9Z0A1B2C3D4E5F6G7H8J";
  const handle: BatchHandle = {
    remoteId: "batches/k3v9q2m8x7w1r5t0",
    displayName: "openfield-01K6BQ7Y2M8N4P0R3S5T7V9W1X",
    expiresAt: "2026-09-25T12:00:00.123Z",
    resume: { keys: [A, B], uploads: ["files/ref1"], submittedAt: Date.parse("2026-09-23T12:00:00.123Z") },
  };
  const batch = () => provider.model(pro.key).batch!;
  const pollWith = (exchange: RecordedExchange, harvest: string[], status?: number) => {
    const h = stubbed(() => response(exchange, status));
    return { h, update: batch().poll(handle, h.ctx, { harvest }) };
  };

  test("only models with a Batch offer get the batch path", () => {
    for (const m of GOOGLE_MODELS) {
      const offers = m.speeds?.some((o) => o.id === "batch") ?? false;
      expect(typeof provider.model(m.key).batch?.submit === "function").toBe(offers);
    }
  });

  test("submit: one create call, keyed by job id, named after the run, no serviceTier", async () => {
    const h = stubbed(() => response(batchCreate));
    const jobSetId = newId();
    const reqs = [call({ jobSetId, speed: "batch" }), call({ jobSetId, speed: "batch", batchIndex: 1 })];
    const made = await batch().submit(reqs, h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:batchGenerateContent",
    );
    const body = h.sent[0]!.body as {
      batch: {
        displayName: string;
        inputConfig: { requests: { requests: { request: object; metadata: { key: string } }[] } };
      };
    };
    expect(body.batch.displayName).toBe(`openfield-${jobSetId}`);
    const items = body.batch.inputConfig.requests.requests;
    expect(items.map((r) => r.metadata.key)).toEqual(reqs.map((r) => r.jobId));
    expect(items.every((r) => !("serviceTier" in r.request))).toBe(true);
    expect(made.remoteId).toBe("batches/k3v9q2m8x7w1r5t0");
    expect(made.displayName).toBe(`openfield-${jobSetId}`);
    expect(made.expiresAt).toBe("2026-09-25T12:00:00.123Z");
    expect(batchHandleSchema.parse(JSON.parse(JSON.stringify(made)))).toEqual(made);
  });

  test("running: counts, no items, nothing written", async () => {
    const { h, update } = pollWith(batchRunning, [A, B]);
    expect(await update).toEqual({
      state: "running",
      counts: { total: 2, succeeded: 1, failed: 0, pending: 1 },
    });
    expect(h.ctx.assets.written).toHaveLength(0);
  });

  test("succeeded: every harvested image is saved and billed at Batch", async () => {
    const { h, update } = pollWith(batchSucceeded, [A, B]);
    const done = await update;
    expect(done.state).toBe("succeeded");
    expect(done.items?.map((i) => [i.jobId, i.ok])).toEqual([
      [A, true],
      [B, true],
    ]);
    const first = done.items?.[0];
    if (!first?.ok) throw new Error("expected a result");
    expect(first.result.speedUsed).toBe("batch");
    expect(first.result.images[0]).toMatchObject({ index: 0, width: 12, height: 16, mimeType: "image/png" });
    expect(h.ctx.assets.written).toHaveLength(2);
  });

  test("harvest only writes the jobs asked for, so a resumed harvest never duplicates", async () => {
    const { h, update } = pollWith(batchSucceeded, [B]);
    const done = await update;
    expect(done.items?.map((i) => i.jobId)).toEqual([B]);
    expect(h.ctx.assets.written).toHaveLength(1);
    const again = pollWith(batchSucceeded, []);
    expect((await again.update).items).toEqual([]);
    expect(again.h.ctx.assets.written).toHaveLength(0);
  });

  test("an image that can't be saved here fails only its own job", async () => {
    const h = stubbed(() => response(batchSucceeded));
    const write = h.ctx.assets.write.bind(h.ctx.assets);
    let writes = 0;
    h.ctx.assets.write = (stream, meta) => {
      if (++writes === 1)
        return Promise.reject(new ProviderError("disk_full", { message: "The disk is full" }));
      return write(stream, meta);
    };
    const done = await batch().poll(handle, h.ctx, { harvest: [A, B] });
    const [first, second] = done.items ?? [];
    if (first?.ok !== false) throw new Error("expected an error");
    expect([first.jobId, first.error.code]).toEqual([A, "disk_full"]);
    expect(second).toMatchObject({ jobId: B, ok: true });
    expect(h.ctx.assets.written).toHaveLength(1);
  });

  test("partial: each item maps to its own job, with its own error", async () => {
    const done = await pollWith(batchPartial, [A, B]).update;
    expect(done.items?.[0]).toMatchObject({ jobId: A, ok: true });
    const failed = done.items?.[1];
    expect(failed?.jobId).toBe(B);
    if (failed?.ok !== false) throw new Error("expected an error");
    expect(failed.error.code).toBe("provider_unavailable");
  });

  test("expired: every unfinished image times out with Google's 48 hours", async () => {
    const done = await pollWith(batchExpired, [A, B]).update;
    expect(done.state).toBe("expired");
    for (const item of done.items ?? []) {
      if (item.ok) throw new Error("expected an error");
      expect(item.error.code).toBe("timeout");
      expect(item.error.userMessage).toBe("Google didn't finish this within 48 hours.");
    }
  });

  test("canceled: what finished first is kept, the rest is canceled", async () => {
    const done = await pollWith(batchCancelled, [A, B]).update;
    expect(done.state).toBe("canceled");
    expect(done.items?.[0]).toMatchObject({ jobId: A, ok: true });
    const rest = done.items?.[1];
    if (rest?.ok !== false) throw new Error("expected an error");
    expect(rest.error.code).toBe("canceled");
  });

  test("a batch this key can't read is auth_forbidden; the runner, which knows the key, picks the words", async () => {
    const body = { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied" } };
    for (const status of [403, 404]) {
      const h = stubbed(
        () => new Response(JSON.stringify({ error: { ...body.error, code: status } }), { status }),
      );
      const err = await rejection(batch().poll(handle, h.ctx, { harvest: [A] }));
      expect([err.code, err.httpStatus, err.retryable]).toEqual(["auth_forbidden", status, false]);
    }
  });

  test("cancel, cleanup and find call the documented paths", async () => {
    const h = stubbed((req) =>
      req.url.includes("/batches?") ? response(batchList) : new Response("{}", { status: 200 }),
    );
    await batch().cancel(handle, h.ctx);
    await batch().cleanup?.(handle, h.ctx);
    const found = await batch().find?.("openfield-01K6BQ7Y2M8N4P0R3S5T7V9W1X", h.ctx);
    const base = "https://generativelanguage.googleapis.com/v1beta";
    expect(h.sent.map((s) => `${s.method} ${s.url.replace(/\?.*$/, "")}`)).toEqual([
      `POST ${base}/batches/k3v9q2m8x7w1r5t0:cancel`,
      `DELETE ${base}/batches/k3v9q2m8x7w1r5t0`,
      `DELETE ${base}/files/ref1`,
      `GET ${base}/batches`,
    ]);
    expect(found).toMatchObject({
      remoteId: "batches/k3v9q2m8x7w1r5t0",
      expiresAt: "2026-09-25T12:00:00.123Z",
    });
    const none = stubbed(() => response(batchList));
    expect(await batch().find?.("openfield-nobody", none.ctx)).toBeNull();
  });

  test("a cancel after the batch finished is fine", async () => {
    const body = { error: { code: 400, status: "FAILED_PRECONDITION", message: "Batch already completed." } };
    const h = stubbed(() => new Response(JSON.stringify(body), { status: 400 }));
    await batch().cancel(handle, h.ctx);
  });
});

describe("batch path, over the inline size limit", () => {
  async function bigReference(ctx: TestContext): Promise<string> {
    // A real PNG header with padding: big enough to cross the limit four times over.
    const png = await gradientPng(8, 8, 1);
    const bytes = new Uint8Array(6_000_000);
    bytes.set(png);
    return ctx.assets.add(bytes, "image/png");
  }

  test("each distinct reference is uploaded once and pointed at from every request", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    const bodies: { url: string; size: number; json?: unknown }[] = [];
    const spy: FetchLike = (input, init) => {
      const body = init?.body;
      const size = typeof body === "string" ? body.length : body instanceof Uint8Array ? body.byteLength : 0;
      bodies.push({ url: String(input), size, ...(typeof body === "string" && { json: JSON.parse(body) }) });
      return fetch(input, init);
    };
    const ctx = createTestContext({ fetch: spy, credentials: { apiKey: KEY }, speed: "batch" });
    const ref = await bigReference(ctx);
    const jobSetId = newId();
    const reqs = [0, 1, 2, 3].map((i) =>
      call({ jobSetId, batchIndex: i, speed: "batch", references: [{ assetId: ref, role: "style" }] }),
    );
    const made = await provider.model(pro.key).batch!.submit(reqs, ctx);

    const uploads = fetch.calls.filter((c) => c.url.includes("/upload/v1beta/files"));
    expect(uploads).toHaveLength(2);
    const create = bodies.find((b) => b.url.endsWith(":batchGenerateContent"))!;
    expect(create.size).toBeLessThan(INLINE_LIMIT_BYTES);
    const text = JSON.stringify(create.json);
    expect(text).not.toContain("inlineData");
    expect(text.match(/"fileUri"/g)).toHaveLength(4);
    expect(made.resume?.uploads).toHaveLength(1);

    await provider.model(pro.key).batch!.cleanup?.(made, ctx);
    expect(fetch.calls.some((c) => c.method === "DELETE" && c.url.includes("/v1beta/files/"))).toBe(true);
  });

  /** A create call whose answer is lost after Google has (or hasn't) made the batch. */
  function lostCreate(opts: { reached: boolean }) {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    let lose = true;
    const spy: FetchLike = async (input, init) => {
      const create = String(input).endsWith(":batchGenerateContent");
      if (create && lose && !opts.reached) {
        lose = false;
        throw new TypeError("fetch failed");
      }
      const res = await fetch(input, init);
      if (create && lose) {
        lose = false;
        throw new TypeError("fetch failed");
      }
      return res;
    };
    const ctx = createTestContext({ fetch: spy, credentials: { apiKey: KEY }, speed: "batch" });
    const deleted = () =>
      fetch.calls.filter((c) => c.method === "DELETE" && c.url.includes("/v1beta/files/")).length;
    return { fetch, ctx, deleted };
  }

  async function bigRun(ctx: TestContext) {
    const ref = await bigReference(ctx);
    const jobSetId = newId();
    return [0, 1, 2, 3].map((i) =>
      call({ jobSetId, batchIndex: i, speed: "batch", references: [{ assetId: ref, role: "style" }] }),
    );
  }

  test("uploads from a create that never answered stay until it's known whether the batch exists", async () => {
    const { fetch, ctx, deleted } = lostCreate({ reached: false });
    const reqs = await bigRun(ctx);
    const api = provider.model(pro.key).batch!;
    expect((await rejection(api.submit(reqs, ctx))).code).toBe("network");
    // The batch may exist and point at them, so nothing is deleted yet.
    expect(deleted()).toBe(0);
    // Sent again only once find() came back empty: the first copies go before new ones are made.
    expect(await api.find?.(`openfield-${reqs[0]!.jobSetId}`, ctx)).toBeNull();
    await api.submit(reqs, ctx);
    expect(deleted()).toBe(1);
    expect(fetch.calls.filter((c) => c.url.includes("/upload/v1beta/files"))).toHaveLength(4);
  });

  test("a batch found after its create answer was lost takes its uploads along for cleanup", async () => {
    const { ctx, deleted } = lostCreate({ reached: true });
    const reqs = await bigRun(ctx);
    const api = provider.model(pro.key).batch!;
    await rejection(api.submit(reqs, ctx));
    const found = await api.find?.(`openfield-${reqs[0]!.jobSetId}`, ctx);
    expect(found?.resume?.uploads).toHaveLength(1);
    await api.cleanup?.(found!, ctx);
    expect(deleted()).toBe(1);
  });
});

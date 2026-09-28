import { describe, expect, test } from "bun:test";
import { type NormalizedRequest, newId } from "@openfield/core";
import { estimate, inputImageTokens } from "../src/manifest/estimate";
import { createOpenAiProvider } from "../src/openai";
import { openAiSize, outputTokens, RATIOS, SIZE_RULES, TIERS } from "../src/openai/capabilities";
import { manifestFor, mergeDiscovered, recognise, variantOf } from "../src/openai/discovery";
import { mapError } from "../src/openai/errors";
import { endpointFor, toImageFields } from "../src/openai/map-request";
import { costOf, toJobResult, usageOf } from "../src/openai/map-response";
import { OPENAI_MODELS } from "../src/openai/models";
import { INPUT_IMAGE_TOKENS } from "../src/openai/pricing";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { openAiFake } from "../src/testing/openai";
import { gradientPng } from "../src/testing/png";
import type { FetchLike } from "../src/types";

// The OpenAI adapter (§6.14): sizes that obey the Image API's rules, prices from OpenAI's own
// token calculator, masks sent as they are, errors in Openfield's words.

const byId = (id: string) => OPENAI_MODELS.find((m) => m.modelId === id)!;
const sunburst = byId("gpt-image-2.5-sunburst");
const flare = byId("gpt-image-2.5-flare");
const gpt2 = byId("gpt-image-2");

const call = (overrides: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  idempotencyKey: newId(),
  model: flare.key,
  op: "generate",
  prompt: "A lighthouse at dusk",
  promptAfterPreset: "A lighthouse at dusk",
  size: { aspect: "3:4" },
  resolution: "1K",
  quality: "medium",
  batch: 1,
  source: "api",
  jobId: newId(),
  jobSetId: newId(),
  batchIndex: 0,
  manifestVersion: "1",
  paramsHash: `sha256:${"a".repeat(64)}`,
  speed: "standard",
  speedRequested: "standard",
  providerSettings: {},
  ...overrides,
});

const fixture = (name: keyof typeof openAiFake.fixtures) => {
  const exchange = openAiFake.fixtures[name]!;
  return new Response(JSON.stringify(exchange.response.body), {
    status: exchange.response.status,
    headers: exchange.response.headers,
  });
};

describe("catalog", () => {
  test("the three current models, with Batch on GPT Image 2 only", () => {
    expect(OPENAI_MODELS.map((m) => [m.displayName, m.key, m.speeds?.map((s) => s.id) ?? []])).toEqual([
      ["GPT Image 2.5 Sunburst", "openai:gpt-image-2.5-sunburst", []],
      ["GPT Image 2.5 Flare", "openai:gpt-image-2.5-flare", []],
      ["GPT Image 2", "openai:gpt-image-2", ["batch"]],
    ]);
  });

  test("Extra high and Max are for the 2.5 models; GPT Image 2 stops at High", () => {
    const ids = (m: typeof flare) => m.capabilities.quality?.levels.map((l) => l.id);
    expect(ids(sunburst)).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
    expect(ids(gpt2)).toEqual(["low", "medium", "high", "auto"]);
    expect(gpt2.capabilities.transparency).toBe(false);
    expect(flare.capabilities.background?.values).toContain("transparent");
  });
});

describe("sizes", () => {
  test("every ratio at every tier is a size OpenAI takes", () => {
    for (const ratio of RATIOS) {
      for (const tier of TIERS) {
        const size = openAiSize(ratio, tier);
        if (size === "auto") continue;
        const { width, height } = size;
        const long = Math.max(width, height);
        expect(width % SIZE_RULES.multipleOf, `${ratio}@${tier}`).toBe(0);
        expect(height % SIZE_RULES.multipleOf, `${ratio}@${tier}`).toBe(0);
        expect(long).toBeLessThanOrEqual(SIZE_RULES.maxEdge);
        expect(long / Math.min(width, height)).toBeLessThanOrEqual(SIZE_RULES.maxRatio);
        expect(width * height).toBeGreaterThanOrEqual(SIZE_RULES.minPixels);
        expect(width * height).toBeLessThanOrEqual(SIZE_RULES.maxPixels);
      }
    }
  });

  test("tiers keep their shape and grow or shrink to OpenAI's pixel limits", () => {
    expect(openAiSize("3:4", "1K")).toEqual({ width: 768, height: 1024 });
    expect(openAiSize("1:1", "1.5K")).toEqual({ width: 1536, height: 1536 });
    // 1024×576 is under the floor, so it grows; 3840×3840 is over the ceiling, so it shrinks.
    expect(openAiSize("16:9", "1K")).toEqual({ width: 1088, height: 608 });
    expect(openAiSize("1:1", "4K")).toEqual({ width: 2880, height: 2880 });
    expect(openAiSize("16:9", "4K")).toEqual({ width: 3840, height: 2160 });
    expect(openAiSize("auto", "2K")).toBe("auto");
  });
});

describe("prices", () => {
  test("the token formula gives OpenAI's published GPT Image 2 prices", () => {
    // $30 per 1M output tokens: low, medium and high, square then portrait (guide, 2026-09-27).
    const usd = (tokens: number) => Math.round(tokens * 30) / 1e6;
    expect(usd(outputTokens(16, 1024, 1024))).toBeCloseTo(0.006, 3);
    expect(usd(outputTokens(48, 1024, 1024))).toBeCloseTo(0.053, 3);
    expect(usd(outputTokens(96, 1024, 1024))).toBeCloseTo(0.211, 3);
    expect(usd(outputTokens(48, 1024, 1536))).toBeCloseTo(0.041, 3);
    // And the 2.5 calculator's own values at 1024×1024.
    expect([24, 48, 64, 96].map((b) => outputTokens(b, 1024, 1024))).toEqual([439, 1756, 3122, 7024]);
  });

  test("the estimate reads the row for the ratio and tier, and a tier's range for auto", () => {
    const exact = estimate(flare, { batch: 2, size: { aspect: "3:4" }, resolution: "1K", quality: "medium" });
    const tokens = outputTokens(24, 768, 1024);
    expect(exact.max - exact.min).toBeLessThan(0.0001);
    expect(exact.min).toBeCloseTo(((tokens * 30) / 1e6) * 2, 4);
    const auto = estimate(flare, { batch: 1, size: { aspect: "auto" }, resolution: "1K", quality: "medium" });
    expect(auto.min).toBeLessThan(auto.max);
    // Batch is half the output price.
    const batch = estimate(gpt2, {
      batch: 1,
      size: { aspect: "1:1" },
      resolution: "1K",
      quality: "high",
      speed: "batch",
    });
    const standard = estimate(gpt2, { batch: 1, size: { aspect: "1:1" }, resolution: "1K", quality: "high" });
    expect(batch.max).toBeCloseTo(standard.max / 2, 4);
  });

  test("an image sent in costs its patches at $8 per 1M, read once for the whole batch", () => {
    // The measured gpt-image-2 counts the rule reproduces.
    const tokens = (width: number, height: number) =>
      inputImageTokens(INPUT_IMAGE_TOKENS, { width, height }).min;
    const sides: [number, number][] = [
      [256, 256],
      [384, 384],
      [768, 768],
      [1024, 1024],
      [1536, 1536],
      [2048, 1024],
    ];
    expect(sides.map(([w, h]) => tokens(w, h))).toEqual([256, 576, 1024, 1024, 1521, 1458]);
    // A very wide image is padded out to 3:1 first, then shrunk to fit like any other. Its size
    // unknown, the range any could come to.
    expect(tokens(1024, 128)).toBe(32 * 11);
    expect(tokens(3072, 256)).toBe(66 * 22);
    expect(inputImageTokens(INPUT_IMAGE_TOKENS)).toEqual({ min: 1024, max: 1536 });

    const base = { batch: 2, size: { aspect: "1:1" as const }, resolution: "1K" as const, quality: "medium" };
    const plain = estimate(flare, base);
    const known = estimate(flare, { ...base, inputImageSizes: [{ width: 256, height: 256 }] });
    expect(known.min - plain.min).toBeCloseTo((256 * 8) / 1e6, 6);
    expect(known.basis).toBe(`${plain.basis} + 1 reference image ($0.002)`);
    const later = estimate(flare, { ...base, inputImages: 2 });
    expect(later.min - plain.min).toBeCloseTo((2 * 1024 * 8) / 1e6, 6);
    expect(later.max - plain.max).toBeCloseTo((2 * 1536 * 8) / 1e6, 6);
    // Batch reads them at $4.
    const batch = estimate(gpt2, { ...base, speed: "batch" });
    const batchIn = estimate(gpt2, {
      ...base,
      speed: "batch",
      inputImageSizes: [{ width: 1024, height: 1024 }],
    });
    expect(batchIn.min - batch.min).toBeCloseTo((1024 * 4) / 1e6, 6);
  });

  test("a run is priced from the tokens OpenAI reports", () => {
    const usage = usageOf(
      {
        data: [{ b64_json: "x" }],
        usage: {
          input_tokens: 60,
          input_tokens_details: { text_tokens: 50, image_tokens: 10 },
          output_tokens: 1756,
          output_tokens_details: { image_tokens: 1756, text_tokens: 0 },
        },
      },
      1,
    )!;
    expect(usage).toMatchObject({ inputTextTokens: 50, inputImageTokens: 10, outputImageTokens: 1756 });
    const cost = costOf(usage, flare.price)!;
    expect(cost.confidence).toBe("reconciled");
    expect(cost.amount).toBeCloseTo((50 * 5 + 10 * 8 + 1756 * 30) / 1e6, 6);
  });
});

describe("requests", () => {
  test("a generation is JSON; anything with an input image is an edit", () => {
    expect(endpointFor(call())).toBe("generations");
    expect(endpointFor(call({ references: [{ assetId: newId(), role: "style" }] }))).toBe("edits");
    expect(endpointFor(call({ op: "inpaint", base: { assetId: newId(), role: "base" } }))).toBe("edits");
    expect(
      toImageFields(flare, call({ background: "transparent", output: { format: "webp", compression: 80 } })),
    ).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "A lighthouse at dusk",
      n: 1,
      size: "768x1024",
      quality: "medium",
      background: "transparent",
      output_format: "webp",
      output_compression: 80,
    });
    // Compression means nothing to PNG, and GPT Image 2 doesn't get a transparent background.
    expect(
      toImageFields(gpt2, call({ background: "transparent", output: { format: "png", compression: 80 } })),
    ).not.toHaveProperty("output_compression");
    expect(toImageFields(gpt2, call({ background: "transparent" }))).not.toHaveProperty("background");
  });

  test("a mask goes to OpenAI as it is: transparent means change, as in Openfield", async () => {
    const forms: FormData[] = [];
    const fake = createFakeFetch({ routes: [openAiFake], delayMs: 0, maxEdge: 48 });
    const fetch: FetchLike = async (input, init) => {
      if (init?.body instanceof FormData) forms.push(init.body);
      return fake(input, init);
    };
    const ctx = createTestContext({ fetch, credentials: { apiKey: "sk-test-openai" } });
    const base = await ctx.assets.add(await gradientPng(32, 24, 1));
    const maskBytes = await gradientPng(32, 24, 2);
    const mask = await ctx.assets.add(maskBytes);
    const model = createOpenAiProvider().model(flare.key);
    const handle = await model.submit(
      call({ op: "inpaint", base: { assetId: base, role: "base" }, mask: { assetId: mask } }),
      ctx,
    );
    expect(handle.resume?.result).toBeDefined();
    const sent = forms[0]!.get("mask") as Blob;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(maskBytes));
    expect(forms[0]!.getAll("image[]")).toHaveLength(1);

    // A mask the size of another image is refused before anything is sent.
    const wrong = await ctx.assets.add(await gradientPng(16, 16, 3));
    const err = await model
      .submit(call({ op: "inpaint", base: { assetId: base, role: "base" }, mask: { assetId: wrong } }), ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_request", field: "mask" });
    expect(forms).toHaveLength(1);
  });

  test("images arrive inline and land in the asset store with the reported usage", async () => {
    const ctx = createTestContext({ fetch: createFakeFetch(), credentials: { apiKey: "sk-test-openai" } });
    const result = await toJobResult(
      {
        output_format: "png",
        data: [{ b64_json: Buffer.from(await gradientPng(8, 8, 1)).toString("base64") }],
      },
      { batchIndex: 2 },
      ctx,
      { submittedAt: 0, price: flare.price, speed: "standard" },
    );
    expect(result.images).toMatchObject([{ index: 2, width: 8, height: 8, mimeType: "image/png" }]);
    expect(ctx.assets.written).toHaveLength(1);
  });
});

describe("errors", () => {
  test("each fixture maps to its code, in Openfield's words", async () => {
    expect((await mapError(fixture("bad_key"))).code).toBe("auth_invalid");
    const forbidden = await mapError(fixture("forbidden"));
    expect(forbidden.code).toBe("auth_forbidden");
    expect(forbidden.userMessage).toBe("Verify your organization with OpenAI to use this model.");
    expect((await mapError(fixture("no_billing"))).code).toBe("billing_required");
    expect(await mapError(fixture("invalid"))).toMatchObject({ code: "unsupported_param", field: "size" });
    expect(await mapError(fixture("rate_limited"))).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 12_000,
    });
    expect((await mapError(fixture("refused"))).code).toBe("content_refused");
    expect((await mapError(fixture("blocked"))).code).toBe("content_refused");
    expect((await mapError(fixture("unavailable"))).code).toBe("provider_unavailable");
  });

  test("a key OpenAI echoes back never reaches the message", async () => {
    const err = await mapError(fixture("bad_key"));
    expect(err.message).not.toContain("sk-proj");
  });
});

describe("discovery", () => {
  test("dated snapshots are recognised, and skipped when their model is listed too", () => {
    expect(recognise("gpt-image-2-2026-04-21")).toBe(true);
    expect(recognise("gpt-image-1.5")).toBe(false);
    expect(variantOf("gpt-image-2.5-flare-2026-09-08")).toBe("gpt-image-2.5-flare");
    expect(mergeDiscovered(["gpt-image-2", "gpt-image-2-2026-04-21"]).map((m) => m.modelId)).toEqual(
      OPENAI_MODELS.map((m) => m.modelId),
    );
    expect(manifestFor("gpt-image-2-2026-04-21")).toMatchObject({
      displayName: "GPT Image 2 (2026-04-21)",
      source: "discovered",
    });
  });
});

describe("batch", () => {
  test("a run with references goes to the JSON form of edits, one image per line", async () => {
    const bodies: string[] = [];
    const fake = createFakeFetch({ routes: [openAiFake], delayMs: 0, maxEdge: 48 });
    const fetch: FetchLike = async (input, init) => {
      if (init?.body instanceof FormData) {
        const file = init.body.get("file");
        if (file && typeof file !== "string") bodies.push(await (file as Blob).text());
      }
      return fake(input, init);
    };
    const ctx = createTestContext({ fetch, credentials: { apiKey: "sk-test-openai" }, speed: "batch" });
    const ref = await ctx.assets.add(await gradientPng(24, 32, 4));
    const jobSetId = newId();
    const reqs = [0, 1].map((batchIndex) =>
      call({ model: gpt2.key, jobSetId, batchIndex, references: [{ assetId: ref, role: "style" }] }),
    );
    const handle = await createOpenAiProvider().model(gpt2.key).batch!.submit(reqs, ctx);
    const lines = bodies[0]!
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.custom_id, l.url, l.body.n])).toEqual(
      reqs.map((r) => [r.jobId, "/v1/images/edits", 1]),
    );
    expect(lines[0].body.images[0].image_url).toMatch(/^data:image\/png;base64,/);
    // The handle holds ids, never the images or the key.
    expect(JSON.stringify(handle)).not.toContain("base64");
    expect(JSON.stringify(handle)).not.toContain("sk-test");
  });
});

import { describe, expect, test } from "bun:test";
import { type GenerateRequest, type NormalizedRequest, newId } from "@openfield/core";
import { estimate, inputImageTokens } from "../src/manifest/estimate";
import { editSizeFor, fitsPixelRules } from "../src/manifest/size";
import { normalize } from "../src/normalize";
import { createOpenAiProvider } from "../src/openai";
import {
  MASK_MAX_BYTES,
  openAiSize,
  outputTokens,
  RATIOS,
  SIZE_RULES,
  TIERS,
} from "../src/openai/capabilities";
import { manifestFor, mergeDiscovered, recognise, variantOf } from "../src/openai/discovery";
import { mapError } from "../src/openai/errors";
import { endpointFor, toImageFields } from "../src/openai/map-request";
import { costOf, toJobResult, usageOf } from "../src/openai/map-response";
import { OPENAI_MODELS } from "../src/openai/models";
import { INPUT_IMAGE_TOKENS } from "../src/openai/pricing";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { openAiFake } from "../src/testing/openai";
import { encodeRgbaPng, gradientPng, maskPng } from "../src/testing/png";
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

  test("an edit asks for its base's own size when OpenAI takes it, else the nearest it does", () => {
    const sized = (width: number, height: number) => editSizeFor(flare, { width, height });
    expect(sized(1024, 1024)).toEqual({
      size: { kind: "pixels", width: 1024, height: 1024 },
      resolution: "1K",
    });
    expect(sized(3840, 2160)).toEqual({
      size: { kind: "pixels", width: 3840, height: 2160 },
      resolution: "4K",
    });
    // 1080 isn't a multiple of 16; a Gemini 4K square is over the pixel ceiling; 512² under the floor.
    expect(sized(1920, 1080)).toEqual({
      size: { kind: "pixels", width: 1920, height: 1088 },
      resolution: "2K",
    });
    expect(sized(4096, 4096)).toEqual({
      size: { kind: "pixels", width: 2880, height: 2880 },
      resolution: "4K",
    });
    expect(sized(512, 512)).toEqual({ size: { kind: "pixels", width: 816, height: 816 }, resolution: "1K" });
    // Wider than 3:1 can't keep its shape.
    const wide = sized(4000, 1000).size;
    expect(wide).toMatchObject({ kind: "pixels" });
    if (wide.kind === "pixels") expect(wide.width / wide.height).toBe(3);
    for (const [w, h] of [
      [1920, 1080],
      [1000, 700],
      [333, 2000],
      [7000, 5000],
      [4096, 4096],
      [4000, 1000],
      [64, 64],
    ]) {
      const size = sized(w!, h!).size;
      if (size.kind !== "pixels") throw new Error("Expected pixels");
      expect(fitsPixelRules(size.width, size.height, SIZE_RULES), `${w}×${h}`).toBe(true);
    }
  });

  test("a size in pixels is kept when OpenAI takes it, and refused when it doesn't", async () => {
    const req = (width: number, height: number): GenerateRequest => ({
      idempotencyKey: newId(),
      model: flare.key,
      op: "generate",
      prompt: "A lighthouse",
      size: { kind: "pixels", width, height },
      batch: 1,
      source: "api",
    });
    const kept = await normalize(flare, req(1920, 1088), { jobSetId: newId() });
    expect(kept.request.size).toEqual({ width: 1920, height: 1088 });
    expect(kept.diagnostics).toEqual([]);
    expect(toImageFields(flare, kept.request).size).toBe("1920x1088");
    // OpenAI's manifest stops a run it can't send as asked, rather than quietly changing it.
    const refused = await normalize(flare, req(1920, 1080), { jobSetId: newId() });
    expect(refused.error).toMatchObject({ code: "unsupported_param", field: "size" });
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

  const maskHarness = () => {
    const forms: FormData[] = [];
    const fake = createFakeFetch({ routes: [openAiFake], delayMs: 0, maxEdge: 48 });
    const fetch: FetchLike = async (input, init) => {
      if (init?.body instanceof FormData) forms.push(init.body);
      return fake(input, init);
    };
    const ctx = createTestContext({ fetch, credentials: { apiKey: "sk-test-openai" } });
    return { forms, ctx, model: createOpenAiProvider().model(flare.key) };
  };
  const inpaint = (base: string, mask: string, references: string[] = []) =>
    call({
      op: "inpaint",
      base: { assetId: base, role: "base" },
      mask: { assetId: mask },
      ...(references.length && {
        references: references.map((assetId) => ({ assetId, role: "style" as const })),
      }),
    });

  test("a mask goes to OpenAI as it is: transparent means change, as in Openfield", async () => {
    const { forms, ctx, model } = maskHarness();
    const base = await ctx.assets.add(await gradientPng(32, 24, 1));
    const ref = await ctx.assets.add(await gradientPng(16, 16, 5));
    const maskBytes = await maskPng(32, 24, { x: 8, y: 4, width: 12, height: 10 });
    const mask = await ctx.assets.add(maskBytes);
    const handle = await model.submit(inpaint(base, mask, [ref]), ctx);
    expect(handle.resume?.result).toBeDefined();
    const sent = forms[0]!.get("mask") as Blob;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(maskBytes));
    // The base is the first image, which is the one OpenAI applies the mask to.
    const images = forms[0]!.getAll("image[]") as Blob[];
    expect(images).toHaveLength(2);
    const baseBytes = new Uint8Array((await ctx.assets.read(base)).bytes);
    expect(new Uint8Array(await images[0]!.arrayBuffer())).toEqual(baseBytes);

    // A mask the size of another image is refused before anything is sent.
    const wrong = await ctx.assets.add(await maskPng(16, 16, { x: 0, y: 0, width: 4, height: 4 }));
    const err = await model.submit(inpaint(base, wrong), ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_request", field: "mask" });
    expect(forms).toHaveLength(1);
  });

  test("a mask with no alpha, or 4MB or more, is refused before anything is sent", async () => {
    const { forms, ctx, model } = maskHarness();
    const base = await ctx.assets.add(await gradientPng(32, 24, 1));
    const opaque = await ctx.assets.add(await gradientPng(32, 24, 2));
    const noAlpha = await model.submit(inpaint(base, opaque), ctx).catch((e: unknown) => e);
    expect(noAlpha).toMatchObject({ code: "invalid_request", field: "mask" });
    expect((noAlpha as { userMessage: string }).userMessage).toBe(
      "This mask isn't transparent anywhere. Make the area to change transparent, then try again.",
    );

    // Noise doesn't compress, so a 1024² RGBA mask of it stays over 4MB.
    const [w, h] = [1024, 1024];
    const noise = new Uint8Array(w * h * 4);
    for (let i = 0, s = 1; i < noise.length; i++) {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      noise[i] = s >>> 24;
    }
    const huge = await encodeRgbaPng(w, h, noise);
    expect(huge.byteLength).toBeGreaterThanOrEqual(MASK_MAX_BYTES);
    const bigBase = await ctx.assets.add(await gradientPng(w, h, 3));
    const tooLarge = await model
      .submit(inpaint(bigBase, await ctx.assets.add(huge)), ctx)
      .catch((e: unknown) => e);
    expect(tooLarge).toMatchObject({ code: "payload_too_large", field: "mask" });
    expect((tooLarge as { userMessage: string }).userMessage).toBe(
      "This mask is too large. The limit is 4 MB.",
    );
    expect(forms).toHaveLength(0);
  });

  test("the fake API holds masks to the same rules", async () => {
    const fake = createFakeFetch({ routes: [openAiFake], delayMs: 0, maxEdge: 48 });
    const send = async (mask: Uint8Array) => {
      const form = new FormData();
      form.append("model", "gpt-image-2.5-flare");
      form.append("prompt", "A red door");
      form.append(
        "image[]",
        new Blob([(await gradientPng(32, 24, 1)).slice()], { type: "image/png" }),
        "a.png",
      );
      form.append("mask", new Blob([mask.slice()], { type: "image/png" }), "mask.png");
      const res = await fake("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: form,
      });
      return { status: res.status, body: (await res.json()) as { error?: { param?: string } } };
    };
    expect((await send(await maskPng(32, 24, { x: 0, y: 0, width: 8, height: 8 }))).status).toBe(200);
    const opaque = await send(await gradientPng(32, 24, 2));
    expect(opaque).toMatchObject({ status: 400, body: { error: { param: "mask" } } });
    const padded = new Uint8Array(MASK_MAX_BYTES);
    padded.set(await maskPng(32, 24, { x: 0, y: 0, width: 8, height: 8 }));
    expect(await send(padded)).toMatchObject({ status: 400, body: { error: { param: "mask" } } });
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

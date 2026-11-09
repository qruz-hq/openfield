import { describe, expect, test } from "bun:test";
import {
  type GenerateRequest,
  type Mark,
  type ModelManifest,
  type NormalizedRequest,
  newId,
} from "@openfield/core";
import { createByteplusProvider } from "../src/byteplus";
import { LAST_FRAME_JPEG } from "../src/byteplus/__fixtures__/media";
import editReferences from "../src/byteplus/__fixtures__/seedream/edit-references.json";
import generate from "../src/byteplus/__fixtures__/seedream/generate.json";
import groupPartial from "../src/byteplus/__fixtures__/seedream/group-partial.json";
import groupShort from "../src/byteplus/__fixtures__/seedream/group-short.json";
import invalid from "../src/byteplus/__fixtures__/seedream/invalid.json";
import ipmLimited from "../src/byteplus/__fixtures__/seedream/ipm-rate-limited.json";
import layers from "../src/byteplus/__fixtures__/seedream/layers.json";
import notOpen from "../src/byteplus/__fixtures__/seedream/not-open.json";
import outputFlagged from "../src/byteplus/__fixtures__/seedream/output-flagged.json";
import quotaExceeded from "../src/byteplus/__fixtures__/seedream/quota-exceeded.json";
import { mapError } from "../src/byteplus/errors";
import { colorName, MARK_INKS, promptWithMarks } from "../src/byteplus/marks";
import { BYTEPLUS_MODELS } from "../src/byteplus/models";
import { PRO_TIER_PIXELS } from "../src/byteplus/pricing";
import { seedreamSize, seedreamSpecFor } from "../src/byteplus/seedream";
import { toLayersBody, toSeedreamBody, wireSize } from "../src/byteplus/seedream-request";
import { costOf, type SeedreamResponse, toSeedreamResult } from "../src/byteplus/seedream-response";
import { estimate } from "../src/manifest/estimate";
import { normalize } from "../src/normalize";
import { createTestContext, MemoryAssetSink } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { encodeRgbaPng, gradientPng } from "../src/testing/png";
import type { RecordedExchange } from "../src/testing/types";
import { ProviderError } from "../src/types";

// What the conformance suite doesn't pin down for Seedream: the body each model gets, marks in the
// prompt, the price math against the pricing page, related sets that come back short, and layers.

const PRO = "dola-seedream-5-0-pro-260628";
const FLASH = "dola-seedream-5-0-flash-260915";
const LITE = "seedream-5-0-260128";
const V45 = "seedream-4-5-251128";
const V40 = "seedream-4-0-250828";

const provider = createByteplusProvider();
const credentials = { apiKey: "ark-key-3f9a1c7e" };
const manifest = (modelId: string): ModelManifest => BYTEPLUS_MODELS.find((m) => m.modelId === modelId)!;
const spec = (modelId: string) => seedreamSpecFor(modelId)!;

function requestFor(modelId: string, overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    idempotencyKey: newId(),
    model: manifest(modelId).key,
    op: "generate",
    prompt: "A paper boat on a puddle",
    size: { kind: "aspect", ratio: "3:2" },
    batch: 1,
    source: "api",
    ...overrides,
  };
}

async function calls(
  modelId: string,
  overrides: Partial<GenerateRequest> = {},
): Promise<NormalizedRequest[]> {
  const normalized = await normalize(manifest(modelId), requestFor(modelId, overrides), {
    jobSetId: newId(),
    randomSeed: () => 7,
  });
  if (normalized.error) throw normalized.error;
  return normalized.calls;
}
const call = async (modelId: string, overrides: Partial<GenerateRequest> = {}) =>
  (await calls(modelId, overrides))[0]!;

const pngB64 = async () => Buffer.from(await gradientPng(8, 8, 3)).toString("base64");
const alphaB64 = async () => {
  const rgba = new Uint8Array(4 * 4 * 4).fill(200);
  for (let p = 0; p < 16; p += 2) rgba[p * 4 + 3] = 0;
  return Buffer.from(await encodeRgbaPng(4, 4, rgba)).toString("base64");
};

/** A fixture body with its image placeholders swapped for real, tiny images. */
async function bodyOf(exchange: RecordedExchange): Promise<SeedreamResponse> {
  const swaps: Record<string, string> = {
    '"<png>"': JSON.stringify(await pngB64()),
    '"<png-alpha>"': JSON.stringify(await alphaB64()),
    '"<jpeg>"': JSON.stringify(LAST_FRAME_JPEG),
  };
  let text = JSON.stringify(exchange.response.body);
  for (const [from, to] of Object.entries(swaps)) text = text.split(from).join(to);
  return JSON.parse(text) as SeedreamResponse;
}

const response = (exchange: RecordedExchange) =>
  new Response(JSON.stringify(exchange.response.body), {
    status: exchange.response.status,
    headers: exchange.response.headers ?? {},
  });

function mapOptions(modelId: string, extra: Partial<Parameters<typeof toSeedreamResult>[3]> = {}) {
  return {
    submittedAt: 0,
    price: manifest(modelId).price,
    speed: "standard" as const,
    model: manifest(modelId).displayName,
    inputsSent: 0,
    format: "png" as const,
    ...extra,
  };
}

describe("the Seedream catalog", () => {
  test("only the 5.0 models take output_format, only Pro and Flash separate layers", () => {
    for (const id of [PRO, FLASH, LITE]) expect(spec(id).formats).toEqual(["png", "jpeg"]);
    for (const id of [V45, V40]) expect(spec(id).formats).toEqual(["jpeg"]);
    expect(manifest(PRO).capabilities.layers?.maxLayers).toBe(16);
    expect(manifest(FLASH).capabilities.layers?.sizes).toEqual(["auto", "1K", "1.5K", "2K"]);
    for (const id of [LITE, V45, V40]) expect(manifest(id).capabilities.layers).toBeUndefined();
    // Related sets on the models that make them; Pro and Flash make one image per call.
    for (const id of [LITE, V45, V40]) expect(manifest(id).capabilities.batch.groupOption).toBe("relatedSet");
    for (const id of [PRO, FLASH]) expect(manifest(id).capabilities.batch.groupOption).toBeUndefined();
  });

  test("the old Lite id still finds the Lite model", () => {
    expect(provider.recognise("seedream-5-0-lite-260128")).toBe(true);
    expect(seedreamSpecFor("seedream-5-0-lite-260128")?.modelId).toBe(LITE);
  });

  test("sizes come from each tier's table, within each model's pixel range", () => {
    expect(seedreamSize(spec(PRO), "1:1", "1K")).toEqual({ width: 1024, height: 1024 });
    expect(seedreamSize(spec(PRO), "16:9", "2K")).toEqual({ width: 2816, height: 1584 });
    expect(seedreamSize(spec(LITE), "1:1", "4K")).toEqual({ width: 4096, height: 4096 });
    for (const s of [PRO, FLASH, LITE, V45, V40].map(spec)) {
      for (const tier of s.tiers) {
        for (const aspect of ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"] as const) {
          const size = seedreamSize(s, aspect, tier)!;
          expect(size.width * size.height).toBeGreaterThanOrEqual(s.pixels[0]);
          expect(size.width * size.height).toBeLessThanOrEqual(s.pixels[1]);
        }
      }
    }
  });
});

describe("the request body", () => {
  test("Pro: exact size for the shape, PNG, no watermark, inline images, nothing it doesn't list", async () => {
    const req = await call(PRO, { resolution: "1K" });
    const body = toSeedreamBody(spec(PRO), req, { images: [] }, { fast: false });
    expect(body).toEqual({
      model: PRO,
      prompt: "A paper boat on a puddle",
      size: wireSize(spec(PRO), req),
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
    });
    expect(body.size).toMatch(/^\d+x\d+$/);
  });

  test("Fast turns on the fast prompt optimizer on Pro and 4.0 only", async () => {
    for (const id of [PRO, V40]) {
      const body = toSeedreamBody(spec(id), await call(id), { images: [] }, { fast: true });
      expect(body.optimize_prompt_options).toEqual({ mode: "fast" });
    }
    for (const id of [FLASH, LITE, V45]) {
      const body = toSeedreamBody(spec(id), await call(id), { images: [] }, { fast: true });
      expect(body.optimize_prompt_options).toBeUndefined();
    }
  });

  test("4.5 and 4.0 never get output_format, even when PNG is asked for", async () => {
    for (const id of [V45, V40]) {
      const req = await call(id, { output: { format: "png" } } as Partial<GenerateRequest>);
      expect(toSeedreamBody(spec(id), req, { images: [] }, { fast: false }).output_format).toBeUndefined();
    }
  });

  test("auto shape sends the tier and lets the model pick", async () => {
    const req = await call(LITE, { size: { kind: "aspect", ratio: "auto" } });
    expect(wireSize(spec(LITE), req)).toBe("2K");
  });

  test("one image goes as a string, several as a list, the edited image first", async () => {
    const one = toSeedreamBody(
      spec(PRO),
      await call(PRO),
      { images: ["data:image/png;base64,AA"] },
      { fast: false },
    );
    expect(one.image).toBe("data:image/png;base64,AA");
    const two = toSeedreamBody(
      spec(PRO),
      await call(PRO),
      { images: ["data:image/png;base64,AA", "data:image/jpeg;base64,BB"] },
      { fast: false },
    );
    expect(two.image).toEqual(["data:image/png;base64,AA", "data:image/jpeg;base64,BB"]);
  });

  test("a transparent background goes as PNG with background transparent", async () => {
    const req = await call(PRO, { output: { format: "jpeg" } } as Partial<GenerateRequest>);
    const body = toSeedreamBody(spec(PRO), req, { images: ["x"], transparent: true }, { fast: false });
    expect(body.background).toBe("transparent");
    expect(body.output_format).toBe("png");
  });

  test("by default a count of 4 is four calls of one; a related set is one call of 4", async () => {
    const plain = await calls(LITE, { batch: 4 });
    expect(plain).toHaveLength(4);
    expect(
      toSeedreamBody(spec(LITE), plain[0]!, { images: [] }, { fast: false }).sequential_image_generation,
    ).toBe(undefined);

    const set = await calls(LITE, { batch: 4, providerOptions: { relatedSet: true } });
    expect(set).toHaveLength(1);
    const body = toSeedreamBody(spec(LITE), set[0]!, { images: [] }, { fast: false });
    expect(body.sequential_image_generation).toBe("auto");
    expect(body.sequential_image_generation_options).toEqual({ max_images: 4 });
    expect("stream" in body).toBe(false);
  });

  test("inputs and outputs of a related set stay within 15", async () => {
    const [req] = await calls(V45, { batch: 4, providerOptions: { relatedSet: true } });
    const images = Array.from({ length: 13 }, () => "data:image/png;base64,AA");
    const body = toSeedreamBody(spec(V45), req!, { images }, { fast: false });
    expect(body.sequential_image_generation_options).toEqual({ max_images: 2 });
  });

  test("Pro and Flash never get a related set, even if asked", async () => {
    const req = await call(PRO, { batch: 2, providerOptions: { relatedSet: true } });
    expect(toSeedreamBody(spec(PRO), req, { images: [] }, { fast: false }).sequential_image_generation).toBe(
      undefined,
    );
  });

  test("a separation sends one image, layer_decomposition and a resolution level", async () => {
    const req = { ...(await call(PRO)), promptAfterPreset: "", layers: { size: "1.5K" as const } };
    expect(toLayersBody(spec(PRO), req, "data:image/png;base64,AA")).toEqual({
      model: PRO,
      image: "data:image/png;base64,AA",
      layer_decomposition: true,
      size: "1.5K",
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
    });
  });
});

describe("marks in the prompt", () => {
  test("points and boxes become tags on the 0 to 999 grid after the image they're on", () => {
    const marks: Mark[] = [
      { kind: "point", at: { x: 0.5, y: 0.25 }, note: "Add a red balloon here" },
      { kind: "box", from: { x: 0.8, y: 0.9 }, to: { x: 0.1, y: 1 }, image: 2, color: "#1E3A8A" },
    ];
    const { prompt, drawings } = promptWithMarks("Keep the light warm", marks);
    expect(prompt).toBe(
      [
        "Keep the light warm",
        "Marked places:\n" +
          "1. Image 1 <point>500 250</point>: Add a red balloon here.\n" +
          "2. Image 2 <bbox>100 900 800 999</bbox>: Make it navy (#1E3A8A).",
      ].join("\n\n"),
    );
    expect(drawings.size).toBe(0);
  });

  test("circles, strokes and arrows are drawn in inks of their own and named by them", () => {
    const marks: Mark[] = [
      { kind: "circle", from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.4 }, material: "brushed steel." },
      { kind: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.5 }, note: "Move the cup this way" },
      {
        kind: "stroke",
        points: [
          { x: 0.5, y: 0.5 },
          { x: 0.7, y: 0.6 },
        ],
        image: 2,
      },
    ];
    const { prompt, drawings } = promptWithMarks("", marks);
    expect(prompt).toBe(
      "Marked places:\n" +
        "1. The red circle drawn on Image 1, around Image 1 <bbox>100 100 300 400</bbox>: Make it look like brushed steel.\n" +
        "2. The blue arrow drawn on Image 1, from <point>200 200</point> to <point>600 500</point>: Move the cup this way.\n" +
        "3. The green line drawn on Image 2, around Image 2 <bbox>500 500 700 600</bbox>.\n\n" +
        "Remove every drawn mark from the result.",
    );
    expect(drawings.get(1)?.map((d) => [d.kind, d.color])).toEqual([
      ["circle", MARK_INKS[0].hex],
      ["arrow", MARK_INKS[1].hex],
    ]);
    expect(drawings.get(2)?.map((d) => d.kind)).toEqual(["stroke"]);
  });

  test("a colour is named in words beside its hex", () => {
    expect(colorName("#FF0000")).toBe("red");
    expect(colorName("#F5F5F0")).toBe("white");
    expect(colorName("#2E7D32")).toBe("green");
  });

  test("the marks reach the body, and composite is off by default with marks", async () => {
    const req = await call(PRO, {
      op: "edit",
      base: { assetId: newId(), role: "base" },
      marks: [{ kind: "point", at: { x: 0, y: 1 } }],
    } as Partial<GenerateRequest>);
    const body = toSeedreamBody(spec(PRO), req, { images: ["data:image/png;base64,AA"] }, { fast: false });
    expect(body.prompt).toContain("Image 1 <point>0 999</point>.");
  });
});

describe("prices", () => {
  const sizes = (w: number, h: number, n = 1) => Array.from({ length: n }, () => ({ width: w, height: h }));

  test("Pro: under 2.61M pixels at $0.045, over at $0.09, inputs after the first at $0.003", () => {
    const price = manifest(PRO).price;
    expect(PRO_TIER_PIXELS).toBe(2_610_000);
    expect(costOf(price, sizes(1536, 1536), { inputImages: 0, layered: false })?.amount).toBe(0.045);
    expect(costOf(price, sizes(2048, 2048), { inputImages: 0, layered: false })?.amount).toBe(0.09);
    expect(costOf(price, sizes(1024, 1024), { inputImages: 1, layered: false })?.amount).toBe(0.045);
    expect(costOf(price, sizes(1024, 1024), { inputImages: 4, layered: false })?.amount).toBe(0.054);
  });

  test("a separation bills the base and each layer at the layer rate, by their own pixels", () => {
    const price = manifest(PRO).price;
    // A 2K base and two small layers, one image in (free).
    const amount = costOf(price, [...sizes(2048, 2048), ...sizes(900, 600, 2)], {
      inputImages: 1,
      layered: true,
    })?.amount;
    expect(amount).toBe(0.045 + 0.0225 * 2);
    expect(
      costOf(manifest(FLASH).price, sizes(1024, 1024, 3), { inputImages: 1, layered: true })?.amount,
    ).toBe(0.054);
  });

  test("only images that came back are billed, as many as usage says", () => {
    const price = manifest(LITE).price;
    expect(
      costOf(price, sizes(2048, 2048, 3), { billedImages: 2, inputImages: 0, layered: false }),
    ).toMatchObject({
      amount: 0.07,
      confidence: "reconciled",
    });
  });

  test("an estimate is exact for single calls and a range for a related set", async () => {
    const one = estimate(manifest(LITE), { batch: 3, resolution: "2K" });
    expect([one.min, one.max, one.confidence]).toEqual([0.105, 0.105, "exact"]);
    const set = estimate(manifest(LITE), {
      batch: 3,
      resolution: "2K",
      providerOptions: { relatedSet: true },
    });
    expect([set.min, set.max, set.confidence]).toEqual([0.035, 0.105, "estimated"]);
  });

  test("a separation's estimate runs from a base and one layer to a base and 16", () => {
    const worst = estimate(manifest(PRO), { op: "decompose", batch: 1, layers: { size: "2K" } });
    expect([worst.min, worst.max]).toEqual([0.09, 0.765]);
    const auto = estimate(manifest(PRO), { op: "decompose", batch: 1, layers: { size: "auto" } });
    expect([auto.min, auto.max]).toEqual([0.045, 0.765]);
    expect(auto.basis).toContain("16");
  });

  test("Fast costs the same as Standard", async () => {
    const req = await call(PRO, { resolution: "2K" });
    expect(estimate(manifest(PRO), { ...req, speed: "priority" }).max).toBe(estimate(manifest(PRO), req).max);
  });
});

describe("the response", () => {
  const ctx = () =>
    createTestContext({ fetch: createFakeFetch({ delayMs: 0 }), credentials, assets: new MemoryAssetSink() });

  test("one image: stored, sized from data[].size, priced from usage", async () => {
    const c = ctx();
    const result = await toSeedreamResult(
      await bodyOf(generate),
      { batchIndex: 0, batch: 1, op: "generate" },
      c,
      mapOptions(PRO),
    );
    expect(result.images).toHaveLength(1);
    expect(result.failures).toBeUndefined();
    expect(result.cost?.confidence).toBe("reconciled");
    expect(JSON.stringify(result.providerRaw)).not.toContain(await pngB64());
  });

  test("references are charged past the first on Pro, at the rate for the size made", async () => {
    const result = await toSeedreamResult(
      await bodyOf(editReferences),
      { batchIndex: 0, batch: 1, op: "edit" },
      ctx(),
      mapOptions(PRO, { inputsSent: 3 }),
    );
    // One 1424x800 image (under 2.61M pixels) and three inputs, the first free.
    expect(result.cost!.amount).toBeCloseTo(0.045 + 2 * 0.003, 6);
  });

  test("a related set with one image moderated keeps the rest and fails that one", async () => {
    const body = await bodyOf(groupPartial);
    const result = await toSeedreamResult(
      body,
      { batchIndex: 0, batch: body.data!.length, op: "generate" },
      ctx(),
      mapOptions(LITE),
    );
    expect(result.images.length).toBe(body.data!.filter((d) => d.b64_json).length);
    expect(result.failures?.map((f) => [f.index, f.error.code])).toEqual([[1, "content_refused"]]);
  });

  test("a related set that comes back short fails the images it didn't make", async () => {
    const result = await toSeedreamResult(
      await bodyOf(groupShort),
      { batchIndex: 0, batch: 4, op: "generate" },
      ctx(),
      mapOptions(LITE),
    );
    expect(result.images.map((i) => i.index)).toEqual([0, 1]);
    expect(result.failures?.map((f) => f.index)).toEqual([2, 3]);
    expect(result.failures?.[0]?.error.userMessage).toContain("Seedream 5.0 Lite");
    expect(result.cost?.amount).toBe(0.07);
  });

  test("a separation: the base first, then each layer with its box, name and place in the stack", async () => {
    const result = await toSeedreamResult(
      await bodyOf(layers),
      { batchIndex: 0, batch: 1, op: "decompose" },
      ctx(),
      mapOptions(PRO, { inputsSent: 1 }),
    );
    const [base, ...rest] = result.images;
    expect(base?.layer).toEqual({ role: "base", zIndex: 0, canvas: { width: 2048, height: 2048 } });
    expect(rest[0]?.layer).toMatchObject({
      role: "layer",
      zIndex: 1,
      box: [383, 120, 1655, 384],
      boxGrid: [187, 59, 808, 188],
      name: "Seedream title text",
    });
    expect(result.images.every((i) => i.index === 0 && i.mimeType === "image/png")).toBe(true);
    // A 2K base at $0.045 and the layers at $0.0225 each (all under 2.61M pixels).
    expect(result.cost?.amount).toBeCloseTo(0.045 + 0.0225 * rest.length, 6);
  });

  test("a separation that fails, fails as a whole, in words about layers", async () => {
    const body = (await bodyOf(layers)) as SeedreamResponse;
    body.data![2] = { error: { code: "InternalServiceError", message: "Layer failed" } };
    const thrown = await toSeedreamResult(
      body,
      { batchIndex: 0, batch: 1, op: "decompose" },
      ctx(),
      mapOptions(PRO),
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).userMessage).toContain("layers");
  });

  test("an image URL instead of inline data is refused", async () => {
    const thrown = await toSeedreamResult(
      { data: [{ url: "https://example.com/x.png" }] },
      { batchIndex: 0, batch: 1, op: "generate" },
      ctx(),
      mapOptions(PRO),
    ).catch((e: unknown) => e);
    expect((thrown as ProviderError).code).toBe("provider_error");
  });
});

describe("errors", () => {
  test("a model that isn't turned on says to turn it on in BytePlus", async () => {
    const err = await mapError(response(notOpen), undefined, "Seedream 5.0 Pro");
    expect(err.code).toBe("auth_forbidden");
    expect(err.userMessage).toMatch(/BytePlus/);
  });

  test("the per-minute image limit waits and retries; a used-up quota doesn't", async () => {
    const limited = await mapError(response(ipmLimited), undefined, "Seedream 5.0 Pro");
    expect(limited.code).toBe("rate_limited");
    const quota = await mapError(response(quotaExceeded), undefined, "Seedream 5.0 Pro");
    expect(quota.retryable).toBe(false);
  });

  test("a bad request and a moderated output keep their own codes", async () => {
    expect((await mapError(response(invalid))).code).toBe("invalid_request");
    expect((await mapError(response(outputFlagged))).code).toBe("content_refused");
  });
});

describe("through the fake", () => {
  function setup(speed: "standard" | "priority" = "standard") {
    const fetch = createFakeFetch({ delayMs: 0 });
    const assets = new MemoryAssetSink();
    const ctx = createTestContext({ fetch, credentials, assets, speed });
    return { fetch, assets, ctx };
  }

  test("an edit with marks draws the shapes on the image before sending", async () => {
    const { assets, ctx } = setup();
    const baseAssetId = await assets.add(await gradientPng(1024, 1024, 5));
    const req = await call(PRO, {
      op: "edit",
      base: { assetId: baseAssetId, role: "base" },
      marks: [
        { kind: "circle", from: { x: 0.2, y: 0.2 }, to: { x: 0.4, y: 0.4 }, note: "Make this a lemon" },
        { kind: "point", at: { x: 0.7, y: 0.7 } },
      ],
    } as Partial<GenerateRequest>);
    const model = provider.model(manifest(PRO).key);
    const handle = await model.submit(req, ctx);
    const update = await model.poll(handle, ctx);
    expect(update.state).toBe("succeeded");
    expect(assets.drawn).toHaveLength(1);
    expect(assets.drawn[0]?.assetId).toBe(baseAssetId);
    expect(assets.drawn[0]?.drawings.map((d) => d.kind)).toEqual(["circle"]);
  });

  test("an image with only point or box marks still goes through the sink, to be turned upright", async () => {
    const { assets, ctx } = setup();
    const baseAssetId = await assets.add(await gradientPng(1024, 1024, 6));
    const refId = await assets.add(await gradientPng(1024, 1024, 7));
    const req = await call(PRO, {
      op: "edit",
      base: { assetId: baseAssetId, role: "base" },
      references: [{ assetId: refId, role: "subject" }],
      marks: [{ kind: "point", at: { x: 0.5, y: 0.5 } }],
    } as Partial<GenerateRequest>);
    const model = provider.model(manifest(PRO).key);
    expect((await model.poll(await model.submit(req, ctx), ctx)).state).toBe("succeeded");
    // Only the image the mark is on.
    expect(assets.drawn.map((d) => [d.assetId, d.drawings.length])).toEqual([[baseAssetId, 0]]);
  });

  async function separation(modelId: string, prompt: string) {
    const { assets, ctx } = setup();
    const baseAssetId = await assets.add(await gradientPng(1024, 1024, 9));
    const norm = await normalize(
      manifest(modelId),
      requestFor(modelId, {
        op: "decompose",
        base: { assetId: baseAssetId, role: "base" },
        layers: { size: "1K" },
        prompt,
      } as Partial<GenerateRequest>),
      { jobSetId: newId(), randomSeed: () => 1 },
    );
    if (norm.error) throw norm.error;
    expect(norm.calls[0]!.op).toBe("decompose");
    const model = provider.model(manifest(modelId).key);
    return model.poll(await model.submit(norm.calls[0]!, ctx), ctx);
  }

  test("a separation stores a base and its layers", async () => {
    const update = await separation(FLASH, "");
    if (update.state !== "succeeded" || !update.result) throw new Error(update.state);
    expect(update.result.images.map((i) => i.layer?.role)).toEqual(["base", "layer", "layer", "layer"]);
  });

  test("a separation BytePlus fails on its side says the layers didn't work", async () => {
    const err = (await separation(PRO, "#fake:failed").catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("provider_unavailable");
    expect(err.userMessage).toContain("layers");
  });

  test("a transparent background needs one PNG with alpha", async () => {
    const { assets, ctx } = setup();
    const baseAssetId = await assets.add(await gradientPng(1024, 1024, 2));
    const req = await call(PRO, {
      op: "edit",
      base: { assetId: baseAssetId, role: "base" },
      background: "transparent",
    } as Partial<GenerateRequest>);
    const err = await provider
      .model(manifest(PRO).key)
      .submit(req, ctx)
      .catch((e: unknown) => e);
    expect((err as ProviderError).field).toBe("background");
  });
});

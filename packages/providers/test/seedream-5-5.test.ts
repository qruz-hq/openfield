import { describe, expect, test } from "bun:test";
import {
  type GenerateRequest,
  LAYER_TEXT_LINES_MAX,
  LAYER_TEXT_MAX,
  LAYER_TEXT_RUNS_MAX,
  layerOpParamsSchema,
  layerTextSummary,
  type ModelManifest,
  newId,
} from "@openfield/core";
import { createByteplusProvider } from "../src/byteplus";
import layersText from "../src/byteplus/__fixtures__/seedream/layers-text.json";
import { BYTEPLUS_MODELS } from "../src/byteplus/models";
import { V55_TIER_PIXELS } from "../src/byteplus/pricing";
import { seedreamSpecFor } from "../src/byteplus/seedream";
import { toLayersBody, toSeedreamBody } from "../src/byteplus/seedream-request";
import {
  costOf,
  layerTextOf,
  type SeedreamResponse,
  toSeedreamResult,
} from "../src/byteplus/seedream-response";
import { chosenLayers, layerOutputs } from "../src/manifest";
import { estimate } from "../src/manifest/estimate";
import { normalize } from "../src/normalize";
import { createTestContext, MemoryAssetSink } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { encodeRgbaPng, gradientPng } from "../src/testing/png";
import type { ProviderError } from "../src/types";

// Seedream 5.5: the body it gets, its two pixel rates and $0.008 inputs, the most layers a split
// asks for (max_images counts the base), and the words it reads on text layers.

const V55 = "dola-seedream-5-5-261028";
const PRO = "dola-seedream-5-0-pro-260628";

const provider = createByteplusProvider();
const credentials = { apiKey: "test-ark-key" };
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

async function normalized(modelId: string, overrides: Partial<GenerateRequest> = {}) {
  return normalize(manifest(modelId), requestFor(modelId, overrides), {
    jobSetId: newId(),
    randomSeed: () => 7,
  });
}

async function call(modelId: string, overrides: Partial<GenerateRequest> = {}) {
  const result = await normalized(modelId, overrides);
  if (result.error) throw result.error;
  return result.calls[0]!;
}

const sizes = (w: number, h: number, n = 1) => Array.from({ length: n }, () => ({ width: w, height: h }));

function ctx(assets = new MemoryAssetSink()) {
  return createTestContext({ fetch: createFakeFetch({ delayMs: 0 }), credentials, assets });
}

/** The fixture with its image placeholders swapped for tiny real images. */
async function fixtureBody(): Promise<SeedreamResponse> {
  const png = Buffer.from(await gradientPng(8, 8, 3)).toString("base64");
  const rgba = new Uint8Array(4 * 4 * 4).fill(200);
  for (let p = 0; p < 16; p += 2) rgba[p * 4 + 3] = 0;
  const alpha = Buffer.from(await encodeRgbaPng(4, 4, rgba)).toString("base64");
  const text = JSON.stringify(layersText.response.body)
    .split('"<png>"')
    .join(JSON.stringify(png))
    .split('"<png-alpha>"')
    .join(JSON.stringify(alpha));
  return JSON.parse(text) as SeedreamResponse;
}

describe("the 5.5 model", () => {
  test("comes first among Seedream, with 10 inputs, PNG first, marks and no Fast or related sets", () => {
    const images = BYTEPLUS_MODELS.filter((m) => m.modality === "image");
    expect(images[0]?.displayName).toBe("Seedream 5.5");
    const m = manifest(V55);
    const caps = m.capabilities;
    expect(caps.references.max).toBe(10);
    expect(caps.output).toEqual({ formats: ["png", "jpeg"], default: "png" });
    expect(caps.resolution).toEqual({ tiers: ["1K", "1.5K", "2K"], default: "1.5K" });
    expect(caps.background).toEqual({ values: ["auto", "opaque", "transparent"], default: "auto" });
    expect(caps.marks?.kinds.length).toBeGreaterThan(0);
    expect(caps.batch.groupOption).toBeUndefined();
    expect(m.speeds).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain("Priority");
  });

  test("splits into up to 99 layers, 16 unless asked, and reads text; Pro and Flash stay at 16", () => {
    expect(manifest(V55).capabilities.layers).toMatchObject({
      maxLayers: 99,
      choose: { min: 1, default: 16 },
      text: true,
    });
    for (const id of [PRO, "dola-seedream-5-0-flash-260915"]) {
      const rules = manifest(id).capabilities.layers!;
      expect(rules.maxLayers).toBe(16);
      expect(rules.choose).toBeUndefined();
      expect(rules.text).toBeUndefined();
    }
  });
});

describe("the most layers", () => {
  const rules = () => manifest(V55).capabilities.layers;

  test("held to 1 to 99, 16 when unset, and nothing for models that pick for themselves", () => {
    expect(chosenLayers(rules(), undefined)).toBe(16);
    expect(chosenLayers(rules(), 0)).toBe(1);
    expect(chosenLayers(rules(), 40)).toBe(40);
    expect(chosenLayers(rules(), 250)).toBe(99);
    expect(chosenLayers(manifest(PRO).capabilities.layers, 40)).toBeUndefined();
  });

  test("normalize keeps the number on 5.5 and fills in 16; on Pro it's dropped with a warning", async () => {
    const decompose = { op: "decompose" as const, base: { assetId: newId(), role: "base" as const } };
    expect((await call(V55, decompose)).layers).toEqual({ size: "auto", maxLayers: 16 });
    expect((await call(V55, { ...decompose, layers: { size: "1K", maxLayers: 99 } })).layers).toEqual({
      size: "1K",
      maxLayers: 99,
    });
    const pro = await normalized(PRO, { ...decompose, layers: { maxLayers: 40 } });
    expect(pro.error).toBeUndefined();
    expect(pro.calls[0]?.layers).toEqual({ size: "auto" });
    expect(pro.diagnostics.map((d) => [d.level, d.field])).toContainEqual(["warning", "layers.maxLayers"]);
  });

  test("max_images is the number plus one, for the base; text_recognition is always on", async () => {
    const req = {
      ...(await call(V55)),
      promptAfterPreset: "",
      layers: { size: "2K" as const, maxLayers: 40 },
    };
    expect(toLayersBody(spec(V55), req, "data:image/png;base64,AA")).toEqual({
      model: V55,
      image: "data:image/png;base64,AA",
      layer_decomposition: true,
      layer_decomposition_options: { max_images: 41, text_recognition: true },
      size: "2K",
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
    });
    const unset = toLayersBody(spec(V55), { ...req, layers: { size: "auto" } }, "x");
    expect(unset.layer_decomposition_options).toEqual({ max_images: 17, text_recognition: true });
    const most = toLayersBody(spec(V55), { ...req, layers: { maxLayers: 99 } }, "x");
    expect(most.layer_decomposition_options?.max_images).toBe(100);
    // Never a background on a split, and Pro gets no options at all.
    expect("background" in unset).toBe(false);
    expect("layer_decomposition_options" in toLayersBody(spec(PRO), req, "x")).toBe(false);
  });
});

describe("the 5.5 request body", () => {
  test("PNG by default, no fast mode, no watermark", async () => {
    const req = await call(V55, { resolution: "2K" });
    const body = toSeedreamBody(spec(V55), req, { images: [] }, { fast: true });
    expect(body).toEqual({
      model: V55,
      prompt: "A paper boat on a puddle",
      size: "2496x1664",
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
    });
  });

  test("transparent from words alone, and Opaque is sent since 5.5's own default is auto", async () => {
    const assets = new MemoryAssetSink();
    const model = provider.model(manifest(V55).key);
    const words = await call(V55, { background: "transparent", output: { format: "jpeg" } });
    const update = await model.poll(await model.submit(words, ctx(assets)), ctx(assets));
    expect(update.state).toBe("succeeded");

    const transparent = toSeedreamBody(spec(V55), words, { images: [], transparent: true }, { fast: false });
    expect([transparent.background, transparent.output_format]).toEqual(["transparent", "png"]);
    const opaque = toSeedreamBody(spec(V55), words, { images: [], opaque: true }, { fast: false });
    expect(opaque.background).toBe("opaque");
  });

  test("transparent from several references with no alpha; Pro still needs one PNG with alpha", async () => {
    const assets = new MemoryAssetSink();
    const refs = [
      await assets.add(await gradientPng(1024, 1024, 1)),
      await assets.add(await gradientPng(1024, 1024, 2)),
    ];
    const overrides: Partial<GenerateRequest> = {
      background: "transparent",
      references: refs.map((assetId) => ({ assetId, role: "subject" as const })),
    };
    const v55 = provider.model(manifest(V55).key);
    const ok = await v55.poll(await v55.submit(await call(V55, overrides), ctx(assets)), ctx(assets));
    expect(ok.state).toBe("succeeded");
    const pro = provider.model(manifest(PRO).key);
    const err = await pro.submit(await call(PRO, overrides), ctx(assets)).catch((e: unknown) => e);
    expect((err as ProviderError).field).toBe("background");
  });
});

describe("5.5 prices", () => {
  const price = () => manifest(V55).price;

  test("$0.020 an image up to 2,601,123 pixels, $0.035 above, $0.008 for every input", () => {
    expect(V55_TIER_PIXELS).toBe(2_601_123);
    const one = (w: number, h: number, inputs = 0) =>
      costOf(price(), sizes(w, h), { inputImages: inputs, layered: false })?.amount;
    expect(one(1536, 1536)).toBe(0.02);
    expect(one(2352, 1008)).toBe(0.02);
    expect(one(2048, 2048)).toBe(0.035);
    expect(
      costOf(price(), [{ width: 1, height: V55_TIER_PIXELS }], { inputImages: 0, layered: false })?.amount,
    ).toBe(0.02);
    expect(
      costOf(price(), [{ width: 1, height: V55_TIER_PIXELS + 1 }], { inputImages: 0, layered: false })
        ?.amount,
    ).toBe(0.035);
    // No free first image, unlike Pro.
    expect(one(1024, 1024, 1)).toBe(0.028);
    expect(one(1024, 1024, 3)).toBe(0.044);
  });

  test("a split bills each image made at its own size, plus the image sent in", () => {
    // A 2K base, two small layers and one large one, one image in.
    const amount = costOf(price(), [...sizes(2048, 2048), ...sizes(400, 300, 2), ...sizes(2000, 1500)], {
      inputImages: 1,
      layered: true,
    })?.amount;
    expect(amount).toBe(0.118);
  });

  test("an estimate goes up to the most layers asked for, 16 when unset", () => {
    const base = { assetId: newId(), role: "base" as const };
    const at = (maxLayers?: number) =>
      estimate(manifest(V55), {
        op: "decompose",
        batch: 1,
        base,
        layers: { size: "2K", ...(maxLayers !== undefined && { maxLayers }) },
      });
    const unset = at();
    expect([unset.min, unset.max]).toEqual([0.078, 0.603]);
    expect(unset.basis).toContain("16");
    const forty = at(40);
    expect(forty.max).toBe(Math.round((0.035 * 41 + 0.008) * 1e6) / 1e6);
    expect(forty.basis).toContain("40");
    const one = at(1);
    expect([one.min, one.max]).toEqual([0.078, 0.078]);
    const most = at(99);
    expect(most.max).toBe(Math.round((0.035 * 100 + 0.008) * 1e6) / 1e6);
    // 1K is the lower rate on every image.
    const small = estimate(manifest(V55), { op: "decompose", batch: 1, base, layers: { size: "1K" } });
    expect(small.max).toBe(Math.round((0.02 * 17 + 0.008) * 1e6) / 1e6);
  });

  test("the outputs a split can bill follow the number; Pro's stay a base and 16", () => {
    const p = manifest(V55).price;
    if (p.kind !== "per_image") throw new Error("per_image");
    expect(layerOutputs(manifest(V55), p, { layers: { maxLayers: 5 } })).toEqual({ min: 2, max: 6 });
    expect(layerOutputs(manifest(V55), p, {})).toEqual({ min: 2, max: 17 });
    const pro = manifest(PRO).price;
    if (pro.kind !== "per_image") throw new Error("per_image");
    expect(layerOutputs(manifest(PRO), pro, { layers: { maxLayers: 5 } })).toEqual({ min: 2, max: 17 });
  });
});

describe("text on layers", () => {
  test("a text layer keeps its words, each line's box and each run's look", async () => {
    const result = await toSeedreamResult(
      await fixtureBody(),
      { batchIndex: 0, batch: 1, op: "decompose" },
      ctx(),
      {
        submittedAt: 0,
        price: manifest(V55).price,
        speed: "standard",
        model: "Seedream 5.5",
        inputsSent: 1,
        format: "png",
      },
    );
    const [base, words, lettering] = result.images;
    expect(base?.layer?.text).toBeUndefined();
    expect(lettering?.layer?.text).toBeUndefined();
    expect(words?.layer?.text).toEqual({
      text: "Presented By :\nAnna Katrina Marchesi",
      lines: [
        {
          box: [1196, 629, 1358, 658],
          boxGrid: [779, 307, 884, 321],
          runs: [
            {
              text: "Presented By :",
              style: {
                font: "Helvetica Neue",
                color: "#193366",
                bold: true,
                italic: false,
                underline: false,
                strikethrough: false,
                shadow: false,
                translucent: false,
              },
            },
          ],
        },
        {
          box: [1195, 651, 1427, 681],
          boxGrid: [778, 318, 929, 333],
          runs: [expect.objectContaining({ text: "Anna Katrina Marchesi" })],
        },
      ],
    });
    expect(layerOpParamsSchema.safeParse(words?.layer).success).toBe(true);
    expect(layerTextSummary(words?.layer?.text)).toEqual({
      text: "Presented By :\nAnna Katrina Marchesi",
      font: "Helvetica Neue",
      color: "#193366",
    });
    // Three images and the image sent in: a 1536 × 2048 base at $0.035, two small layers at $0.020.
    expect(result.cost?.amount).toBe(0.083);
  });

  test('"unknown" fonts and odd colours are left out, and empty text is no text', () => {
    const canvas = { width: 1000, height: 1000 };
    const text = layerTextOf(
      {
        text: "Sale",
        lines: [
          {
            bounding_box: { normalized: [100, 200, 300, 400] },
            runs: [{ text: "Sale", style: { similar_font_family: "unknown", foreground_color: "#ff8800" } }],
          },
        ],
      },
      canvas,
    );
    expect(text).toEqual({
      text: "Sale",
      lines: [
        {
          box: [100, 200, 300, 400],
          boxGrid: [100, 200, 300, 400],
          runs: [{ text: "Sale", style: { color: "#FF8800" } }],
        },
      ],
    });
    expect(layerTextOf({ text: "  ", lines: [] }, canvas)).toBeUndefined();
    expect(layerTextOf({ lines: [{ runs: [{ style: {} }] }] } as never, canvas)).toBeUndefined();
    expect(layerTextSummary({ text: "Sale", lines: [{ runs: [{ text: "Sale", style: {} }] }] })).toEqual({
      text: "Sale",
    });
  });

  test("a huge text is trimmed to what a layer stores, so the layer still reads back", () => {
    const run = { text: "x".repeat(LAYER_TEXT_MAX + 50), style: { similar_font_family: "F".repeat(500) } };
    const text = layerTextOf(
      {
        text: "y".repeat(LAYER_TEXT_MAX * 2),
        lines: Array.from({ length: LAYER_TEXT_LINES_MAX + 30 }, () => ({
          bounding_box: { absolute: [-5, 10, 99_999, 20] },
          runs: Array.from({ length: LAYER_TEXT_RUNS_MAX + 5 }, () => run),
        })),
      },
      { width: 2048, height: 2048 },
    )!;
    expect(text.text).toHaveLength(LAYER_TEXT_MAX);
    expect(text.lines).toHaveLength(LAYER_TEXT_LINES_MAX);
    expect(text.lines[0]!.runs).toHaveLength(LAYER_TEXT_RUNS_MAX);
    expect(text.lines[0]!.box).toEqual([0, 10, 65_536, 20]);
    const layer = { role: "layer", zIndex: 1, canvas: { width: 2048, height: 2048 }, text };
    expect(layerOpParamsSchema.safeParse(layer).success).toBe(true);
    expect(layerTextSummary(text)!.text.length).toBeLessThanOrEqual(300);
  });
});

describe("5.5 through the fake", () => {
  async function separation(maxLayers: number | undefined, prompt: string) {
    const assets = new MemoryAssetSink();
    const baseAssetId = await assets.add(await gradientPng(1024, 1024, 9));
    const req = await call(V55, {
      op: "decompose",
      base: { assetId: baseAssetId, role: "base" },
      layers: { size: "1K", ...(maxLayers !== undefined && { maxLayers }) },
      prompt,
    });
    const model = provider.model(manifest(V55).key);
    const update = await model.poll(await model.submit(req, ctx(assets)), ctx(assets));
    if (update.state !== "succeeded" || !update.result) throw new Error(update.state);
    return update.result;
  }

  test("more than 16 layers when asked, the top one with its words", async () => {
    const result = await separation(20, "#fake-layers:20");
    expect(result.images).toHaveLength(21);
    const top = result.images.at(-1)!;
    expect(top.layer?.zIndex).toBe(20);
    expect(layerTextSummary(top.layer?.text)).toMatchObject({ font: "Helvetica Neue", color: "#193366" });
    expect(result.images.filter((i) => i.layer?.text)).toHaveLength(1);
  });

  test("never more than max_images allows", async () => {
    expect((await separation(5, "#fake-layers:20")).images).toHaveLength(6);
    expect((await separation(undefined, "#fake-layers:40")).images).toHaveLength(17);
  });

  test("the fake refuses background on any split and the options on Pro", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const post = (body: Record<string, unknown>) =>
      fetch("https://ark.ap-southeast.bytepluses.com/api/v3/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer key", "content-type": "application/json" },
        body: JSON.stringify({
          image: "data:image/png;base64,AA",
          layer_decomposition: true,
          response_format: "b64_json",
          ...body,
        }),
      });
    expect((await post({ model: V55, background: "transparent" })).status).toBe(400);
    expect((await post({ model: PRO, background: "transparent" })).status).toBe(400);
    expect((await post({ model: PRO, layer_decomposition_options: { max_images: 5 } })).status).toBe(400);
    expect((await post({ model: V55, layer_decomposition_options: { max_images: 101 } })).status).toBe(400);
    expect((await post({ model: V55, layer_decomposition_options: { max_images: 1 } })).status).toBe(400);
  });
});

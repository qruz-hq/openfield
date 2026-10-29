import { describe, expect, test } from "bun:test";
import type { Capabilities, ModelManifest } from "@openfield/core";
import { GOOGLE_MODELS } from "../src/google/models";
import { estimate } from "../src/manifest/estimate";
import { isCoreControl, resolveControl, visibleControls } from "../src/manifest/resolve-control";
import { editSizeFor, fitPixels, nearestRatio, placeholderSize, resolveSize } from "../src/manifest/size";
import { normalize } from "../src/normalize";

const byId = (id: string) => GOOGLE_MODELS.find((m) => m.modelId === id)!;
const pro = byId("gemini-3-pro-image");
const flash = byId("gemini-3.1-flash-image");
const lite = byId("gemini-3.1-flash-lite-image");

const withCaps = (
  base: ModelManifest,
  caps: Partial<Capabilities>,
  price?: ModelManifest["price"],
): ModelManifest => ({
  ...base,
  capabilities: { ...base.capabilities, ...caps },
  ...(price && { price }),
});

describe("resolveSize", () => {
  test("long edge is the tier, short edge follows the ratio", () => {
    expect(resolveSize("3:4", "2K")).toEqual({ width: 1536, height: 2048 });
    expect(resolveSize("16:9", "1K")).toEqual({ width: 1024, height: 576 });
    expect(resolveSize("1:1", "512")).toEqual({ width: 512, height: 512 });
  });

  test("snaps down to the grid and clamps", () => {
    expect(resolveSize("21:9", "1.5K", { multipleOf: 16 })).toEqual({ width: 1536, height: 656 });
    expect(resolveSize("1:1", "4K", { maxEdge: 1536 })).toEqual({ width: 1536, height: 1536 });
  });

  test("nearestRatio picks the closest shape and skips auto", () => {
    expect(nearestRatio(1000, 1333, ["auto", "1:1", "3:4", "9:16"])).toBe("3:4");
    expect(nearestRatio(10, 10, ["auto"])).toBeUndefined();
  });

  test("placeholders follow the ratio at the model's default tier", () => {
    expect(placeholderSize(pro.capabilities, { aspect: "4:5" })).toEqual({ width: 819, height: 1024 });
    expect(placeholderSize(pro.capabilities, { width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
    });
  });
});

describe("editSizeFor", () => {
  const rules = { multipleOf: 16, maxEdge: 3840, maxRatio: 3, minPixels: 655_360, maxPixels: 8_294_400 };

  test("an aspect-only model gets the base's nearest shape, at the tier that covers it", () => {
    const tiers = pro.capabilities.resolution!.tiers;
    expect(editSizeFor(pro, { width: 1920, height: 1080 })).toEqual({
      size: { kind: "aspect", ratio: "16:9" },
      resolution: tiers.includes("2K") ? "2K" : tiers.at(-1),
    });
    expect(editSizeFor(pro, { width: 1000, height: 1000 }).resolution).toBe("1K");
    expect(editSizeFor(pro, { width: 9000, height: 9000 }).resolution).toBe(tiers.at(-1));
  });

  test("an exact-size model gets the base's own pixels, or the closest it takes", () => {
    const exact = withCaps(pro, {
      size: { ...pro.capabilities.size, pixels: rules } as Capabilities["size"],
    });
    expect(editSizeFor(exact, { width: 2048, height: 1152 }).size).toEqual({
      kind: "pixels",
      width: 2048,
      height: 1152,
    });
    expect(fitPixels(1920, 1080, rules)).toEqual({ width: 1920, height: 1088 });
    expect(fitPixels(4096, 4096, rules)).toEqual({ width: 2880, height: 2880 });
  });

  test("enum and free sizes pick the nearest listed shape, or the base's shape on the grid", () => {
    const listed = withCaps(pro, {
      size: {
        mode: "enum",
        sizes: [
          { width: 1024, height: 1024 },
          { width: 1536, height: 1024 },
          { width: 2400, height: 1600 },
          { width: 1024, height: 1536 },
        ],
        default: { width: 1024, height: 1024 },
        allowAuto: false,
      },
    });
    // Two sizes have the base's shape; the one nearer its pixel count wins.
    expect(editSizeFor(listed, { width: 3000, height: 2000 }).size).toEqual({
      kind: "pixels",
      width: 2400,
      height: 1600,
    });
    const free = withCaps(pro, {
      size: {
        mode: "free",
        minEdge: 256,
        maxEdge: 2048,
        multipleOf: 64,
        default: { width: 1024, height: 1024 },
      },
    });
    expect(editSizeFor(free, { width: 4000, height: 3000 }).size).toEqual({
      kind: "pixels",
      width: 2048,
      height: 1536,
    });
    expect(editSizeFor(free, { width: 100, height: 50 }).size).toEqual({
      kind: "pixels",
      width: 512,
      height: 256,
    });
  });

  test("normalize keeps a size the rules take, and snaps one they don't with a note", async () => {
    const exact = withCaps(pro, {
      size: { ...pro.capabilities.size, pixels: rules } as Capabilities["size"],
    });
    const run = (width: number, height: number) =>
      normalize(
        exact,
        {
          idempotencyKey: "01JABCDEFGHJKMNPQRSTVWXYZ0",
          model: exact.key,
          op: "generate",
          prompt: "A field",
          size: { kind: "pixels", width, height },
          batch: 1,
          source: "api",
        },
        { jobSetId: "01JABCDEFGHJKMNPQRSTVWXYZ1" },
      );
    const kept = await run(1920, 1088);
    expect(kept.request.size).toEqual({ width: 1920, height: 1088 });
    expect(kept.diagnostics).toEqual([]);
    const snapped = await run(1920, 1080);
    expect(snapped.request.size).toEqual({ width: 1920, height: 1088 });
    expect(snapped.diagnostics.map((d) => [d.field, d.level])).toEqual([["size", "warning"]]);
  });
});

describe("estimate", () => {
  test("per image, times the batch, from the manifest's own table", () => {
    expect(estimate(pro, { batch: 3, resolution: "2K" })).toEqual({
      currency: "USD",
      min: 0.402,
      max: 0.402,
      confidence: "exact",
      basis: "3 × $0.134 (2K)",
      pricedAt: "2026-09-23",
    });
    expect(estimate(flash, { batch: 1, resolution: "4K" }).min).toBe(0.151);
    expect(estimate(flash, { batch: 2, resolution: "512" }).min).toBe(0.09);
  });

  test("falls back to the model's default tier", () => {
    expect(estimate(lite, { batch: 2 }).min).toBe(0.0672);
    expect(estimate(pro, { batch: 1 }).min).toBe(0.134);
  });

  test("a tier with no row gives the whole range, not a guess", () => {
    const e = estimate(pro, { batch: 1, resolution: "512" });
    expect(e).toMatchObject({ min: 0.134, max: 0.24, confidence: "estimated" });
  });

  test("images sent in are billed on top at Google's fixed count, once per image made", () => {
    // Pro: 560 tokens an image at $2 per 1M. Google makes a batch one call per image, so each call
    // reads them again.
    const each = (560 * 2) / 1e6;
    const one = estimate(pro, { batch: 1, resolution: "1K", inputImages: 4 });
    expect(one.min).toBeCloseTo(0.134 + 4 * each, 6);
    expect(one).toMatchObject({
      max: one.min,
      confidence: "estimated",
      basis: "1 × $0.134 (1K) + 4 reference images ($0.004)",
    });
    expect(estimate(pro, { batch: 2, resolution: "1K", inputImages: 1 }).min).toBeCloseTo(
      2 * (0.134 + each),
      6,
    );
    // Nano Banana 2: 1,120 tokens at $0.50, and Batch halves it like the output.
    expect(estimate(flash, { batch: 1, resolution: "1K", inputImages: 1 }).min).toBeCloseTo(
      0.067 + 0.00056,
      6,
    );
    expect(estimate(flash, { batch: 1, resolution: "1K", inputImages: 1, speed: "batch" }).min).toBeCloseTo(
      0.034 + 0.00028,
      6,
    );
    // A request carries its own: its references and an edit's base.
    const request = {
      batch: 1,
      resolution: "1K" as const,
      references: [{ assetId: "01K6BQ80000000000000AS0001", role: "subject" as const }],
      base: { assetId: "01K6BQ80000000000000AS0002", role: "base" as const },
    };
    expect(estimate(pro, request).min).toBeCloseTo(0.134 + 2 * each, 6);
    // None sent in: the price is exact, as before.
    expect(estimate(pro, { batch: 1, resolution: "1K" }).confidence).toBe("exact");
  });

  test("unknown prices say so", () => {
    const e = estimate(withCaps(pro, {}, { kind: "unknown" }), { batch: 2 });
    expect(e).toMatchObject({ confidence: "unknown", min: 0, max: 0, pricedAt: "" });
    expect(e.basis).toBe("Cost unknown");
  });

  test("token prices give a range across the table", () => {
    const tokenPriced = withCaps(
      pro,
      {
        quality: {
          levels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          default: "high",
        },
      },
      {
        kind: "per_token",
        currency: "USD",
        pricedAt: "2026-09-23",
        sourceUrl: "https://example.com/pricing",
        textInputPerMTok: 5,
        imageInputPerMTok: 8,
        imageOutputPerMTok: 30,
        outputTokenTable: [
          { quality: "high", size: "1024x1024", tokens: 4000 },
          { quality: "high", size: "1024x1536", tokens: 6000 },
          { quality: "low", size: "1024x1024", tokens: 300 },
        ],
      },
    );
    const exact = estimate(tokenPriced, { batch: 1, size: { width: 1024, height: 1024 }, prompt: "" });
    expect(exact).toMatchObject({ min: 0.12, max: 0.12, confidence: "estimated" });
    const range = estimate(tokenPriced, { batch: 2, size: { aspect: "auto" }, prompt: "" });
    expect(range).toMatchObject({ min: 0.24, max: 0.36 });
  });
});

describe("resolveControl", () => {
  test("Gemini: aspect and resolution supported, batch and Avoid emulated, seed disabled with a reason", () => {
    const caps = pro.capabilities;
    expect(resolveControl(caps, "aspect")).toMatchObject({ state: "supported", default: "auto" });
    expect(resolveControl(caps, "aspect").options).toEqual(
      caps.size.mode === "aspect" ? caps.size.ratios : [],
    );
    expect(resolveControl(caps, "resolution")).toMatchObject({
      state: "supported",
      options: ["1K", "2K", "4K"],
    });
    expect(resolveControl(caps, "batch")).toMatchObject({ state: "emulated", max: 4, options: [1, 2, 3, 4] });
    expect(resolveControl(caps, "negativePrompt").state).toBe("emulated");
    expect(resolveControl(caps, "seed")).toEqual({
      state: "unsupported",
      reason: "Nano Banana Pro doesn't support seeds.",
    });
    expect(resolveControl(caps, "promptEnhance")).toMatchObject({ state: "supported", mode: "openfield" });
    expect(resolveControl(caps, "advanced")).toMatchObject({ state: "supported", options: ["grounding"] });
  });

  test("absent controls stay out of the DOM", () => {
    for (const id of [
      "quality",
      "background",
      "size",
      "outputFormat",
      "moderation",
      "referenceStrength",
    ] as const) {
      expect(resolveControl(pro.capabilities, id).state).toBe("absent");
    }
  });

  test("Nano Banana 2 Lite shows its single size, disabled, with a reason", () => {
    expect(resolveControl(lite.capabilities, "resolution")).toMatchObject({
      state: "unsupported",
      options: ["1K"],
      default: "1K",
      reason: "Nano Banana 2 Lite makes 1K images only.",
    });
  });

  test("partial marks the unavailable options", () => {
    const caps = { ...pro.capabilities, partial: { aspect: { unavailable: ["21:9"], reason: "Not at 4K" } } };
    expect(resolveControl(caps, "aspect")).toMatchObject({
      state: "partial",
      unavailable: ["21:9"],
      reason: "Not at 4K",
    });
  });

  test("a model without seeds and without a written reason still explains itself", () => {
    const caps = { ...pro.capabilities, unsupported: {} };
    expect(resolveControl(caps, "seed").state).toBe("unsupported");
    expect(resolveControl(caps, "seed").reason).toBeTruthy();
  });

  test("the core set never disappears; other unsupported controls do", () => {
    expect(isCoreControl("seed")).toBe(true);
    expect(isCoreControl("negativePrompt")).toBe(false);
    const caps = {
      ...pro.capabilities,
      unsupported: { ...pro.capabilities.unsupported, negativePrompt: { reason: "No Avoid field." } },
    };
    const ids = visibleControls(caps).map((c) => c.id);
    expect(ids).toContain("seed");
    expect(ids).not.toContain("negativePrompt");
  });
});

// §6.3 acceptance: the observed chips, in the observed order, nothing missing, nothing added.
// Openfield's own controls are compared separately, as the PRD says.
describe("parity with the observed chip row", () => {
  const OPENFIELD_ONLY = new Set([
    "model",
    "advanced",
    "negativePrompt",
    "seed",
    "referenceStrength",
    "palette",
    "promptEnhance",
  ]);
  const chips = (m: ModelManifest) =>
    visibleControls(m.capabilities)
      .filter((c) => !OPENFIELD_ONLY.has(c.id))
      .map((c) => `${c.id}${c.state === "supported" ? "" : `:${c.state}`}`);

  test("nano-banana-pro: Aspect · Resolution · 1/4", () => {
    expect(chips(pro)).toEqual(["aspect", "resolution", "batch:emulated"]);
  });

  test("nano-banana-2: Aspect · Resolution · 1/4", () => {
    expect(chips(flash)).toEqual(["aspect", "resolution", "batch:emulated"]);
  });

  test("Openfield's own chips on Gemini: Enhance, Seed disabled, Avoid and Advanced", () => {
    const own = visibleControls(pro.capabilities)
      .filter((c) => OPENFIELD_ONLY.has(c.id))
      .map((c) => `${c.id}:${c.state}`);
    expect(own).toEqual([
      "model:supported",
      "promptEnhance:supported",
      "seed:unsupported",
      "negativePrompt:emulated",
      "advanced:supported",
    ]);
  });

  test("the composer design's order: model, aspect, size, Enhance, batch", () => {
    const order = visibleControls(pro.capabilities).map((c) => c.id);
    expect(order.slice(0, 5)).toEqual(["model", "aspect", "resolution", "promptEnhance", "batch"]);
  });
});

import { describe, expect, test } from "bun:test";
import type { Capabilities, ModelManifest } from "@openfield/core";
import { GOOGLE_MODELS } from "../src/google/models";
import { estimate } from "../src/manifest/estimate";
import { isCoreControl, resolveControl, visibleControls } from "../src/manifest/resolve-control";
import { nearestRatio, placeholderSize, resolveSize } from "../src/manifest/size";

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

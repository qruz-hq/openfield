// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import {
  type CostEstimate,
  costParts,
  editBodySchema,
  estimateBodySchema,
  generateBodySchema,
  type ModelListItem,
} from "@openfield/core";
import {
  type AskPrice,
  carryValues,
  editBody,
  editedSize,
  editOpFor,
  editState,
  estimate,
  estimateRun,
  expectedSize,
  generateBody,
  generateState,
  type PriceAsk,
  qualityLabel,
  referenceInputsFor,
  resolveValues,
  runSpeed,
} from "@openfield/providers/manifest";
import { banana, flare, flareEdit, lite, pro, speedSettings } from "./fixtures";

const labels = { quality: qualityLabel };
const ULID = "01K6BQ8000000000000000ZZZZ";

describe("resolveValues", () => {
  test("uses the person's choice when the model has it, else the model's default", () => {
    expect(resolveValues(banana.capabilities, { aspect: "3:4", resolution: "2K" }, 2)).toEqual({
      aspect: "3:4",
      resolution: "2K",
      batch: 2,
    });
    expect(resolveValues(banana.capabilities, { aspect: "2:3", resolution: "1.5K" }, 9)).toEqual({
      aspect: "auto",
      resolution: "1K",
      batch: 4,
    });
  });

  test("the saved default aspect applies when nothing is picked", () => {
    expect(resolveValues(banana.capabilities, {}, 1, "4:5").aspect).toBe("4:5");
    expect(resolveValues(flare.capabilities, {}, 1, "4:5").aspect).toBe("1:1");
  });

  test("quality falls back to the model default", () => {
    expect(resolveValues(flare.capabilities, { quality: "ultra" }, 1).quality).toBe("medium");
  });
});

describe("carryValues", () => {
  test("carries what exists, clamps the rest to the nearest shape and never a bigger size", () => {
    const out = carryValues(
      flare.capabilities,
      { aspect: "4:5", resolution: "4K" },
      2,
      labels,
      banana.capabilities,
    );
    expect(out.values).toEqual({ aspect: "2:3", resolution: "1.5K" });
    expect(out.adjusted).toEqual([
      { from: "4:5", to: "2:3" },
      { from: "4K", to: "1.5K" },
    ]);
  });

  test("unset values keep following the new model's default", () => {
    expect(carryValues(flare.capabilities, {}, 1, labels, banana.capabilities)).toEqual({
      values: {},
      batch: 1,
      adjusted: [],
    });
  });

  test("quality keeps its relative place, rounding down", () => {
    const fromCaps = flare.capabilities;
    const toCaps = {
      ...flare.capabilities,
      quality: {
        levels: [
          { id: "std", label: "Standard" },
          { id: "hd", label: "HD" },
        ],
        default: "std",
      },
    };
    const out = carryValues(toCaps, { quality: "high" }, 1, labels, fromCaps);
    expect(out.values.quality).toBe("std");
    expect(out.adjusted).toEqual([{ from: "High", to: "Standard" }]);
  });
});

describe("requests", () => {
  test("the body matches the POST /api/generate schema and never mints a seed", () => {
    const resolved = resolveValues(banana.capabilities, { aspect: "3:4", resolution: "2K" }, 2);
    const body = generateBody(banana, resolved, "  a teapot  ", ULID);
    expect(generateBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      model: "google:banana",
      prompt: "a teapot",
      size: { kind: "aspect", ratio: "3:4" },
      resolution: "2K",
      batch: 2,
      seed: null,
      source: "composer",
    });
  });

  test("auto sends no shape, and placeholders guess a square", () => {
    const resolved = resolveValues(banana.capabilities, {}, 1);
    expect(generateBody(banana, resolved, "x", ULID).size).toEqual({ kind: "auto" });
    expect(expectedSize(banana.capabilities, resolved)).toEqual({ width: 1024, height: 1024 });
    expect(expectedSize(banana.capabilities, { ...resolved, aspect: "3:4", resolution: "2K" })).toEqual({
      width: 1536,
      height: 2048,
    });
  });
});

describe("references", () => {
  const REF1 = "01K6BQ8000000000000000REF1";
  const REF2 = "01K6BQ8000000000000000REF2";

  test("caps to what the model takes, in $subject when it offers it", () => {
    expect(referenceInputsFor(banana.capabilities, [])).toEqual([]);
    expect(referenceInputsFor(banana.capabilities, [REF1, REF2])).toEqual([
      { assetId: REF1, role: "subject" },
      { assetId: REF2, role: "subject" },
    ]);
    const capped = { ...banana.capabilities, references: { ...banana.capabilities.references, max: 1 } };
    expect(referenceInputsFor(capped, [REF1, REF2])).toEqual([{ assetId: REF1, role: "subject" }]);
  });

  test("falls back to the model's first role when it doesn't offer $subject", () => {
    const styleOnly = {
      ...banana.capabilities,
      references: { ...banana.capabilities.references, roles: ["style" as const] },
    };
    expect(referenceInputsFor(styleOnly, [REF1])).toEqual([{ assetId: REF1, role: "style" }]);
  });

  test("a model that doesn't take references gets none", () => {
    const none = {
      ...banana.capabilities,
      references: { ...banana.capabilities.references, supported: false, max: 0 },
    };
    expect(referenceInputsFor(none, [REF1])).toEqual([]);
  });

  test("generateBody only sends references when there are any, and they pass the wire schema", () => {
    const resolved = resolveValues(banana.capabilities, {}, 1);
    expect(generateBody(banana, resolved, "x", ULID)).not.toHaveProperty("references");
    const withRefs = generateBody(
      banana,
      resolved,
      "x",
      ULID,
      referenceInputsFor(banana.capabilities, [REF1]),
    );
    expect(generateBodySchema.safeParse(withRefs).success).toBe(true);
    expect(withRefs.references).toEqual([{ assetId: REF1, role: "subject" }]);
  });
});

describe("generateState and cost", () => {
  const resolved = resolveValues(banana.capabilities, {}, 2);

  test("walks the states of the Generate button", () => {
    expect(generateState({ model: undefined, anyReady: false, prompt: "", resolved }).kind).toBe("no-key");
    expect(generateState({ model: flare, anyReady: true, prompt: "x", resolved }).kind).toBe("needs-key");
    expect(generateState({ model: banana, anyReady: true, prompt: "  ", resolved }).kind).toBe("blocked");
    expect(generateState({ model: banana, anyReady: true, prompt: "a teapot", resolved }).kind).toBe("ready");
  });

  test("the estimate scales with the batch and reads like the design", () => {
    const one = estimateRun(banana, { ...resolved, batch: 1 }, "");
    const two = estimateRun(banana, resolved, "");
    expect(two.max).toBeCloseTo(one.max * 2);
    expect(costParts(two)).toEqual({ kind: "amount", amount: "$0.27", range: false });
    expect(costParts(estimateRun(flare, resolveValues(flare.capabilities, {}, 1), ""))).toEqual({
      kind: "unknown",
      text: "Cost unknown",
    });
    expect(costParts({ currency: "USD", min: 0.12, max: 0.19, confidence: "estimated" })).toEqual({
      kind: "amount",
      amount: "$0.12–0.19",
      range: true,
    });
  });

  test("a Batch price under a dime reads as half, like the settings and the tooltip", () => {
    const one = resolveValues(lite.capabilities, {}, 1);
    expect(costParts(estimateRun(lite, one, ""))).toMatchObject({ amount: "$0.034" });
    const batch = estimateRun(lite, one, "", "batch");
    expect(costParts(batch)).toMatchObject({ amount: "$0.017" });
    expect(batch.basis).toContain("$0.017");
  });
});

describe("edits", () => {
  const BASE = "01K6BQ8000000000000000BASE";
  const MASK = "01K6BQ8000000000000000MASK";
  const REF = "01K6BQ8000000000000000REF1";
  // A 3:4 photo, larger than 1K.
  const base = { assetId: BASE, width: 1152, height: 1536 };
  const masked = { base, masked: true };
  const flareTwo = resolveValues(flareEdit.capabilities, {}, 2);
  const bananaTwo = resolveValues(banana.capabilities, {}, 2);

  test("Flare takes the mask; Nano Banana redraws the whole image", () => {
    expect(editOpFor(flareEdit.capabilities, true)).toBe("inpaint");
    expect(editOpFor(banana.capabilities, true)).toBe("edit");
    expect(editOpFor(flareEdit.capabilities, false)).toBe("edit");
  });

  test("the body keeps the base's shape at the tier picked, and passes POST /api/edit's schema", () => {
    const mask = { assetId: MASK, composite: true, expandPx: 4, featherPx: 8 };
    const body = editBody(flareEdit, flareTwo, "  pale dried berries ", ULID, { base, mask });
    expect(editBodySchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      idempotencyKey: ULID,
      model: "openai:flare-edit",
      op: "inpaint",
      prompt: "pale dried berries",
      // 1152 × 1536 scaled to a 1K long edge, on OpenAI's 16px grid.
      size: { kind: "pixels", width: 768, height: 1024 },
      resolution: "1K",
      quality: "medium",
      batch: 2,
      seed: null,
      source: "detail_editor",
      base: { assetId: BASE, role: "base" },
      mask,
    });

    // Nano Banana takes ratios only: the base's own, whatever the composer's aspect was.
    const wide = { ...bananaTwo, aspect: "16:9" as const, resolution: "2K" as const };
    const references = referenceInputsFor(banana.capabilities, [REF]);
    const onBanana = editBody(banana, wide, "x", ULID, { base, mask, references });
    expect(editBodySchema.safeParse(onBanana).success).toBe(true);
    expect(onBanana).toMatchObject({
      op: "inpaint",
      size: { kind: "aspect", ratio: "3:4" },
      resolution: "2K",
      references: [{ assetId: REF, role: "subject" }],
    });
    expect(onBanana).not.toHaveProperty("quality");
    expect(editBody(banana, bananaTwo, "x", ULID, { base })).toMatchObject({ op: "edit" });
    expect(editBody(banana, bananaTwo, "x", ULID, { base })).not.toHaveProperty("mask");
  });

  test("Flare is priced at the size it's sent, with the base read at the base's own size", () => {
    const cost = estimateRun(flareEdit, flareTwo, "", "standard", { edit: masked });
    expect(cost).toEqual(
      estimate(flareEdit, {
        op: "inpaint",
        batch: 2,
        resolution: "1K",
        quality: "medium",
        size: { width: 768, height: 1024 },
        speed: "standard",
        prompt: "",
        base: { assetId: BASE, role: "base" },
        inputImageSizes: [{ width: 1152, height: 1536 }],
      }),
    );
    // Both sizes are known, so it's one amount rather than a range.
    expect(cost.min).toBe(cost.max);
    // The base counts as an image read once for the whole batch, and the tooltip says what it is.
    expect(cost.basis).toBe("2 × $0.009 + the image you're editing ($0.012)");
    expect(cost.max).toBeCloseTo(2 * ((301 * 30) / 1e6) + (1452 * 8) / 1e6, 9);
  });

  test("references sent with an edit are named as references, after the base", () => {
    const cost = estimateRun(flareEdit, flareTwo, "", "standard", { edit: masked, inputImages: 2 });
    expect(cost.basis).toStartWith("2 × $0.009 + the image you're editing and 2 reference images (");
    expect(cost.min).toBeLessThan(cost.max);
  });

  test("Nano Banana is priced by the base's shape at the tier picked", () => {
    const at1K = estimateRun(banana, bananaTwo, "", "standard", { edit: masked });
    expect(costParts(at1K)).toMatchObject({ amount: "$0.27" });
    const at4K = estimateRun(banana, { ...bananaTwo, resolution: "4K" }, "", "standard", { edit: masked });
    expect(at4K.max).toBeCloseTo(2 * 0.24, 9);
  });

  test("a price asked of the company names the base, so the server reads its size", () => {
    const asks: PriceAsk[] = [];
    const quote: CostEstimate = {
      currency: "USD",
      min: 0.01,
      max: 0.01,
      confidence: "estimated",
      basis: "2 × $0.005",
      pricedAt: "2026-09-27",
    };
    const ask: AskPrice = (_model, asked) => {
      asks.push(asked);
      return quote;
    };
    const perRequest: ModelListItem = {
      ...flareEdit,
      price: {
        kind: "provider_estimate",
        currency: "USD",
        pricedAt: "2026-09-27",
        sourceUrl: "https://example.com/prices",
      },
    };
    expect(estimateRun(perRequest, flareTwo, "x", "standard", { edit: masked }, ask)).toBe(quote);
    expect(asks).toEqual([
      {
        op: "inpaint",
        batch: 2,
        size: { kind: "pixels", width: 768, height: 1024 },
        resolution: "1K",
        quality: "medium",
        base: { assetId: BASE, role: "base" },
      },
    ]);
    expect(estimateBodySchema.safeParse(asks[0]).success).toBe(true);
  });

  test("a speed that only makes new images runs an edit at Standard", () => {
    const batchForNewOnly: ModelListItem = {
      ...pro,
      speeds: pro.speeds!.map((s) => (s.id === "batch" ? { ...s, ops: ["generate" as const] } : s)),
    };
    const settings = speedSettings({ speed: "batch" });
    expect(runSpeed(settings, batchForNewOnly)).toMatchObject({ speed: "batch", fellBack: false });
    expect(runSpeed(settings, batchForNewOnly, "edit")).toMatchObject({
      speed: "standard",
      requested: "batch",
      fellBack: true,
    });
    // Pro's Batch takes edits too.
    expect(runSpeed(settings, pro, "edit")).toMatchObject({ speed: "batch", fellBack: false });
  });

  test("placeholders take the base's size when the rest of the image is kept", () => {
    expect(editedSize(flareEdit, flareTwo, { ...masked, composite: true })).toEqual({
      width: 1152,
      height: 1536,
    });
    expect(editedSize(flareEdit, flareTwo, { ...masked, composite: false })).toEqual({
      width: 768,
      height: 1024,
    });
    expect(editedSize(banana, bananaTwo, { ...masked, composite: false })).toEqual({
      width: 768,
      height: 1024,
    });
  });

  test("walks the states of the Edit tab's Generate button", () => {
    const state = (over: Partial<Parameters<typeof editState>[0]>) =>
      editState({
        model: flareEdit,
        anyReady: true,
        prompt: "pale dried berries",
        resolved: flareTwo,
        edit: masked,
        ...over,
      });
    expect(state({ model: undefined, anyReady: false }).kind).toBe("no-key");
    expect(state({ model: { ...flareEdit, ready: false } }).kind).toBe("needs-key");
    // A model that can't edit at all counts as none picked.
    const textOnly: ModelListItem = {
      ...banana,
      capabilities: { ...banana.capabilities, ops: { ...banana.capabilities.ops, imageEdit: false } },
    };
    expect(state({ model: textOnly })).toEqual({ kind: "blocked", reason: "Pick a model first." });

    const price = estimateRun(flareEdit, flareTwo, "pale dried berries", "standard", { edit: masked });
    // The area comes first, then the words (design f90S4YuAoH, GBehrlQZ5o).
    expect(state({ edit: { base, masked: false }, prompt: "" })).toEqual({
      kind: "blocked",
      reason: "Paint over the part you want to change.",
      estimate: estimateRun(flareEdit, flareTwo, "", "standard", { edit: { base, masked: false } }),
    });
    expect(state({ prompt: "  " })).toMatchObject({ kind: "blocked", reason: "Describe the change." });
    expect(state({})).toEqual({ kind: "ready", estimate: price });
    // On Nano Banana the price is the whole-image edit's.
    expect(state({ model: banana, resolved: bananaTwo })).toMatchObject({
      kind: "ready",
      estimate: { max: 0.268 },
    });
  });
});

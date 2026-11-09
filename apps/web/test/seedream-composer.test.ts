// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type ModelListItem,
  type SelectSettingField,
  type SpeedOffer,
  setFormatLocale,
} from "@openfield/core";
import { generateBody, generateState, resolveValues } from "@openfield/providers/manifest";
import { relatedSetPlan, withinSet } from "../src/image/composer/related-set";
import {
  optionAvailability,
  optionPriceRange,
  speedChangesPrice,
  standardOnlyNote,
} from "../src/lib/provider-settings";
import { lite, pro, sketcher, speedSettings } from "./fixtures";

beforeAll(() => setFormatLocale("en-US"));

// Seedream-like models: Lite makes related sets, within "inputs plus outputs at most 15".
const setMaker: ModelListItem = {
  ...sketcher,
  capabilities: {
    ...sketcher.capabilities,
    references: { ...sketcher.capabilities.references, maxInputsAndOutputs: 15 },
  },
};

const fast = (usd: number): SpeedOffer => ({
  id: "priority",
  label: "Fast",
  price: {
    kind: "per_image",
    currency: "USD",
    pricedAt: "2026-11-09",
    sourceUrl: "https://example.com/prices",
    tiers: [{ usd }],
  },
  delivery: "sync",
  waitMs: { target: 10_000, max: 60_000 },
});

const seedream = (id: string, name: string, usd: number, withFast: boolean): ModelListItem => ({
  ...sketcher,
  key: `byteplus:${id}`,
  modelId: id,
  displayName: name,
  family: "Seedream",
  price: { ...(sketcher.price as Extract<ModelListItem["price"], { kind: "per_image" }>), tiers: [{ usd }] },
  ...(withFast && { speeds: [fast(usd)] }),
});

const byteplus = [
  seedream("pro", "Seedream 5.0 Pro", 0.045, true),
  seedream("flash", "Seedream 5.0 Flash", 0.018, false),
  seedream("lite", "Seedream 5.0 Lite", 0.035, false),
  seedream("4-5", "Seedream 4.5", 0.04, false),
  seedream("4-0", "Seedream 4.0", 0.03, true),
];

// BytePlus's Speed field: for the Seedream models only, Fast at Standard's price.
const byteplusSpeed: SelectSettingField = {
  id: "speed",
  kind: "select",
  role: "speed",
  label: "Speed",
  default: "standard",
  models: byteplus.map((m) => m.key),
  options: [
    { value: "standard", label: "Standard" },
    { value: "priority", label: "Fast", speed: "priority" },
  ],
};
const seedance: ModelListItem = { ...sketcher, key: "byteplus:seedance", displayName: "Seedance 2.0" };

describe("related set", () => {
  test("off, the run sends nothing extra and the count is exact", () => {
    const plan = relatedSetPlan(setMaker, undefined, []);
    expect(plan).toMatchObject({ option: "relatedSet", on: false, providerOptions: undefined, note: null });
    const resolved = resolveValues(setMaker.capabilities, {}, 4);
    const body = generateBody(
      setMaker,
      withinSet(resolved, plan),
      "a storyboard",
      "k",
      [],
      plan.providerOptions,
    );
    expect(body.providerOptions).toBeUndefined();
    const state = generateState({ model: setMaker, anyReady: true, prompt: "x", resolved });
    expect(state.kind === "ready" && state.estimate).toMatchObject({ min: 0.14, max: 0.14 });
  });

  test("on, the run sends the switch and is priced up to the count", () => {
    const plan = relatedSetPlan(setMaker, { relatedSet: true }, []);
    expect(plan.providerOptions).toEqual({ relatedSet: true });
    expect(plan.max).toBeUndefined();
    const resolved = resolveValues(setMaker.capabilities, {}, 4);
    const body = generateBody(setMaker, resolved, "a storyboard", "k", [], plan.providerOptions);
    expect(body.providerOptions).toEqual({ relatedSet: true });
    const state = generateState({
      model: setMaker,
      anyReady: true,
      prompt: "x",
      resolved,
      ...(plan.providerOptions && { providerOptions: plan.providerOptions }),
    });
    if (state.kind !== "ready" || !state.estimate) throw new Error("expected a price");
    expect(state.estimate).toMatchObject({ min: 0.035, max: 0.14 });
    expect(state.estimate.basis).toBe("Up to 4 × $0.035, only for the images it makes");
  });

  test("the images sent in leave less room, and the composer says why", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `ref-${i}`);
    const plan = relatedSetPlan(setMaker, { relatedSet: true }, refs);
    expect(plan.max).toBe(3);
    expect(plan.note).toBe("Sketcher makes at most 15 images in a set, counting the images you send in.");
    expect(withinSet(resolveValues(setMaker.capabilities, {}, 4), plan).batch).toBe(3);
    // Only the references the model takes count.
    const many = Array.from({ length: 20 }, (_, i) => `ref-${i}`);
    expect(relatedSetPlan(setMaker, { relatedSet: true }, many).max).toBe(1);
  });

  test("a model without related sets has no switch", () => {
    expect(relatedSetPlan(pro, { relatedSet: true }, []).option).toBeUndefined();
    expect(relatedSetPlan(undefined, undefined, []).on).toBe(false);
  });
});

describe("BytePlus speed panel", () => {
  test("Fast names its models once, without the family", () => {
    const fastOption = byteplusSpeed.options[1]!;
    expect(optionAvailability(byteplusSpeed, fastOption, [...byteplus, seedance])).toBe(
      "5.0 Pro and 4.0 only",
    );
  });

  test("a speed at Standard's price shows no prices", () => {
    expect(speedChangesPrice(byteplusSpeed, byteplus)).toBe(false);
    // Google's Flex, Batch and Priority each cost something else, so its cards keep theirs.
    const google = speedSettings().schema.panels[0]!.fields[0] as SelectSettingField;
    expect(speedChangesPrice(google, [pro, lite])).toBe(true);
    expect(optionPriceRange(google, google.options[1]!, [pro, lite])).toBeDefined();
  });

  test("says which models always run at Standard, leaving out the ones the field isn't for", () => {
    expect(standardOnlyNote(byteplusSpeed, [...byteplus, seedance])).toBe(
      "Seedream 5.0 Flash, 5.0 Lite, and 4.5 always use Standard.",
    );
  });

  test("another company's names stay whole", () => {
    const google = speedSettings().schema.panels[0]!.fields[0] as SelectSettingField;
    expect(optionAvailability(google, google.options[1]!, [pro, lite])).toBe("Nano Banana Pro only");
  });
});

// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { costParts, generateBodySchema } from "@openfield/core";
import {
  carryValues,
  estimateRun,
  expectedSize,
  generateBody,
  generateState,
  qualityLabel,
  resolveValues,
} from "../src/lib/controls";
import { banana, flare } from "./fixtures";

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
});

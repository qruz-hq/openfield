// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { alignResult, FIX_MODEL, FIX_NONE, FIX_ORIGINAL } from "@openfield/core";
import { FixLayer, hasFixes, lineUpTransform, outlinePath, withFixCodes } from "../src/detail/edit/fix-layer";

describe("FixLayer", () => {
  test("a stroke paints its brush's code along the way, and undo takes it back", () => {
    const layer = new FixLayer(40, 20);
    expect(layer.changed).toBe(false);
    layer.beginStroke("original", 4, { x: 5, y: 10 });
    layer.strokeTo({ x: 35, y: 10 });
    layer.endStroke();
    expect(layer.changed).toBe(true);
    // No gaps along a long move.
    for (let x = 5; x <= 34; x++) expect(layer.codes[10 * 40 + x]).toBe(FIX_ORIGINAL);
    expect(layer.codes[0]).toBe(FIX_NONE);

    layer.beginStroke("model", 6, { x: 20, y: 10 });
    layer.endStroke();
    expect(layer.codes[10 * 40 + 20]).toBe(FIX_MODEL);
    expect(layer.undo()).toBe(true);
    expect(layer.codes[10 * 40 + 20]).toBe(FIX_ORIGINAL);
    expect(layer.undo()).toBe(true);
    expect(hasFixes(layer.codes)).toBe(false);
    expect(layer.changed).toBe(false);
    expect(layer.undo()).toBe(false);
  });

  test("starts from the stored layer, and a dab past the edge stays inside", () => {
    const stored = new Uint8Array(16).fill(FIX_MODEL);
    const layer = new FixLayer(4, 4, stored);
    expect(layer.changed).toBe(false);
    expect(layer.beginStroke("original", 2, { x: -10, y: -10 })).toBeNull();
    layer.endStroke();
    expect(hasFixes(layer.codes)).toBe(true);
    expect(() => new FixLayer(4, 4, new Uint8Array(3))).toThrow(RangeError);
  });

  test("its codes go over smaller weights at the nearest pixel", () => {
    const layer = new FixLayer(8, 8);
    layer.beginStroke("original", 8, { x: 2, y: 2 });
    layer.endStroke();
    const weights = withFixCodes(new Uint8ClampedArray(16).fill(255), 4, 4, layer);
    expect(weights[0]).toBe(0);
    expect(weights[15]).toBe(255);
  });
});

describe("lineUpTransform", () => {
  test("draws the result where the server's alignResult reads it", () => {
    const width = 9;
    const height = 7;
    const lineUp = { dx: 1.5, dy: -0.75, scaleX: 1.1, scaleY: 0.95, confidence: 1 };
    const [a, , , d, e, f] = lineUpTransform(lineUp, width, height, 1);
    // Each output pixel's centre, back through the transform, lands on the result's pixel centre
    // that alignResult samples.
    for (const x of [0, 4, 8]) {
      const fromCanvas = (x + 0.5 - e) / a - 0.5;
      expect(fromCanvas).toBeCloseTo(lineUp.scaleX * (x - (width - 1) / 2) + (width - 1) / 2 + lineUp.dx, 6);
    }
    for (const y of [0, 3, 6]) {
      const fromCanvas = (y + 0.5 - f) / d - 0.5;
      expect(fromCanvas).toBeCloseTo(
        lineUp.scaleY * (y - (height - 1) / 2) + (height - 1) / 2 + lineUp.dy,
        6,
      );
    }
    // And alignResult itself agrees on a pixel moved by a whole step.
    const data = new Uint8Array(width * height);
    data[3 * width + 5] = 200;
    const moved = alignResult(
      { width, height, channels: 1, data },
      { dx: 1, dy: 0, scaleX: 1, scaleY: 1, confidence: 1 },
    );
    expect(moved[3 * width + 4]).toBe(200);
    const [, , , , shift] = lineUpTransform({ dx: 1, dy: 0, scaleX: 1, scaleY: 1 }, width, height, 1);
    expect(shift).toBeCloseTo(-1, 6);
  });

  test("none is a plain scale", () => {
    expect(lineUpTransform(null, 10, 10, 0.5)).toEqual([0.5, 0, 0, 0.5, 0, 0]);
  });
});

describe("outlinePath", () => {
  test("a square traces as one closed run", () => {
    const inside = new Uint8Array(25);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) inside[y * 5 + x] = 255;
    const path = outlinePath(inside, 5, 5);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.endsWith("Z")).toBe(true);
  });

  test("two areas apart are two runs, and nothing is no path", () => {
    const inside = new Uint8Array(30);
    inside[6 + 1] = 255;
    inside[6 * 3 + 4] = 255;
    expect(outlinePath(inside, 6, 5).match(/M/g)).toHaveLength(2);
    expect(outlinePath(new Uint8Array(9), 3, 3)).toBe("");
  });
});

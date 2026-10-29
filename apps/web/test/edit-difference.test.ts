// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { changeAlpha, compareSize, FULL_CHANGE, NOISE_FLOOR } from "../src/detail/edit/difference";

// The Difference view's mask, on raw RGBA: how much each pixel of a new image moved from the original.

const rgba = (...pixels: [number, number, number, number][]) => new Uint8ClampedArray(pixels.flat());
const alphas = (mask: Uint8ClampedArray) => Array.from(mask.filter((_, i) => i % 4 === 3));

describe("what changed", () => {
  test("the same pixels are clear, and the mask itself is white", () => {
    const image = rgba([10, 20, 30, 255], [200, 100, 50, 255]);
    const mask = changeAlpha(image, image.slice());
    expect(alphas(mask)).toEqual([0, 0]);
    expect(Array.from(mask.filter((_, i) => i % 4 !== 3))).toEqual([255, 255, 255, 255, 255, 255]);
  });

  test("the previews' own encoding noise doesn't count as a change", () => {
    const before = rgba([100, 100, 100, 255]);
    const after = rgba([100 + NOISE_FLOOR, 100 - NOISE_FLOOR, 100, 255]);
    expect(alphas(changeAlpha(before, after))).toEqual([0]);
  });

  test("a full change is opaque, and the feathered edge between ramps", () => {
    const before = rgba([0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]);
    const mid = Math.round((NOISE_FLOOR + FULL_CHANGE) / 2);
    const after = rgba([FULL_CHANGE, 0, 0, 255], [255, 255, 255, 255], [0, mid, 0, 255]);
    const [full, far, edge] = alphas(changeAlpha(before, after));
    expect(full).toBe(255);
    expect(far).toBe(255);
    expect(edge).toBeGreaterThan(100);
    expect(edge).toBeLessThan(155);
  });

  test("a change in one channel counts as much as one in all three", () => {
    const before = rgba([120, 120, 120, 255], [120, 120, 120, 255]);
    const after = rgba([120, 120, 160, 255], [160, 160, 160, 255]);
    const [hue, light] = alphas(changeAlpha(before, after));
    expect(hue).toBe(light);
  });

  test("two images of different sizes are refused", () => {
    expect(() => changeAlpha(rgba([0, 0, 0, 255]), rgba([0, 0, 0, 255], [0, 0, 0, 255]))).toThrow(RangeError);
  });
});

describe("the size it compares at", () => {
  test("the shown size, when the preview has the pixels", () => {
    expect(compareSize({ width: 1020, height: 1360 }, { width: 1080, height: 1440 })).toEqual({
      width: 1020,
      height: 1360,
    });
  });

  test("never more than the preview, keeping the shape", () => {
    expect(compareSize({ width: 2160, height: 2880 }, { width: 1080, height: 1440 })).toEqual({
      width: 1080,
      height: 1440,
    });
    expect(compareSize({ width: 3000, height: 1500 }, { width: 1440, height: 720 })).toEqual({
      width: 1440,
      height: 720,
    });
  });
});

// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  blendPixels,
  compositeSettingsOf,
  invertAlpha,
  isEmptyMask,
  luminanceToAlpha,
  MASK_CHANGE_BELOW,
  MASK_COMPOSITE_DEFAULTS,
  weightsFromAlpha,
} from "../src/image/mask";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A canonical mask: alpha 0 inside the rectangle (change), 255 everywhere else (keep). */
function rectAlpha(width: number, height: number, hole: Rect): Uint8Array {
  const alpha = new Uint8Array(width * height).fill(255);
  for (let y = hole.y; y < hole.y + hole.height; y++)
    alpha.fill(0, y * width + hole.x, y * width + hole.x + hole.width);
  return alpha;
}

/** Straight-line distance from a pixel centre to the nearest pixel centre inside the rectangle. */
function distanceToRect(x: number, y: number, r: Rect): number {
  const dx = x < r.x ? r.x - x : x >= r.x + r.width ? x - (r.x + r.width - 1) : 0;
  const dy = y < r.y ? r.y - y : y >= r.y + r.height ? y - (r.y + r.height - 1) : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** A seeded generator, so the irregular masks are the same on every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Raw pixels that differ from `noise` everywhere, so a copied byte is never a lucky match. */
function pixels(width: number, height: number, channels: number, seed: number): Uint8Array {
  const out = new Uint8Array(width * height * channels);
  const next = random(seed);
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(next() * 256);
  return out;
}

describe("composite settings", () => {
  test("a missing setting means on, expanded 4 px and feathered 8 px", () => {
    expect(MASK_COMPOSITE_DEFAULTS).toEqual({ composite: true, expandPx: 4, featherPx: 8 });
    expect(compositeSettingsOf()).toEqual({ composite: true, expandPx: 4, featherPx: 8 });
    expect(compositeSettingsOf({ composite: false, featherPx: 0 })).toEqual({
      composite: false,
      expandPx: 4,
      featherPx: 0,
    });
  });
});

describe("weightsFromAlpha", () => {
  test("all of the edit inside the expanded mask, none past expand plus feather", () => {
    const [width, height] = [160, 120];
    const hole = { x: 50, y: 40, width: 30, height: 20 };
    for (const opts of [
      { expandPx: 4, featherPx: 8 },
      { expandPx: 0, featherPx: 0 },
      { expandPx: 0, featherPx: 5 },
      { expandPx: 7, featherPx: 0 },
      { expandPx: 32, featherPx: 32 },
    ]) {
      const weights = weightsFromAlpha(rectAlpha(width, height, hole), width, height, opts);
      const reach = opts.expandPx + opts.featherPx;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const d = distanceToRect(x, y, hole);
          const w = weights[y * width + x]!;
          if (d <= opts.expandPx) expect(w).toBe(255);
          else if (d >= reach) expect(w).toBe(0);
        }
      }
    }
  });

  test("the share falls off with distance and never rises again", () => {
    const [width, height] = [100, 60];
    const hole = { x: 40, y: 20, width: 10, height: 10 };
    const weights = weightsFromAlpha(rectAlpha(width, height, hole), width, height, {
      expandPx: 3,
      featherPx: 12,
    });
    const byDistance = new Map<number, number>();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) byDistance.set(distanceToRect(x, y, hole), weights[y * width + x]!);
    const ordered = [...byDistance.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]![1]).toBeLessThanOrEqual(ordered[i - 1]![1]);
    // The feather is a real ramp, not a step.
    const inBand = ordered.filter(([d]) => d > 3 && d < 15).map(([, w]) => w);
    expect(inBand.some((w) => w > 0 && w < 255)).toBe(true);
  });

  test("matches a brute-force distance on irregular masks, corners and edges included", () => {
    const [width, height] = [57, 43];
    const next = random(7);
    for (let round = 0; round < 6; round++) {
      const alpha = new Uint8Array(width * height).fill(255);
      // A few scattered dots and a blob that touches the image edge.
      for (let i = 0; i < 6; i++) alpha[Math.floor(next() * alpha.length)] = 0;
      for (let y = 0; y < 5; y++) for (let x = width - 4; x < width; x++) alpha[y * width + x] = 0;
      const opts = { expandPx: round, featherPx: 2 + round * 2 };
      const reach = opts.expandPx + opts.featherPx;
      const weights = weightsFromAlpha(alpha, width, height, opts);
      const marked: [number, number][] = [];
      for (let i = 0; i < alpha.length; i++)
        if (alpha[i] === 0) marked.push([i % width, Math.floor(i / width)]);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const d = Math.min(...marked.map(([mx, my]) => Math.hypot(mx - x, my - y)));
          const w = weights[y * width + x]!;
          if (d <= opts.expandPx) expect(w).toBe(255);
          else if (d >= reach) expect(w).toBe(0);
          else {
            const t = (d - opts.expandPx) / opts.featherPx;
            expect(w).toBe(Math.round(255 * (1 - t * t * (3 - 2 * t))));
          }
        }
      }
    }
  });

  test("alpha below half marks a change; faint noise doesn't", () => {
    const alpha = new Uint8Array([255, MASK_CHANGE_BELOW - 1, MASK_CHANGE_BELOW, 250]);
    expect([...weightsFromAlpha(alpha, 4, 1, { expandPx: 0, featherPx: 0 })]).toEqual([0, 255, 0, 0]);
  });

  test("an empty mask changes nothing, a clear one changes everything", () => {
    const opts = { expandPx: 4, featherPx: 8 };
    expect(weightsFromAlpha(new Uint8Array(64).fill(255), 8, 8, opts).every((w) => w === 0)).toBe(true);
    expect(weightsFromAlpha(new Uint8Array(64), 8, 8, opts).every((w) => w === 255)).toBe(true);
  });

  test("refuses a mask of the wrong length or a negative setting", () => {
    expect(() => weightsFromAlpha(new Uint8Array(10), 4, 4, { expandPx: 0, featherPx: 0 })).toThrow(
      RangeError,
    );
    expect(() => weightsFromAlpha(new Uint8Array(16), 4, 4, { expandPx: -1, featherPx: 0 })).toThrow(
      RangeError,
    );
    expect(() => weightsFromAlpha(new Uint8Array(16), 4, 4, { expandPx: 0, featherPx: 1.5 })).toThrow(
      RangeError,
    );
  });
});

describe("blendPixels", () => {
  test("copies the original byte for byte where the weight is 0, the edit where it's 255", () => {
    for (const channels of [3, 4]) {
      const base = pixels(6, 1, channels, 1);
      const result = pixels(6, 1, channels, 2);
      const weights = new Uint8Array([0, 255, 128, 0, 1, 254]);
      const out = blendPixels(base, result, weights, channels);
      const px = (a: Uint8Array, p: number) => [...a.subarray(p * channels, (p + 1) * channels)];
      expect(px(out, 0)).toEqual(px(base, 0));
      expect(px(out, 3)).toEqual(px(base, 3));
      expect(px(out, 1)).toEqual(px(result, 1));
      for (let c = 0; c < channels; c++) {
        const i = 2 * channels + c;
        expect(out[i]).toBe(Math.round((base[i]! * 127 + result[i]! * 128) / 255));
      }
      // The original isn't touched.
      expect(base).toEqual(pixels(6, 1, channels, 1));
    }
  });

  test("works on 16-bit pixels too", () => {
    const base = new Uint16Array([0, 65_535, 1000, 1000]);
    const result = new Uint16Array([65_535, 0, 2000, 2000]);
    const out = blendPixels(base, result, new Uint8Array([0, 255, 0, 255]), 1);
    expect(out).toBeInstanceOf(Uint16Array);
    expect([...out]).toEqual([0, 0, 1000, 2000]);
  });

  test("refuses images of different sizes", () => {
    expect(() => blendPixels(new Uint8Array(12), new Uint8Array(9), new Uint8Array(4), 3)).toThrow(
      RangeError,
    );
    expect(() => blendPixels(new Uint8Array(12), new Uint8Array(12), new Uint8Array(3), 3)).toThrow(
      RangeError,
    );
  });

  // Acceptance criterion 1 on the math alone: at 2K and 4K, every pixel farther than expand plus
  // feather from the change area is the original, byte for byte. The server repeats this on
  // decoded files.
  for (const [width, height] of [
    [1920, 1080],
    [3840, 2160],
  ] as const) {
    test(`keeps every pixel outside the band at ${width}×${height}`, () => {
      const hole = { x: Math.round(width * 0.3), y: Math.round(height * 0.4), width: 400, height: 250 };
      const { expandPx, featherPx } = MASK_COMPOSITE_DEFAULTS;
      const weights = weightsFromAlpha(rectAlpha(width, height, hole), width, height, {
        expandPx,
        featherPx,
      });
      const base = pixels(width, height, 4, 3);
      const result = pixels(width, height, 4, 4);
      const out = blendPixels(base, result, weights, 4);
      let kept = 0;
      let changed = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const d = distanceToRect(x, y, hole);
          const i = (y * width + x) * 4;
          if (d > expandPx + featherPx) {
            if (
              out[i] !== base[i] ||
              out[i + 1] !== base[i + 1] ||
              out[i + 2] !== base[i + 2] ||
              out[i + 3] !== base[i + 3]
            )
              throw new Error(`Pixel ${x},${y} changed outside the band`);
            kept++;
          } else if (d === 0) {
            if (out[i] !== result[i]) throw new Error(`Pixel ${x},${y} inside the mask kept the original`);
            changed++;
          }
        }
      }
      expect(changed).toBe(hole.width * hole.height);
      expect(kept).toBeGreaterThan(width * height * 0.9);
    });
  }
});

describe("mask conversions", () => {
  test("white changes and black keeps, by luminance", () => {
    const rgb = new Uint8Array([255, 255, 255, 0, 0, 0, 128, 128, 128, 0, 255, 0, 255, 0, 0]);
    const alpha = luminanceToAlpha(rgb, 3);
    expect([...alpha.subarray(0, 3)]).toEqual([0, 255, 127]);
    // Green reads far brighter than red, as the eye sees it.
    expect(alpha[3]!).toBeLessThan(alpha[4]!);
  });

  test("ignores any alpha in the image, and reads grey on its own", () => {
    expect([...luminanceToAlpha(new Uint8Array([255, 255, 255, 0, 0, 0, 0, 0]), 4)]).toEqual([0, 255]);
    expect([...luminanceToAlpha(new Uint8Array([255, 7, 0, 7]), 2)]).toEqual([0, 255]);
    expect([...luminanceToAlpha(new Uint8Array([200]), 1)]).toEqual([55]);
    expect(() => luminanceToAlpha(new Uint8Array(5), 3)).toThrow(RangeError);
  });

  test("invert swaps change and keep; an empty mask marks nothing", () => {
    expect([...invertAlpha(new Uint8Array([0, 255, 100]))]).toEqual([255, 0, 155]);
    expect(isEmptyMask(new Uint8Array([255, 200, MASK_CHANGE_BELOW]))).toBe(true);
    expect(isEmptyMask(new Uint8Array([255, MASK_CHANGE_BELOW - 1]))).toBe(false);
  });
});

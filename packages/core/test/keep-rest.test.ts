// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  alignResult,
  analyzeKeepRest,
  decideKeepRest,
  FIX_MODEL,
  FIX_ORIGINAL,
  fixesFromRgba,
  fixesToRgba,
  isEmptyFixes,
  isStill,
  KEEP_REST_SENSITIVITY,
  type PixelImage,
} from "../src/image/keep-rest";
import { blendPixels, weightsFromAlpha } from "../src/image/mask";

// Smart keep the rest on synthetic pictures: a textured "photo", and a "model result" made from it
// the way models do it, slightly moved and scaled, with a colour cast and grain, plus real changes.

const SETTINGS = { expandPx: 4, featherPx: 8, sensitivity: KEEP_REST_SENSITIVITY.default };

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

/** Smooth value noise at a few scales, so there's detail to line up and broad shapes to compare. */
function scene(width: number, height: number, seed = 7): Float32Array {
  const rand = random(seed);
  const out = new Float32Array(width * height * 3);
  for (const [cell, amp] of [
    [96, 90],
    [24, 50],
    [6, 30],
  ] as const) {
    const cols = Math.ceil(width / cell) + 2;
    const rows = Math.ceil(height / cell) + 2;
    const grid = Array.from({ length: 3 }, () => Float32Array.from({ length: cols * rows }, rand));
    for (let y = 0; y < height; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy);
      const fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < width; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx);
        const fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        for (let c = 0; c < 3; c++) {
          const g = grid[c]!;
          const a = g[y0 * cols + x0]!;
          const b = g[y0 * cols + x0 + 1]!;
          const d = g[(y0 + 1) * cols + x0]!;
          const e = g[(y0 + 1) * cols + x0 + 1]!;
          const v = a + (b - a) * sx + (d + (e - d) * sx - a - (b - a) * sx) * sy;
          const o = (y * width + x) * 3 + c;
          out[o] = out[o]! + amp * v;
        }
      }
    }
  }
  return out;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inBox = (x: number, y: number, b: Box) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;

function toImage(values: Float32Array, width: number, height: number): PixelImage<Uint8Array> {
  const data = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(values[i]!)));
  return { data, width, height, channels: 3 };
}

/** Bilinear read of the scene at (u, v), edges held. */
function sample(src: Float32Array, width: number, height: number, u: number, v: number, c: number) {
  const x = Math.max(0, Math.min(width - 1, u));
  const y = Math.max(0, Math.min(height - 1, v));
  const x0 = Math.min(width - 2, Math.floor(x));
  const y0 = Math.min(height - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => src[(yy * width + xx) * 3 + c]!;
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

interface Made {
  width: number;
  height: number;
  base: PixelImage<Uint8Array>;
  result: PixelImage<Uint8Array>;
  area: Uint8Array;
}

/**
 * The picture, and a result of it: shifted by `move` and scaled by `scale` about the centre (what
 * the result shows at x is the picture at (x - c - dx) / scale + c), tinted, grainy, with `paint`
 * boxes filled with a flat colour in the result only. The mask is `mask`.
 */
function made(opts: {
  width?: number;
  height?: number;
  move?: { dx: number; dy: number };
  scale?: number;
  tint?: { gain: number; offset: number };
  grain?: number;
  mask: Box;
  paint?: { box: Box; colour: [number, number, number] }[];
}): Made {
  const width = opts.width ?? 512;
  const height = opts.height ?? 384;
  const picture = scene(width, height);
  const base = toImage(picture, width, height);
  const { dx, dy } = opts.move ?? { dx: 0, dy: 0 };
  const scale = opts.scale ?? 1;
  const gain = opts.tint?.gain ?? 1;
  const offset = opts.tint?.offset ?? 0;
  const grain = opts.grain ?? 0;
  const rand = random(99);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const out = new Float32Array(picture.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x - cx - dx) / scale + cx;
      const v = (y - cy - dy) / scale + cy;
      const painted = opts.paint?.find((p) => inBox(x, y, p.box));
      for (let c = 0; c < 3; c++) {
        const value = painted ? painted.colour[c]! : sample(picture, width, height, u, v, c);
        // Two uniforms make a rough bell, which is what grain looks like.
        const noise = grain ? (rand() + rand() - 1) * grain * 2.45 : 0;
        out[(y * width + x) * 3 + c] = gain * value + offset + noise;
      }
    }
  const area = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (inBox(x, y, opts.mask)) area[y * width + x] = 0;
  return { width, height, base, result: toImage(out, width, height), area };
}

const at = (m: Pick<Made, "width">, weights: Uint8Array, x: number, y: number) => weights[y * m.width + x]!;

/** Every pixel's weight in the box (shrunk by `inset` on each side) is `check`. */
function everyIn(
  m: Made,
  weights: Uint8Array,
  b: Box,
  inset: number,
  check: (w: number) => boolean,
): boolean {
  for (let y = b.y + inset; y < b.y + b.h - inset; y++)
    for (let x = b.x + inset; x < b.x + b.w - inset; x++) if (!check(at(m, weights, x, y))) return false;
  return true;
}

describe("lining up", () => {
  test("finds a small shift and scale, with a colour cast and grain", () => {
    const m = made({
      move: { dx: 3.4, dy: -2.2 },
      scale: 1.012,
      tint: { gain: 1.06, offset: 5 },
      grain: 3,
      mask: { x: 200, y: 150, w: 90, h: 70 },
    });
    const a = analyzeKeepRest(m.base, m.result, m.area);
    expect(a.fallback).toBeUndefined();
    // The result shows the picture's x at scale * (x - c) + c + dx, so that's where to read it.
    expect(a.lineUp.dx).toBeCloseTo(3.4, 0);
    expect(Math.abs(a.lineUp.dx - 3.4)).toBeLessThan(0.3);
    expect(Math.abs(a.lineUp.dy + 2.2)).toBeLessThan(0.3);
    expect(Math.abs(a.lineUp.scaleX - 1.012)).toBeLessThan(0.002);
    expect(Math.abs(a.lineUp.scaleY - 1.012)).toBeLessThan(0.002);
    expect(a.lineUp.confidence).toBeGreaterThan(0.6);
  });

  test("a result already in place isn't moved", () => {
    const m = made({ grain: 2, mask: { x: 100, y: 100, w: 50, h: 50 } });
    const a = analyzeKeepRest(m.base, m.result, m.area);
    expect(isStill(a.lineUp, 512)).toBe(true);
    expect(alignResult(m.result, a.lineUp)).toBe(m.result.data);
  });

  test("moving the result by its line-up puts it back over the original", () => {
    const m = made({ move: { dx: 4, dy: 3 }, mask: { x: 0, y: 0, w: 40, h: 40 } });
    const a = analyzeKeepRest(m.base, m.result, m.area);
    const moved = alignResult(m.result, a.lineUp);
    let before = 0;
    let after = 0;
    for (let y = 60; y < m.height - 20; y++)
      for (let x = 60; x < m.width - 20; x++) {
        const i = (y * m.width + x) * 3;
        before += Math.abs(m.result.data[i]! - m.base.data[i]!);
        after += Math.abs(moved[i]! - m.base.data[i]!);
      }
    expect(after).toBeLessThan(before / 4);
  });

  test("works on 16-bit grey and on images with alpha", () => {
    const m = made({ move: { dx: 2, dy: 1 }, mask: { x: 50, y: 50, w: 60, h: 60 } });
    const grey16 = (img: PixelImage<Uint8Array>): PixelImage<Uint16Array> => {
      const data = new Uint16Array(img.width * img.height);
      for (let p = 0; p < data.length; p++) data[p] = img.data[p * 3 + 1]! * 257;
      return { data, width: img.width, height: img.height, channels: 1 };
    };
    const a = analyzeKeepRest(grey16(m.base), grey16(m.result), m.area);
    expect(Math.abs(a.lineUp.dx - 2)).toBeLessThan(0.3);
    const rgba = (img: PixelImage<Uint8Array>): PixelImage<Uint8Array> => {
      const data = new Uint8Array(img.width * img.height * 4);
      for (let p = 0; p < img.width * img.height; p++) {
        data.set(img.data.subarray(p * 3, p * 3 + 3), p * 4);
        data[p * 4 + 3] = 255;
      }
      return { data, width: img.width, height: img.height, channels: 4 };
    };
    const b = analyzeKeepRest(rgba(m.base), rgba(m.result), m.area);
    expect(Math.abs(b.lineUp.dy - 1)).toBeLessThan(0.3);
    const weights = decideKeepRest(b, m.area, SETTINGS).weights;
    const moved = alignResult(rgba(m.result), b.lineUp, weights);
    expect(moved.length).toBe(m.width * m.height * 4);
  });
});

describe("deciding the area", () => {
  // The mask covers a box where a flat patch was painted in one part only; next to it a "shadow"
  // spills out past the mask; far away a big clear change and a tiny speck.
  const mask: Box = { x: 160, y: 120, w: 120, h: 100 };
  const patch: Box = { x: 170, y: 130, w: 60, h: 50 };
  const spill: Box = { x: 225, y: 175, w: 100, h: 30 };
  const farChange: Box = { x: 400, y: 280, w: 60, h: 60 };
  const speck: Box = { x: 60, y: 300, w: 2, h: 2 };
  const m = made({
    move: { dx: 1.6, dy: -1.1 },
    tint: { gain: 1.04, offset: 4 },
    grain: 3,
    mask,
    paint: [
      { box: patch, colour: [250, 30, 30] },
      { box: spill, colour: [10, 10, 10] },
      { box: farChange, colour: [20, 240, 60] },
      { box: speck, colour: [255, 255, 255] },
    ],
  });
  const analysis = analyzeKeepRest(m.base, m.result, m.area);
  const { weights, fallback } = decideKeepRest(analysis, m.area, SETTINGS);

  test("keeps the change inside the mask", () => {
    expect(fallback).toBeUndefined();
    expect(everyIn(m, weights, patch, 2, (w) => w === 255)).toBe(true);
  });

  test("puts the original back inside the mask where nothing changed", () => {
    // The mask's right part held no change.
    expect(everyIn(m, weights, { x: 250, y: 125, w: 25, h: 35 }, 0, (w) => w === 0)).toBe(true);
  });

  test("grows into a change that spills out of the mask", () => {
    expect(everyIn(m, weights, { x: 285, y: 178, w: 35, h: 24 }, 2, (w) => w === 255)).toBe(true);
  });

  test("keeps a clear change far from the mask, and undoes a tiny one", () => {
    expect(everyIn(m, weights, farChange, 2, (w) => w === 255)).toBe(true);
    expect(everyIn(m, weights, speck, 0, (w) => w === 0)).toBe(true);
  });

  test("leaves the rest of the picture as the original, grain and colour cast included", () => {
    expect(everyIn(m, weights, { x: 10, y: 10, w: 120, h: 90 }, 0, (w) => w === 0)).toBe(true);
    expect(everyIn(m, weights, { x: 330, y: 20, w: 170, h: 80 }, 0, (w) => w === 0)).toBe(true);
  });

  test("softens the edge outward over featherPx", () => {
    // Just right of the far change: inside the feather, partly the model.
    const edge = at(m, weights, farChange.x + farChange.w + 4, farChange.y + 30);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    const sharp = decideKeepRest(analysis, m.area, { ...SETTINGS, featherPx: 0 }).weights;
    for (const w of sharp) expect(w === 0 || w === 255).toBe(true);
  });

  test("sensitivity moves the cut-off either way", () => {
    const low = decideKeepRest(analysis, m.area, { ...SETTINGS, sensitivity: 0 });
    const high = decideKeepRest(analysis, m.area, { ...SETTINGS, sensitivity: 100 });
    const mid = decideKeepRest(analysis, m.area, SETTINGS);
    expect(low.cutoff).toBeGreaterThan(mid.cutoff);
    expect(high.cutoff).toBeLessThan(mid.cutoff);
    expect(low.changed).toBeLessThanOrEqual(mid.changed);
    expect(high.changed).toBeGreaterThanOrEqual(mid.changed);
    // Out of range is held to the range.
    expect(decideKeepRest(analysis, m.area, { ...SETTINGS, sensitivity: 500 }).cutoff).toBe(high.cutoff);
  });

  test("blends to the original's exact values wherever the weight is 0", () => {
    const moved = alignResult(m.result, analysis.lineUp, weights);
    const out = blendPixels(m.base.data, moved, weights, 3);
    for (let p = 0; p < weights.length; p++) {
      if (weights[p]) continue;
      for (let c = 0; c < 3; c++)
        if (out[p * 3 + c] !== m.base.data[p * 3 + c]) throw new Error(`pixel ${p}`);
    }
  });
});

describe("fixes", () => {
  const mask: Box = { x: 100, y: 100, w: 100, h: 100 };
  const m = made({ grain: 2, mask, paint: [{ box: mask, colour: [200, 40, 200] }] });
  const analysis = analyzeKeepRest(m.base, m.result, m.area);

  test("use the original wins over a change, feathering included", () => {
    const fixes = new Uint8Array(m.width * m.height);
    const keepOriginal: Box = { x: 120, y: 120, w: 30, h: 30 };
    for (let y = keepOriginal.y; y < keepOriginal.y + keepOriginal.h; y++)
      fixes.fill(FIX_ORIGINAL, y * m.width + keepOriginal.x, y * m.width + keepOriginal.x + keepOriginal.w);
    const { weights } = decideKeepRest(analysis, m.area, SETTINGS, fixes);
    expect(everyIn(m, weights, keepOriginal, 0, (w) => w === 0)).toBe(true);
    expect(at(m, weights, 170, 170)).toBe(255);
  });

  test("use the model wins where nothing changed", () => {
    const fixes = new Uint8Array(m.width * m.height);
    const useModel: Box = { x: 350, y: 40, w: 40, h: 40 };
    for (let y = useModel.y; y < useModel.y + useModel.h; y++)
      fixes.fill(FIX_MODEL, y * m.width + useModel.x, y * m.width + useModel.x + useModel.w);
    const { weights } = decideKeepRest(analysis, m.area, SETTINGS, fixes);
    expect(everyIn(m, weights, useModel, 0, (w) => w === 255)).toBe(true);
  });

  test("apply on top of the mask when the comparison fell back", () => {
    const fixes = new Uint8Array(m.width * m.height);
    fixes[150 * m.width + 150] = FIX_ORIGINAL;
    fixes[10 * m.width + 10] = FIX_MODEL;
    const failed = { ...analysis, fallback: "no_match" as const };
    const { weights, fallback } = decideKeepRest(failed, m.area, SETTINGS, fixes);
    expect(fallback).toBe("no_match");
    expect(at(m, weights, 150, 150)).toBe(0);
    expect(at(m, weights, 10, 10)).toBe(255);
    expect(at(m, weights, 160, 160)).toBe(255);
  });

  test("round-trip through RGBA", () => {
    const fixes = Uint8Array.from([0, FIX_MODEL, FIX_ORIGINAL, 0]);
    expect(fixesFromRgba(fixesToRgba(fixes))).toEqual(fixes);
    expect(isEmptyFixes(new Uint8Array(4))).toBe(true);
    expect(isEmptyFixes(fixes)).toBe(false);
  });
});

describe("falling back to the mask", () => {
  const mask: Box = { x: 100, y: 100, w: 80, h: 60 };
  const exact = (m: Made) => weightsFromAlpha(m.area, m.width, m.height, SETTINGS);

  test("when the result is another picture", () => {
    const m = made({ mask });
    // Another scene altogether, as the fake models send.
    const unrelated = toImage(scene(m.width, m.height, 12345), m.width, m.height);
    const a = analyzeKeepRest(m.base, unrelated, m.area);
    expect(a.fallback).toBe("no_match");
    const d = decideKeepRest(a, m.area, SETTINGS);
    expect(d.fallback).toBe("no_match");
    expect(d.weights).toEqual(exact(m));
  });

  test("when the result is a flat gradient", () => {
    const m = made({ mask });
    const data = new Uint8Array(m.width * m.height * 3);
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) data.set([x % 256, 80, y % 256], (y * m.width + x) * 3);
    const a = analyzeKeepRest(m.base, { data, width: m.width, height: m.height, channels: 3 }, m.area);
    expect(a.fallback).toBeDefined();
    expect(decideKeepRest(a, m.area, SETTINGS).weights).toEqual(exact(m));
  });

  test("when the model sent another shape", () => {
    const m = made({ mask });
    const a = analyzeKeepRest(m.base, m.result, m.area, { sentSize: { width: 1024, height: 1024 } });
    expect(a.fallback).toBe("other_shape");
    // The same shape, at another size, is fine.
    const b = analyzeKeepRest(m.base, m.result, m.area, { sentSize: { width: 1024, height: 768 } });
    expect(b.fallback).toBeUndefined();
  });

  test("when most of the picture changed", () => {
    const m = made({
      mask,
      grain: 2,
      paint: [
        { box: { x: 0, y: 0, w: 512, h: 250 }, colour: [30, 30, 220] },
        { box: { x: 0, y: 250, w: 300, h: 134 }, colour: [230, 230, 20] },
      ],
    });
    const d = decideKeepRest(analyzeKeepRest(m.base, m.result, m.area), m.area, SETTINGS);
    expect(d.fallback).toBeDefined();
    expect(d.weights).toEqual(exact(m));
  });

  test("when the shift is too large to be a small one", () => {
    const m = made({ move: { dx: 60, dy: 0 }, mask });
    const a = analyzeKeepRest(m.base, m.result, m.area);
    expect(a.fallback).toBe("no_match");
  });
});

describe("speed", () => {
  test("a 2K image analyses and decides in reasonable time", () => {
    const m = made({
      width: 2048,
      height: 2048,
      move: { dx: 3, dy: 2 },
      grain: 3,
      mask: { x: 800, y: 800, w: 400, h: 300 },
      paint: [{ box: { x: 850, y: 850, w: 250, h: 200 }, colour: [240, 20, 20] }],
    });
    const t0 = performance.now();
    const a = analyzeKeepRest(m.base, m.result, m.area);
    const t1 = performance.now();
    const d = decideKeepRest(a, m.area, SETTINGS);
    const t2 = performance.now();
    const moved = alignResult(m.result, a.lineUp, d.weights);
    blendPixels(m.base.data, moved, d.weights, 3);
    const t3 = performance.now();
    console.log(
      `2048x2048: analyse ${(t1 - t0).toFixed(0)} ms, decide ${(t2 - t1).toFixed(0)} ms, move and blend ${(t3 - t2).toFixed(0)} ms`,
    );
    expect(d.fallback).toBeUndefined();
    expect(t1 - t0).toBeLessThan(3000);
    expect(t2 - t1).toBeLessThan(1500);
  });
});

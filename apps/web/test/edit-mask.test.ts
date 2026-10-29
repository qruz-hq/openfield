// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import {
  applyMaskOp,
  type Brush,
  brushCoverage,
  coverageFromRgba,
  createMask,
  isMaskEmpty,
  type Mask,
  MaskEditor,
  type MaskOp,
  maskBounds,
  maskRgba,
  normalizeBrush,
  overlayRgba,
  type Point,
  type Rect,
  strokeSpacing,
  writeMaskRgba,
} from "../src/detail/edit/mask";
import { encodeMaskPng } from "../src/detail/edit/mask-png";

// The Edit view's mask layer, on raw buffers: bun tests have no DOM, and the layer needs none.

const value = (mask: Mask, x: number, y: number) => mask.data[y * mask.width + x]!;
const centre = (x: number, y: number): Point => ({ x: x + 0.5, y: y + 0.5 });
const brush = (size: number, hardness: number, mode: Brush["mode"] = "paint"): Brush => ({
  mode,
  size,
  hardness,
});

/** Same seed, same sequence, so a failure always reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mask with every byte set to something, so a stray write shows. */
function patterned(width: number, height: number): Mask {
  const mask = createMask(width, height);
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = (i * 37) % 251;
  return mask;
}

function applied(width: number, height: number, ops: readonly MaskOp[]): Uint8Array {
  const mask = createMask(width, height);
  for (const op of ops) applyMaskOp(mask, op);
  return mask.data;
}

/** Every pixel that differs between two buffers lies inside `rect`. */
function changesInside(before: Uint8Array, after: Uint8Array, width: number, rect: Rect | null) {
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    const inside =
      rect !== null && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    if (!inside) return { x, y };
  }
  return null;
}

describe("brush hardness", () => {
  /** Coverage along a row, from a 100px dab's centre out: index = distance in px. */
  const profile = (hardness: number) => {
    const mask = createMask(201, 1);
    applyMaskOp(mask, { type: "stroke", brush: brush(100, hardness), points: [centre(100, 0)] });
    const right = Array.from(mask.data.subarray(100));
    const left = Array.from(mask.data.subarray(0, 101)).reverse();
    expect(left).toEqual(right);
    return right;
  };

  const nonIncreasing = (values: number[]) => values.every((v, i) => i === 0 || v <= values[i - 1]!);

  test("hardness 100 is solid to the radius, with a one-pixel antialiased edge", () => {
    const p = profile(100);
    expect(p.slice(0, 50).every((v) => v === 255)).toBe(true);
    expect(p[50]).toBe(128);
    expect(p.slice(51).every((v) => v === 0)).toBe(true);
  });

  test("hardness 0 fades from the centre all the way to the edge", () => {
    const p = profile(0);
    expect(p[0]).toBe(255);
    expect(nonIncreasing(p)).toBe(true);
    // Halfway out is about half painted, and the fade only rounds to nothing at the radius.
    expect(Math.abs(p[25]! - 128)).toBeLessThanOrEqual(4);
    expect(p.slice(0, 50).every((v) => v > 0)).toBe(true);
    expect(p.slice(50).every((v) => v === 0)).toBe(true);
    expect(p[10]! > p[20]! && p[20]! > p[30]! && p[30]! > p[40]!).toBe(true);
  });

  test("hardness 50 is solid for half the radius, then fades", () => {
    const p = profile(50);
    expect(p.slice(0, 26).every((v) => v === 255)).toBe(true);
    expect(p[26]).toBeLessThan(255);
    expect(nonIncreasing(p)).toBe(true);
    expect(p[49]).toBeGreaterThan(0);
    expect(p.slice(50).every((v) => v === 0)).toBe(true);
  });

  test("brushCoverage matches what lands in the buffer", () => {
    for (const hardness of [0, 35, 100]) {
      const p = profile(hardness);
      for (const d of [0, 12, 30, 49, 50, 51]) {
        expect(p[d]).toBe(Math.round(255 * brushCoverage(d, brush(100, hardness))));
      }
    }
  });

  test("a segment's cross-section is the dab's profile", () => {
    const mask = createMask(200, 101);
    applyMaskOp(mask, { type: "stroke", brush: brush(60, 30), points: [centre(40, 50), centre(160, 50)] });
    const dot = createMask(200, 101);
    applyMaskOp(dot, { type: "stroke", brush: brush(60, 30), points: [centre(100, 50)] });
    for (let y = 0; y < 101; y++) expect(value(mask, 100, y)).toBe(value(dot, 100, y));
  });

  test("size and hardness are held to 1-512 and 0-100", () => {
    expect(normalizeBrush(brush(2000, 140))).toEqual(brush(512, 100));
    expect(normalizeBrush(brush(0, -5, "erase"))).toEqual(brush(1, 0, "erase"));
    expect(normalizeBrush(brush(Number.NaN, Number.NaN))).toEqual(brush(1, 100));
  });

  test("a 1px brush paints the one pixel under it", () => {
    const mask = createMask(5, 5);
    applyMaskOp(mask, { type: "stroke", brush: brush(1, 100), points: [centre(2, 2)] });
    expect(Array.from(mask.data).filter((v) => v > 0)).toEqual([255]);
    expect(value(mask, 2, 2)).toBe(255);
  });
});

describe("strokes", () => {
  const path = [centre(10, 12), { x: 40.2, y: 30.7 }, { x: 70.9, y: 18.1 }, { x: 72, y: 55.5 }];

  test("a stroke painted live in pieces is the same as the stroke applied at once", () => {
    for (const hardness of [0, 60, 100]) {
      const editor = new MaskEditor(90, 70);
      editor.beginStroke(brush(24, hardness), path[0]!);
      for (const point of path.slice(1)) expect(editor.strokeTo(point)).not.toBeNull();
      editor.endStroke();
      expect(editor.mask.data).toEqual(
        applied(90, 70, [{ type: "stroke", brush: brush(24, hardness), points: path }]),
      );
    }
  });

  test("a stroke touches only its bounding box, and painting only ever adds", () => {
    const mask = patterned(120, 90);
    const before = mask.data.slice();
    const rect = applyMaskOp(mask, { type: "stroke", brush: brush(18, 40), points: path });
    // The path's extent plus the brush's reach (radius + half a pixel) each way.
    expect(rect).toEqual({ x: 1, y: 3, width: 81, height: 62 });
    expect(changesInside(before, mask.data, 120, rect)).toBeNull();
    expect(mask.data.every((v, i) => v >= before[i]!)).toBe(true);
  });

  test("each live segment returns just the box it painted", () => {
    const editor = new MaskEditor(200, 200);
    editor.beginStroke(brush(10, 100), { x: 20, y: 20 });
    const before = editor.mask.data.slice();
    const rect = editor.strokeTo({ x: 60, y: 30 });
    expect(rect).toEqual({ x: 14, y: 14, width: 52, height: 22 });
    expect(changesInside(before, editor.mask.data, 200, rect)).toBeNull();
  });

  test("points closer than the spacing are skipped, and the stroke still ends at the pointer", () => {
    expect(strokeSpacing(512)).toBe(64);
    expect(strokeSpacing(4)).toBe(1);
    const editor = new MaskEditor(100, 20);
    editor.beginStroke(brush(16, 100), centre(10, 10));
    expect(editor.strokeTo(centre(11, 10))).toBeNull();
    expect(editor.strokeTo(centre(11.5, 10))).toBeNull();
    editor.endStroke(centre(80, 10));
    expect(value(editor.mask, 80, 10)).toBe(255);
    expect(value(editor.mask, 45, 10)).toBe(255);
    expect(editor.mask.data).toEqual(
      applied(100, 20, [{ type: "stroke", brush: brush(16, 100), points: [centre(10, 10), centre(80, 10)] }]),
    );
  });

  test("a stroke that starts or wanders off the image paints only what's on it", () => {
    const mask = createMask(40, 40);
    const rect = applyMaskOp(mask, {
      type: "stroke",
      brush: brush(10, 100),
      points: [
        { x: -30, y: 20 },
        { x: 70, y: 20 },
      ],
    });
    expect(rect).toEqual({ x: 0, y: 14, width: 40, height: 12 });
    expect(value(mask, 0, 20)).toBe(255);
    expect(value(mask, 39, 20)).toBe(255);
    expect(
      applyMaskOp(createMask(40, 40), {
        type: "stroke",
        brush: brush(10, 100),
        points: [{ x: -50, y: -50 }],
      }),
    ).toBeNull();
  });

  test("matches a brute-force distance to the path, pixel for pixel, on random strokes", () => {
    // Worked out independently of the rasteriser: each pixel's centre against every segment of the
    // path, closest point clamped to the segment. ±1 allows for float rounding at the fade's edge.
    const distance = (p: Point, a: Point, b: Point) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    const W = 120;
    const H = 90;
    const next = random(91);
    for (let round = 0; round < 30; round++) {
      const mode = round % 3 === 2 ? "erase" : "paint";
      const tip = brush(1 + next() * 60, next() * 100, mode);
      const points = Array.from({ length: 2 + Math.floor(next() * 5) }, () => ({
        x: next() * (W + 40) - 20,
        y: next() * (H + 40) - 20,
      }));
      const mask = createMask(W, H);
      if (mode === "erase") mask.data.fill(255);
      applyMaskOp(mask, { type: "stroke", brush: tip, points });
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          let d = Number.POSITIVE_INFINITY;
          for (let i = 1; i < points.length; i++) {
            d = Math.min(d, distance(centre(x, y), points[i - 1]!, points[i]!));
          }
          const coverage = Math.round(255 * brushCoverage(d, tip));
          const expected = mode === "erase" ? 255 - coverage : coverage;
          if (Math.abs(value(mask, x, y) - expected) > 1) {
            throw new Error(`round ${round}: pixel ${x},${y} is ${value(mask, x, y)}, expected ${expected}`);
          }
        }
      }
    }
  });

  test("a point that isn't a number is ignored rather than breaking the stroke", () => {
    const editor = new MaskEditor(60, 20);
    editor.beginStroke(brush(6, 100), centre(5, 10));
    expect(editor.strokeTo({ x: Number.NaN, y: 3 })).toBeNull();
    editor.strokeTo(centre(50, 10));
    editor.endStroke();
    expect(value(editor.mask, 30, 10)).toBe(255);
  });
});

describe("eraser", () => {
  test("erases to nothing in the middle, softly at the edge, and leaves the rest", () => {
    const mask = createMask(100, 60);
    applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: 0, y: 0 }, to: { x: 100, y: 60 } });
    applyMaskOp(mask, {
      type: "stroke",
      brush: brush(30, 0, "erase"),
      points: [centre(10, 30), centre(90, 30)],
    });
    expect(value(mask, 50, 30)).toBe(0);
    const edge = value(mask, 50, 30 + 10);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    expect(value(mask, 50, 5)).toBe(255);
    expect(value(mask, 50, 55)).toBe(255);
    // Exactly the complement of what the same brush would paint on an empty layer.
    const painted = applied(100, 60, [
      { type: "stroke", brush: brush(30, 0), points: [centre(10, 30), centre(90, 30)] },
    ]);
    expect(mask.data.every((v, i) => v === 255 - painted[i]!)).toBe(true);
  });

  test("never adds coverage, and erasing an empty layer leaves it empty", () => {
    const mask = patterned(50, 50);
    const before = mask.data.slice();
    applyMaskOp(mask, {
      type: "stroke",
      brush: brush(20, 50, "erase"),
      points: [centre(10, 10), centre(40, 35)],
    });
    expect(mask.data.every((v, i) => v <= before[i]!)).toBe(true);

    const editor = new MaskEditor(50, 50);
    editor.beginStroke(brush(20, 50, "erase"), centre(25, 25));
    editor.endStroke(centre(30, 40));
    expect(editor.isEmpty()).toBe(true);
    expect(isMaskEmpty(editor.mask)).toBe(true);
  });
});

/** Winding number of the closed outline around (x, y), counting edges on [min y, max y) like the fill. */
function windingAt(points: readonly Point[], x: number, y: number): number {
  let winding = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
    if (a.y <= y && b.y > y && side > 0) winding++;
    else if (b.y <= y && a.y > y && side < 0) winding--;
  }
  return winding;
}

/** How many edges a ray from (x, y) to the right crosses: what even-odd would go by. */
function crossingsAt(points: readonly Point[], x: number, y: number): number {
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (a.y <= y === b.y <= y) continue;
    if (a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y) > x) count++;
  }
  return count;
}

function expectNonzero(mask: Mask, points: readonly Point[]) {
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const inside = windingAt(points, x + 0.5, y + 0.5) !== 0;
      if ((value(mask, x, y) === 255) !== inside) throw new Error(`pixel ${x},${y} should be ${inside}`);
    }
  }
}

describe("lasso", () => {
  // A five-pointed star drawn in one go, point to every second point: the outline goes round the
  // middle twice, the way a hand-drawn lasso that loops back over itself does.
  const star = Array.from({ length: 5 }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    return { x: 50.3 + 40 * Math.cos(angle), y: 50.7 + 40 * Math.sin(angle) };
  });

  test("fills with nonzero, so a lasso crossing itself keeps its middle (even-odd would punch it out)", () => {
    const mask = createMask(100, 100);
    applyMaskOp(mask, { type: "polygon", mode: "paint", points: star });
    expectNonzero(mask, star);
    expect(Math.abs(windingAt(star, 50.5, 50.5))).toBe(2);
    expect(crossingsAt(star, 50.5, 50.5) % 2).toBe(0);
    expect(value(mask, 50, 50)).toBe(255);
    // The points of the star are in too, and the corners outside it aren't.
    expect(value(mask, 50, 15)).toBe(255);
    expect(value(mask, 5, 5)).toBe(0);
  });

  test("a lasso drawn twice round the same loop fills it once, with no hole", () => {
    const loop = Array.from({ length: 40 }, (_, i) => {
      const angle = (i / 20) * Math.PI * 2;
      const radius = 25 + (i < 20 ? 0 : 6);
      return { x: 40.2 + radius * Math.cos(angle), y: 35.4 + radius * Math.sin(angle) };
    });
    const mask = createMask(80, 72);
    applyMaskOp(mask, { type: "polygon", mode: "paint", points: loop });
    expectNonzero(mask, loop);
    expect(value(mask, 40, 35)).toBe(255);
    expect(value(mask, 40 + 28, 35)).toBe(255);
  });

  test("matches the winding rule pixel for pixel on random outlines", () => {
    const next = random(37);
    for (let round = 0; round < 25; round++) {
      const points = Array.from({ length: 3 + Math.floor(next() * 14) }, () => ({
        x: next() * 90 - 10,
        y: next() * 70 - 10,
      }));
      const mask = createMask(72, 52);
      const rect = applyMaskOp(mask, { type: "polygon", mode: "paint", points });
      expectNonzero(mask, points);
      expect(changesInside(new Uint8Array(mask.data.length), mask.data, 72, rect)).toBeNull();
    }
  });

  test("erases with the same outline", () => {
    const mask = createMask(100, 100);
    mask.data.fill(255);
    applyMaskOp(mask, { type: "polygon", mode: "erase", points: star });
    expect(value(mask, 50, 50)).toBe(0);
    expect(value(mask, 5, 5)).toBe(255);
  });

  test("fewer than three points, or a flat outline, does nothing", () => {
    const mask = createMask(20, 20);
    expect(
      applyMaskOp(mask, { type: "polygon", mode: "paint", points: [centre(1, 1), centre(9, 9)] }),
    ).toBeNull();
    expect(
      applyMaskOp(mask, {
        type: "polygon",
        mode: "paint",
        points: [centre(1, 1), centre(5, 5), centre(9, 9)],
      }),
    ).toBeNull();
    expect(isMaskEmpty(mask)).toBe(true);
  });
});

describe("rectangle", () => {
  test("takes the pixels whose centres are inside, from either corner", () => {
    const one = createMask(40, 40);
    expect(
      applyMaskOp(one, { type: "rect", mode: "paint", from: { x: 10, y: 10 }, to: { x: 20, y: 20 } }),
    ).toEqual({
      x: 10,
      y: 10,
      width: 10,
      height: 10,
    });
    const other = createMask(40, 40);
    applyMaskOp(other, { type: "rect", mode: "paint", from: { x: 20, y: 10 }, to: { x: 10, y: 20 } });
    expect(other.data).toEqual(one.data);
    expect(Array.from(one.data).filter((v) => v === 255)).toHaveLength(100);
    expect(value(one, 9, 10)).toBe(0);
    expect(value(one, 19, 19)).toBe(255);
    expect(value(one, 20, 19)).toBe(0);

    const partial = createMask(40, 40);
    expect(
      applyMaskOp(partial, {
        type: "rect",
        mode: "paint",
        from: { x: 10.4, y: 10.6 },
        to: { x: 12.5, y: 12.4 },
      }),
    ).toEqual({ x: 10, y: 11, width: 2, height: 1 });
  });

  test("clips at the image's edges, and one fully outside does nothing", () => {
    const mask = createMask(30, 20);
    expect(
      applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: -50, y: -50 }, to: { x: 5, y: 5 } }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 5,
      height: 5,
    });
    expect(
      applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: 31, y: 0 }, to: { x: 60, y: 20 } }),
    ).toBeNull();
    expect(
      applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: 3, y: 3 }, to: { x: 3, y: 9 } }),
    ).toBeNull();
  });

  test("erase clears exactly its pixels", () => {
    const mask = createMask(30, 20);
    mask.data.fill(255);
    applyMaskOp(mask, { type: "rect", mode: "erase", from: { x: 5, y: 5 }, to: { x: 10, y: 8 } });
    expect(Array.from(mask.data).filter((v) => v === 0)).toHaveLength(15);
    expect(value(mask, 5, 5)).toBe(0);
    expect(value(mask, 10, 5)).toBe(255);
  });
});

describe("invert and clear", () => {
  test("invert swaps what changes and what stays, and twice is no change", () => {
    // 7 × 3 = 21 bytes: five whole words and one byte past them.
    const mask = patterned(7, 3);
    const before = mask.data.slice();
    applyMaskOp(mask, { type: "invert" });
    expect(mask.data.every((v, i) => v === 255 - before[i]!)).toBe(true);
    applyMaskOp(mask, { type: "invert" });
    expect(mask.data).toEqual(before);
    // The padding after the last pixel stays 0, so the word-wide emptiness check stays right.
    expect(Array.from(new Uint8Array(mask.data.buffer).subarray(21))).toEqual([0, 0, 0]);
  });

  test("works on a buffer that isn't word-aligned", () => {
    const backing = new Uint8Array(13);
    const mask: Mask = { width: 4, height: 3, data: backing.subarray(1) };
    mask.data.set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 255]);
    applyMaskOp(mask, { type: "invert" });
    expect(Array.from(mask.data)).toEqual([255, 245, 235, 225, 215, 205, 195, 185, 175, 165, 155, 0]);
    expect(backing[0]).toBe(0);
    expect(isMaskEmpty(mask)).toBe(false);
  });

  test("inverting an empty layer marks everything, and clear empties it", () => {
    const mask = createMask(9, 9);
    applyMaskOp(mask, { type: "invert" });
    expect(mask.data.every((v) => v === 255)).toBe(true);
    expect(isMaskEmpty(mask)).toBe(false);
    applyMaskOp(mask, { type: "clear" });
    expect(isMaskEmpty(mask)).toBe(true);
  });
});

describe("history", () => {
  const W = 96;
  const H = 64;

  function randomOp(next: () => number): MaskOp {
    const point = () => ({ x: next() * (W + 20) - 10, y: next() * (H + 20) - 10 });
    const mode = next() < 0.3 ? "erase" : "paint";
    const kind = next();
    if (kind < 0.45) {
      return {
        type: "stroke",
        brush: brush(1 + next() * 30, next() * 100, mode),
        points: Array.from({ length: 1 + Math.floor(next() * 6) }, point),
      };
    }
    if (kind < 0.65)
      return { type: "polygon", mode, points: Array.from({ length: 3 + Math.floor(next() * 6) }, point) };
    if (kind < 0.85) return { type: "rect", mode, from: point(), to: point() };
    if (kind < 0.95) return { type: "invert" };
    return { type: "clear" };
  }

  for (const options of [
    {},
    { checkpointSteps: 3, maxSnapshots: 2 },
    { checkpointSteps: 4, checkpointPixels: 4000, maxSnapshots: 3 },
    { checkpointSteps: 2, checkpointPixels: 1, maxSnapshots: 2 },
  ]) {
    test(`undo and redo land on the same bytes as applying the steps directly ${JSON.stringify(options)}`, () => {
      const next = random(7 + JSON.stringify(options).length);
      const editor = new MaskEditor(W, H, options);
      // What the layer should hold: every step applied so far, from the very start.
      const done: MaskOp[] = [];
      const undone: MaskOp[] = [];
      let forgot = false;
      for (let i = 0; i < 300; i++) {
        const before = editor.mask.data.slice();
        const roll = next();
        let rect: Rect | null;
        if (roll < 0.25 && editor.canUndo) {
          rect = editor.undo();
          undone.push(done.pop()!);
        } else if (roll < 0.4 && editor.canRedo) {
          rect = editor.redo();
          done.push(undone.pop()!);
        } else {
          const op = randomOp(next);
          if (op.type === "stroke" && next() < 0.5) {
            // Live, the way the pointer paints it.
            const [first, ...rest] = op.points;
            rect = editor.beginStroke(op.brush, first!);
            for (const point of rest) rect = unionOf(rect, editor.strokeTo(point));
            editor.endStroke();
          } else {
            rect = editor.apply(op);
          }
          if (rect) {
            done.push(op);
            undone.length = 0;
          }
        }
        expect(editor.mask.data).toEqual(applied(W, H, done));
        expect(changesInside(before, editor.mask.data, W, rect)).toBeNull();
        expect(editor.undoSteps).toBeLessThanOrEqual(done.length);
        expect(editor.redoSteps).toBe(undone.length);
        expect(editor.isEmpty()).toBe(isMaskEmpty(editor.mask));
        expect(editor.historyBytes).toBeLessThanOrEqual((options.maxSnapshots ?? 3) * W * H);
        if (editor.undoSteps < done.length) forgot = true;
      }
      // Small budgets must have dropped old snapshots along the way, so that path is covered too.
      if (options.maxSnapshots) expect(forgot).toBe(true);
    });
  }

  const unionOf = (a: Rect | null, b: Rect | null): Rect | null => {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  };

  test("at least 50 light steps stay undoable (§4.6)", () => {
    const editor = new MaskEditor(256, 256);
    const ops: MaskOp[] = Array.from({ length: 80 }, (_, i) => ({
      type: "stroke",
      brush: brush(6, 100),
      points: [centre((i * 13) % 250, (i * 29) % 250)],
    }));
    for (const op of ops) editor.apply(op);
    expect(editor.undoSteps).toBeGreaterThanOrEqual(50);
    for (let i = 0; i < 50; i++) expect(editor.undo()).not.toBeNull();
    expect(editor.mask.data).toEqual(applied(256, 256, ops.slice(0, 30)));
    for (let i = 0; i < 50; i++) editor.redo();
    expect(editor.mask.data).toEqual(applied(256, 256, ops));
  });

  test("a new step after undo drops the redo stack", () => {
    const editor = new MaskEditor(40, 40);
    editor.apply({ type: "rect", mode: "paint", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    editor.apply({ type: "rect", mode: "paint", from: { x: 20, y: 20 }, to: { x: 30, y: 30 } });
    editor.undo();
    expect(editor.canRedo).toBe(true);
    editor.apply({ type: "invert" });
    expect(editor.canRedo).toBe(false);
    expect(editor.redo()).toBeNull();
  });

  test("undo or Esc mid-stroke drops just that stroke", () => {
    const editor = new MaskEditor(60, 60);
    editor.apply({ type: "rect", mode: "paint", from: { x: 0, y: 0 }, to: { x: 20, y: 20 } });
    const before = editor.mask.data.slice();
    editor.beginStroke(brush(10, 100), centre(40, 40));
    editor.strokeTo(centre(55, 55));
    expect(editor.canRedo).toBe(false);
    expect(editor.undo()).not.toBeNull();
    expect(editor.mask.data).toEqual(before);
    expect(editor.stroking).toBe(false);
    expect(editor.undoSteps).toBe(1);

    editor.beginStroke(brush(10, 100), centre(40, 40));
    expect(editor.cancelStroke()).not.toBeNull();
    expect(editor.mask.data).toEqual(before);
    expect(editor.undoSteps).toBe(1);
  });

  test("steps that change nothing aren't steps", () => {
    const editor = new MaskEditor(30, 30);
    expect(editor.apply({ type: "clear" })).toBeNull();
    editor.beginStroke(brush(10, 100), { x: -40, y: -40 });
    editor.endStroke({ x: -60, y: -20 });
    expect(
      editor.apply({ type: "rect", mode: "paint", from: { x: 40, y: 0 }, to: { x: 50, y: 10 } }),
    ).toBeNull();
    expect(editor.canUndo).toBe(false);
  });

  test("starts from a mask it's given, and undo stops there", () => {
    const start = createMask(20, 20);
    applyMaskOp(start, { type: "rect", mode: "paint", from: { x: 2, y: 2 }, to: { x: 8, y: 8 } });
    const editor = new MaskEditor(20, 20, { initial: start.data });
    expect(editor.isEmpty()).toBe(false);
    editor.apply({ type: "invert" });
    editor.apply({ type: "clear" });
    while (editor.canUndo) editor.undo();
    expect(editor.mask.data).toEqual(start.data);
    expect(() => new MaskEditor(20, 21, { initial: start.data })).toThrow(RangeError);
  });

  test("version goes up on every change", () => {
    const editor = new MaskEditor(20, 20);
    const seen = [editor.version];
    editor.beginStroke(brush(4, 100), centre(5, 5));
    seen.push(editor.version);
    editor.endStroke(centre(15, 5));
    seen.push(editor.version);
    editor.undo();
    seen.push(editor.version);
    editor.redo();
    seen.push(editor.version);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1]!)).toBe(true);
  });
});

describe("4K", () => {
  for (const [width, height] of [
    [3840, 2160],
    [4096, 4096],
  ] as const) {
    test(`${width}x${height}: the layer is one byte a pixel and history stays within three snapshots`, () => {
      const pixels = width * height;
      const mask = createMask(width, height);
      expect(mask.data.length).toBe(pixels);
      expect(mask.data.buffer.byteLength).toBeLessThan(pixels + 4);

      const editor = new MaskEditor(width, height);
      const ops: MaskOp[] = [];
      // Full-width sweeps with the biggest brush, 13M-17M pixel visits each.
      for (let i = 0; i < 12; i++) {
        const y = ((i + 0.5) * height) / 12;
        const spacing = strokeSpacing(512);
        const points = Array.from({ length: Math.ceil(width / spacing) + 1 }, (_, k) => ({
          x: k * spacing,
          y,
        }));
        ops.push({ type: "stroke", brush: brush(512, i % 2 ? 100 : 30), points });
        if (i % 3 === 2) ops.push({ type: "invert" });
      }
      for (const op of ops) {
        editor.apply(op);
        expect(editor.historyBytes).toBeLessThanOrEqual(3 * pixels);
      }
      // Heavy steps: older ones were forgotten to hold memory, and a couple still undo.
      expect(editor.undoSteps).toBeLessThan(ops.length);
      expect(editor.undoSteps).toBeGreaterThanOrEqual(2);

      editor.undo();
      expect(editor.mask.data).toEqual(applied(width, height, ops.slice(0, -1)));
      editor.redo();

      const rgba = maskRgba(editor.mask);
      expect(rgba.length).toBe(pixels * 4);
      const bounds = editor.bounds();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    });
  }
});

describe("reading the mask", () => {
  test("isEmpty and bounds follow what's painted, soft edges included", () => {
    const mask = createMask(64, 48);
    expect(isMaskEmpty(mask)).toBe(true);
    expect(maskBounds(mask)).toBeNull();
    applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: 10, y: 5 }, to: { x: 30, y: 20 } });
    expect(maskBounds(mask)).toEqual({ x: 10, y: 5, width: 20, height: 15 });
    applyMaskOp(mask, { type: "stroke", brush: brush(9, 0), points: [centre(50, 40)] });
    expect(maskBounds(mask)).toEqual({ x: 10, y: 5, width: 45, height: 40 });
    mask.data.fill(0);
    mask.data[mask.data.length - 1] = 1;
    expect(isMaskEmpty(mask)).toBe(false);
    expect(maskBounds(mask)).toEqual({ x: 63, y: 47, width: 1, height: 1 });
  });

  test("the editor's emptiness keeps up with every kind of step", () => {
    const editor = new MaskEditor(40, 40);
    expect(editor.isEmpty()).toBe(true);
    expect(editor.bounds()).toBeNull();
    editor.apply({ type: "rect", mode: "paint", from: { x: 0, y: 0 }, to: { x: 4, y: 4 } });
    expect(editor.isEmpty()).toBe(false);
    editor.apply({ type: "rect", mode: "erase", from: { x: 0, y: 0 }, to: { x: 4, y: 4 } });
    expect(editor.isEmpty()).toBe(true);
    editor.apply({ type: "invert" });
    expect(editor.isEmpty()).toBe(false);
    editor.apply({ type: "clear" });
    expect(editor.isEmpty()).toBe(true);
    editor.undo();
    expect(editor.isEmpty()).toBe(false);
  });
});

describe("export", () => {
  test("painted pixels come out alpha 0, kept ones alpha 255, RGB always 0 (§0.9)", () => {
    const mask = createMask(20, 10);
    applyMaskOp(mask, { type: "rect", mode: "paint", from: { x: 0, y: 0 }, to: { x: 5, y: 10 } });
    applyMaskOp(mask, { type: "stroke", brush: brush(6, 0), points: [centre(14, 5)] });
    const rgba = maskRgba(mask);
    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(rgba.length).toBe(20 * 10 * 4);
    const alpha = (x: number, y: number) => rgba[(y * 20 + x) * 4 + 3];
    expect(alpha(2, 4)).toBe(0);
    expect(alpha(9, 4)).toBe(255);
    const soft = value(mask, 16, 5);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(255);
    expect(alpha(16, 5)).toBe(255 - soft);
    for (let i = 0; i < rgba.length; i += 4) expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([0, 0, 0]);
  });

  test("written in strips it's the same bytes, and it reads back to the same layer", () => {
    const mask = patterned(31, 17);
    const whole = maskRgba(mask);
    const strip = new Uint8ClampedArray(31 * 5 * 4);
    writeMaskRgba(mask, strip, 10, 5);
    expect(strip).toEqual(whole.subarray(31 * 10 * 4, 31 * 15 * 4));
    expect(coverageFromRgba(whole, 31, 17).data).toEqual(mask.data);
    expect(() => writeMaskRgba(mask, new Uint8ClampedArray(10))).toThrow(RangeError);
    expect(() => writeMaskRgba(mask, new Uint8ClampedArray(31 * 5 * 4), 15, 5)).toThrow(RangeError);
  });

  test("the overlay tints just the rect, scaled by coverage", () => {
    const mask = createMask(10, 10);
    mask.data[3 * 10 + 4] = 200;
    mask.data[3 * 10 + 5] = 100;
    const out = overlayRgba(mask, { x: 4, y: 3, width: 2, height: 1 }, [255, 64, 0], 0.5);
    expect(Array.from(out)).toEqual([255, 64, 0, 100, 255, 64, 0, 50]);
  });

  test("the PNG is encoded through a canvas in strips, at the mask's exact size", async () => {
    const mask = createMask(3000, 800);
    applyMaskOp(mask, {
      type: "stroke",
      brush: brush(300, 20),
      points: [centre(100, 700), centre(2900, 90)],
    });
    const canvas = new FakeCanvas();
    const png = await encodeMaskPng(mask, canvas as unknown as HTMLCanvasElement);
    expect(png.type).toBe("image/png");
    expect([canvas.width, canvas.height]).toEqual([3000, 800]);
    expect(canvas.strips).toBeGreaterThan(1);
    expect(canvas.pixels).toEqual(maskRgba(mask));
  });

  test("a failed encode rejects", async () => {
    const mask = createMask(4, 4);
    const broken = new FakeCanvas();
    broken.toBlob = (done) => done(null);
    await expect(encodeMaskPng(mask, broken as unknown as HTMLCanvasElement)).rejects.toThrow(
      "PNG encode failed",
    );
    const noContext = new FakeCanvas();
    noContext.getContext = () => null;
    await expect(encodeMaskPng(mask, noContext as unknown as HTMLCanvasElement)).rejects.toThrow(
      "no 2D canvas",
    );
  });
});

/** Just enough of a canvas to see what the encoder puts on it. */
class FakeCanvas {
  width = 0;
  height = 0;
  strips = 0;
  pixels = new Uint8ClampedArray(0);

  getContext(): unknown {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (
        image: { width: number; data: Uint8ClampedArray },
        dx: number,
        dy: number,
        sx: number,
        sy: number,
        sw: number,
        sh: number,
      ) => {
        if (this.pixels.length !== this.width * this.height * 4) {
          this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
        }
        this.strips++;
        for (let row = 0; row < sh; row++) {
          const from = ((sy + row) * image.width + sx) * 4;
          this.pixels.set(
            image.data.subarray(from, from + sw * 4),
            ((dy + sy + row) * this.width + dx + sx) * 4,
          );
        }
      },
    };
  }

  toBlob(done: (blob: Blob | null) => void, type: string) {
    done(new Blob([this.pixels.slice()], { type }));
  }
}

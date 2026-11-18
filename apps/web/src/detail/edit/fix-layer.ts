import { FIX_MODEL, FIX_NONE, FIX_ORIGINAL, type LineUp } from "@openfield/core";
import type { Point, Rect } from "./mask";

// Touch up (§0.9): a fix layer painted on a finished edit, one code per pixel of the original:
// FIX_MODEL "use the model here", FIX_ORIGINAL "use the original here", FIX_NONE no opinion. It's
// sent as an RGBA PNG (core fixesToRgba) and replaces the one stored, so it starts as the stored one.
// Plain data and maths, no React, so the canvas Edit node's window can paint one too.

export type FixBrush = "model" | "original";

const CODE: Record<FixBrush, number> = { model: FIX_MODEL, original: FIX_ORIGINAL };

/** Undo goes back this many strokes; each step holds a copy of the layer. */
const UNDO_STEPS = 30;

export class FixLayer {
  readonly codes: Uint8Array;
  #past: Uint8Array[] = [];
  #stroke: { code: number; radius: number; last: Point } | null = null;
  /** Strokes painted since it was loaded, less those undone. */
  #strokes = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    initial?: Uint8Array,
  ) {
    if (initial && initial.length !== width * height) throw new RangeError("Fixes of another size");
    this.codes = initial ? initial.slice() : new Uint8Array(width * height);
  }

  /** Painted on since it was loaded. */
  get changed(): boolean {
    return this.#strokes > 0;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get stroking(): boolean {
    return this.#stroke !== null;
  }

  /** Starts a stroke of `size` image px at `at`. Returns what it painted. */
  beginStroke(brush: FixBrush, size: number, at: Point): Rect | null {
    this.#past.push(this.codes.slice());
    if (this.#past.length > UNDO_STEPS) this.#past.shift();
    this.#strokes++;
    this.#stroke = { code: CODE[brush], radius: Math.max(0.5, size / 2), last: at };
    return this.#dab(at);
  }

  /** Carries the stroke on to `at`, dabbing along the way so a fast move leaves no gaps. */
  strokeTo(at: Point): Rect | null {
    const stroke = this.#stroke;
    if (!stroke) return null;
    const { last, radius } = stroke;
    const distance = Math.hypot(at.x - last.x, at.y - last.y);
    const step = Math.max(0.5, radius / 3);
    const steps = Math.max(1, Math.ceil(distance / step));
    let rect: Rect | null = null;
    for (let i = 1; i <= steps; i++) {
      const point = { x: last.x + ((at.x - last.x) * i) / steps, y: last.y + ((at.y - last.y) * i) / steps };
      rect = unite(rect, this.#dab(point));
    }
    stroke.last = at;
    return rect;
  }

  endStroke(): void {
    this.#stroke = null;
  }

  /** Back to before the last stroke. False when there's none. */
  undo(): boolean {
    const before = this.#past.pop();
    if (!before) return false;
    this.#stroke = null;
    this.codes.set(before);
    this.#strokes = Math.max(0, this.#strokes - 1);
    return true;
  }

  /** A filled circle of the stroke's code, clipped to the image. */
  #dab(at: Point): Rect | null {
    const stroke = this.#stroke;
    if (!stroke) return null;
    const { radius, code } = stroke;
    const x0 = Math.max(0, Math.floor(at.x - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(at.x + radius));
    const y0 = Math.max(0, Math.floor(at.y - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(at.y + radius));
    if (x1 < x0 || y1 < y0) return null;
    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - at.y;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - at.x;
        if (dx * dx + dy * dy <= r2) this.codes[y * this.width + x] = code;
      }
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
}

const unite = (a: Rect | null, b: Rect | null): Rect | null => {
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

/**
 * Weights at a smaller size (0 the original, 255 the model) with the fix codes on top, read at the
 * nearest pixel. `weights` is changed in place and returned.
 */
export function withFixCodes(
  weights: Uint8ClampedArray,
  width: number,
  height: number,
  fixes: FixLayer,
): Uint8ClampedArray {
  const sx = fixes.width / width;
  const sy = fixes.height / height;
  for (let y = 0; y < height; y++) {
    const row = Math.min(fixes.height - 1, Math.floor((y + 0.5) * sy)) * fixes.width;
    for (let x = 0; x < width; x++) {
      const code = fixes.codes[row + Math.min(fixes.width - 1, Math.floor((x + 0.5) * sx))];
      if (code === FIX_MODEL) weights[y * width + x] = 255;
      else if (code === FIX_ORIGINAL) weights[y * width + x] = 0;
    }
  }
  return weights;
}

export const hasFixes = (codes: Uint8Array) => codes.some((code) => code !== FIX_NONE);

/**
 * The canvas transform that draws the model's result (at the original's size, `width` x `height`)
 * lined up, into a canvas `scale` times that size. The server's alignResult reads, for each output
 * pixel x, the result at scaleX * (x - (width - 1) / 2) + (width - 1) / 2 + dx, in pixel indices.
 * A canvas measures from pixel edges, half a pixel off, so the same centre here is width / 2; and
 * drawing goes the other way round, so this is the inverse.
 */
export function lineUpTransform(
  lineUp: Pick<LineUp, "dx" | "dy" | "scaleX" | "scaleY"> | null,
  width: number,
  height: number,
  scale: number,
): [number, number, number, number, number, number] {
  if (!lineUp) return [scale, 0, 0, scale, 0, 0];
  const cx = width / 2;
  const cy = height / 2;
  return [
    scale / lineUp.scaleX,
    0,
    0,
    scale / lineUp.scaleY,
    scale * (cx - (cx + lineUp.dx) / lineUp.scaleX),
    scale * (cy - (cy + lineUp.dy) / lineUp.scaleY),
  ];
}

/**
 * The outline of an area (non-zero cells of `inside`, `width` x `height`) as SVG path data in its
 * own pixels: marching squares, with the pieces joined into runs so a dash pattern flows along them.
 */
export function outlinePath(inside: Uint8Array, width: number, height: number): string {
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && inside[y * width + x] ? 1 : 0;
  // Each segment runs between two cell edge midpoints, keyed "x,y" in half pixels.
  const next = new Map<string, string[]>();
  const join = (a: string, b: string) => {
    const list = next.get(a);
    if (list) list.push(b);
    else next.set(a, [b]);
  };
  const link = (a: string, b: string) => {
    join(a, b);
    join(b, a);
  };
  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const index = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (index === 0 || index === 15) continue;
      // Midpoints of the cell's sides, in doubled pixel units around pixel centres.
      const top = `${2 * x + 2},${2 * y + 1}`;
      const right = `${2 * x + 3},${2 * y + 2}`;
      const bottom = `${2 * x + 2},${2 * y + 3}`;
      const left = `${2 * x + 1},${2 * y + 2}`;
      for (const [a, b] of SEGMENTS[index]!) {
        const ends = { top, right, bottom, left };
        link(ends[a], ends[b]);
      }
    }
  }
  const parts: string[] = [];
  const point = (key: string) => {
    const [x = 0, y = 0] = key.split(",").map(Number);
    return `${x / 2} ${y / 2}`;
  };
  const take = (a: string, b: string) => {
    const list = next.get(a);
    if (list) list.splice(list.indexOf(b), 1);
    const back = next.get(b);
    if (back) back.splice(back.indexOf(a), 1);
  };
  for (const [start, list] of next) {
    while (list.length > 0) {
      let from = start;
      let to = list[0]!;
      const run = [point(from)];
      for (;;) {
        take(from, to);
        run.push(point(to));
        const onward = next.get(to);
        if (!onward?.length || to === start) break;
        from = to;
        to = onward[0]!;
      }
      parts.push(`M${run.join("L")}${run.length > 2 && run[0] === run.at(-1) ? "Z" : ""}`);
    }
  }
  return parts.join("");
}

type Side = "top" | "right" | "bottom" | "left";
// Which sides each corner pattern (tl tr br bl, as bits 8 4 2 1) joins. The saddles join the pairs
// that keep the inside pixels apart, as a pixel grid's own edges would.
const SEGMENTS: readonly (readonly [Side, Side][])[] = [
  [],
  [["left", "bottom"]],
  [["bottom", "right"]],
  [["left", "right"]],
  [["top", "right"]],
  [
    ["left", "top"],
    ["bottom", "right"],
  ],
  [["top", "bottom"]],
  [["left", "top"]],
  [["left", "top"]],
  [["top", "bottom"]],
  [
    ["top", "right"],
    ["left", "bottom"],
  ],
  [["top", "right"]],
  [["left", "right"]],
  [["bottom", "right"]],
  [["left", "bottom"]],
  [],
];

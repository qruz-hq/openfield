// The Edit view's mask layer (§0.9, §4.6): what the person paints over the base image, at the base's
// exact pixel size. Plain typed arrays and no DOM, so it runs under bun test and could move to a
// worker unchanged.
//
// The layer stores coverage, one byte per pixel: 0 keeps the pixel, 255 hands it to the model, and
// values in between are a soft brush edge. Export flips that into Openfield's canonical mask,
// alpha = 255 - coverage with RGB 0. One byte a pixel also keeps undo snapshots a quarter of an
// RGBA copy: 8.3MB at 3840x2160, 16.8MB at 4096x4096.

/** Image pixels, continuous: pixel (i, j) covers [i, i + 1) × [j, j + 1), so its centre is i + 0.5. */
export interface Point {
  x: number;
  y: number;
}

/** Whole pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Mask {
  readonly width: number;
  readonly height: number;
  /** Coverage, row-major: 0 keeps, 255 changes, between is a soft edge. */
  readonly data: Uint8Array;
}

export type MaskMode = "paint" | "erase";

export interface Brush {
  mode: MaskMode;
  /** Diameter in image pixels, 1-512 (§4.6). */
  size: number;
  /** 0-100: how much of the radius is solid before the edge starts to fade. */
  hardness: number;
}

export type MaskOp =
  | { type: "stroke"; brush: Brush; points: readonly Point[] }
  | { type: "polygon"; mode: MaskMode; points: readonly Point[] }
  | { type: "rect"; mode: MaskMode; from: Point; to: Point }
  | { type: "invert" }
  | { type: "clear" };

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 512;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);

/** An empty layer, its buffer padded to whole words so invert and the emptiness scan go 4 bytes at a time. */
export function createMask(width: number, height: number): Mask {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`A mask needs a whole-pixel size, got ${width}x${height}`);
  }
  const length = width * height;
  return { width, height, data: new Uint8Array(new ArrayBuffer(Math.ceil(length / 4) * 4), 0, length) };
}

export function normalizeBrush(brush: Brush): Brush {
  return {
    mode: brush.mode,
    size: clamp(Number.isFinite(brush.size) ? brush.size : MIN_BRUSH_SIZE, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE),
    hardness: clamp(Number.isFinite(brush.hardness) ? brush.hardness : 100, 0, 100),
  };
}

/** A brush tip in the form the inner loop wants. */
interface Tip {
  erase: boolean;
  outer: number;
  outer2: number;
  inner2: number;
  band: number;
}

function tipOf(brush: Brush): Tip {
  const { size, hardness, mode } = normalizeBrush(brush);
  const radius = size / 2;
  // The edge fades from `inner` to half a pixel past the radius. Even at hardness 100 the fade is a
  // pixel wide, which is what antialiases a hard brush.
  const outer = radius + 0.5;
  const inner = Math.max(0, Math.min((radius * hardness) / 100, radius - 0.5));
  return {
    erase: mode === "erase",
    outer,
    outer2: outer * outer,
    inner2: inner * inner,
    band: outer - inner,
  };
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** How much a pixel `distance` px from the stroke's path gets painted, 0-1. */
export function brushCoverage(distance: number, brush: Brush): number {
  const tip = tipOf(brush);
  if (distance * distance >= tip.outer2) return 0;
  if (distance * distance <= tip.inner2) return 1;
  return smoothstep((tip.outer - distance) / tip.band);
}

/**
 * Image px between the points a live stroke keeps: an eighth of the brush. Without it a slow drag
 * sends a point every pixel or two, and a 512px brush would revisit the same 280k pixels for each.
 * Segments are joined capsules, not stamped dabs, so the spacing never shows as scalloped edges.
 */
export const strokeSpacing = (size: number) => Math.max(1, clamp(size, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE) / 8);

/**
 * Image px a skipped point may sit off the kept path before it's kept anyway, so a stroke that turns
 * or doubles back inside the spacing still reaches as far as the pointer went. Half a pixel up to a
 * 32px brush, then a sixty-fourth of it. Pointer positions come in whole screen pixels, so a slow
 * diagonal drag zigzags by half a pixel even at 100% and by more zoomed out: a fixed half pixel
 * would keep nearly every point of it, and a 512px brush would repaint 260k pixels for each.
 */
export const strokeTolerance = (size: number) =>
  Math.max(0.5, clamp(size, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE) / 64);

/** Points skipped between two kept ones are held to check for turns; past this many the newest is kept. */
const MAX_SKIPPED = 128;

/** Squared distance from p to the segment a-b. */
function segmentDistance2(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p.x - a.x - t * dx;
  const ey = p.y - a.y - t * dy;
  return ex * ex + ey * ey;
}

/**
 * Douglas-Peucker: the indexes, in order, of the points strictly between the first and the last
 * that a path through them needs so every point stays within the tolerance of it. The farthest
 * point goes in first, so a stroke that doubles back keeps its exact turning point.
 */
function corners(points: readonly Point[], tolerance2: number): number[] {
  const keep: number[] = [];
  const split = (from: number, to: number) => {
    let far = -1;
    let farthest = tolerance2;
    for (let i = from + 1; i < to; i++) {
      const d2 = segmentDistance2(points[i]!, points[from]!, points[to]!);
      if (d2 > farthest) {
        farthest = d2;
        far = i;
      }
    }
    if (far < 0) return;
    split(from, far);
    keep.push(far);
    split(far, to);
  };
  split(0, points.length - 1);
  return keep;
}

/**
 * One capsule of a stroke: every pixel within the brush radius of the segment a-b (a dot when a = b).
 * Painting keeps the higher coverage and erasing the lower, so the joints between segments never
 * build up and painting a stroke in pieces gives the same bytes as painting it whole. Touches only
 * the segment's bounding box: about (length + size) × size pixels.
 */
function paintSegment(mask: Mask, tip: Tip, a: Point, b: Point): Rect | null {
  if (!finite(a) || !finite(b)) return null;
  const { width, height, data } = mask;
  const reach = tip.outer;
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach));
  const x1 = Math.min(width, Math.ceil(Math.max(a.x, b.x) + reach));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach));
  const y1 = Math.min(height, Math.ceil(Math.max(a.y, b.y) + reach));
  if (x0 >= x1 || y0 >= y1) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const inverse = length2 > 0 ? 1 / length2 : 0;
  const { outer, outer2, inner2, band, erase } = tip;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5 - a.y;
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const px = x + 0.5 - a.x;
      // The closest point on the segment, then the squared distance to it.
      let t = (px * dx + py * dy) * inverse;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 >= outer2) continue;
      let value = 255;
      if (d2 > inner2) {
        const s = (outer - Math.sqrt(d2)) / band;
        value = Math.round(255 * s * s * (3 - 2 * s));
        if (value === 0) continue;
      }
      const i = row + x;
      if (erase) {
        const keep = 255 - value;
        if (data[i]! > keep) data[i] = keep;
      } else if (data[i]! < value) {
        data[i] = value;
      }
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Lasso and rectangle fills are hard-edged: a pixel is in when its centre is. Softening the boundary
// is the composite's feather setting (§0.9), so antialiasing them here would only cost time.

interface Edge {
  top: number;
  bottom: number;
  /** x at y = top, and how far x moves per pixel down. */
  x: number;
  slope: number;
  /** +1 going down, -1 going up. */
  winding: number;
}

/**
 * A closed lasso, filled with the nonzero rule: a pixel is in when the outline winds around it at
 * all. Hand-drawn lassos cross themselves, and even-odd would punch a hole wherever the outline goes
 * round the same spot twice, which nobody drawing a lasso means. Nonzero is also the canvas's
 * default, so a preview drawn with ctx.fill() matches. Scanline with an active edge list:
 * O(rows × edges crossing a row) plus the pixels filled, all inside the outline's bounding box.
 */
function fillPolygon(mask: Mask, mode: MaskMode, points: readonly Point[]): Rect | null {
  if (points.length < 3 || !points.every(finite)) return null;
  const { width, height, data } = mask;
  const edges: Edge[] = [];
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (a.y === b.y) continue;
    const down = b.y > a.y;
    const [top, bottom] = down ? [a, b] : [b, a];
    edges.push({
      top: top.y,
      bottom: bottom.y,
      x: top.x,
      slope: (bottom.x - top.x) / (bottom.y - top.y),
      winding: down ? 1 : -1,
    });
    minY = Math.min(minY, top.y);
    maxY = Math.max(maxY, bottom.y);
  }
  if (edges.length < 2) return null;
  edges.sort((p, q) => p.top - q.top);

  // Rows whose centre y + 0.5 lies in [minY, maxY).
  const rowStart = Math.max(0, Math.ceil(minY - 0.5));
  const rowEnd = Math.min(height, Math.ceil(maxY - 0.5));
  const value = mode === "erase" ? 0 : 255;
  const active: Edge[] = [];
  const xs: number[] = [];
  const turns: number[] = [];
  let next = 0;
  let left = width;
  let right = 0;
  let top = height;
  let bottom = 0;
  for (let y = rowStart; y < rowEnd; y++) {
    const cy = y + 0.5;
    while (next < edges.length && edges[next]!.top <= cy) active.push(edges[next++]!);
    // Each edge covers [top, bottom), so a shared vertex is counted once.
    let kept = 0;
    for (const edge of active) if (edge.bottom > cy) active[kept++] = edge;
    active.length = kept;

    xs.length = 0;
    turns.length = 0;
    for (const edge of active) {
      const x = edge.x + (cy - edge.top) * edge.slope;
      // Insertion sort: a row crosses a handful of edges.
      let at = xs.length;
      while (at > 0 && xs[at - 1]! > x) {
        xs[at] = xs[at - 1]!;
        turns[at] = turns[at - 1]!;
        at--;
      }
      xs[at] = x;
      turns[at] = edge.winding;
    }

    let winding = 0;
    const row = y * width;
    for (let k = 0; k + 1 < xs.length; k++) {
      winding += turns[k]!;
      if (winding === 0) continue;
      // Pixels whose centre lies in [xs[k], xs[k + 1]).
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const to = Math.min(width, Math.ceil(xs[k + 1]! - 0.5));
      if (from >= to) continue;
      data.fill(value, row + from, row + to);
      left = Math.min(left, from);
      right = Math.max(right, to);
      top = Math.min(top, y);
      bottom = y + 1;
    }
  }
  return right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** Every pixel whose centre is inside the rectangle between two corners, in either order. */
function fillRect(mask: Mask, mode: MaskMode, from: Point, to: Point): Rect | null {
  if (!finite(from) || !finite(to)) return null;
  const { width, height, data } = mask;
  const x0 = Math.max(0, Math.ceil(Math.min(from.x, to.x) - 0.5));
  const x1 = Math.min(width, Math.ceil(Math.max(from.x, to.x) - 0.5));
  const y0 = Math.max(0, Math.ceil(Math.min(from.y, to.y) - 0.5));
  const y1 = Math.min(height, Math.ceil(Math.max(from.y, to.y) - 0.5));
  if (x0 >= x1 || y0 >= y1) return null;
  const value = mode === "erase" ? 0 : 255;
  for (let y = y0; y < y1; y++) data.fill(value, y * width + x0, y * width + x1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The data as 32-bit words when it's aligned, with the bytes past the last whole word. */
function words(data: Uint8Array): { words: Uint32Array; tail: number } {
  if (data.byteOffset % 4 !== 0) return { words: new Uint32Array(0), tail: 0 };
  const view = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  return { words: view, tail: view.length << 2 };
}

/** Swaps what changes and what stays. 255 - v is v ^ 0xff, so whole words flip at once. */
function invertMask(mask: Mask): Rect {
  const { data } = mask;
  const { words: view, tail } = words(data);
  for (let i = 0; i < view.length; i++) view[i] = ~view[i]!;
  for (let i = tail; i < data.length; i++) data[i] = 255 - data[i]!;
  return fullRect(mask);
}

const fullRect = (mask: Mask): Rect => ({ x: 0, y: 0, width: mask.width, height: mask.height });
const area = (rect: Rect | null) => (rect ? rect.width * rect.height : 0);

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
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
}

/** What an op changed, and how many pixels it had to visit to do it (its replay cost). */
interface Applied {
  rect: Rect | null;
  cost: number;
}

function strokeInto(mask: Mask, tip: Tip, points: readonly Point[]): Applied {
  const first = points[0];
  if (!first) return { rect: null, cost: 0 };
  let rect = paintSegment(mask, tip, first, first);
  let cost = area(rect);
  for (let i = 1; i < points.length; i++) {
    const segment = paintSegment(mask, tip, points[i - 1]!, points[i]!);
    rect = unionRect(rect, segment);
    cost += area(segment);
  }
  return { rect, cost };
}

function applyOp(mask: Mask, op: MaskOp): Applied {
  switch (op.type) {
    case "stroke":
      return strokeInto(mask, tipOf(op.brush), op.points);
    case "polygon": {
      const rect = fillPolygon(mask, op.mode, op.points);
      return { rect, cost: area(rect) + op.points.length };
    }
    case "rect": {
      const rect = fillRect(mask, op.mode, op.from, op.to);
      return { rect, cost: area(rect) };
    }
    case "invert":
      return { rect: invertMask(mask), cost: mask.data.length };
    case "clear":
      mask.data.fill(0);
      return { rect: fullRect(mask), cost: mask.data.length };
  }
}

/** Applies one op to `mask` and returns the pixels it may have changed, or null when it missed the image. */
export const applyMaskOp = (mask: Mask, op: MaskOp): Rect | null => applyOp(mask, op).rect;

/** Nothing painted. The Edit view keeps Generate off until something is. O(pixels), 4 bytes at a time. */
export function isMaskEmpty(mask: Mask): boolean {
  const { data } = mask;
  const { words: view, tail } = words(data);
  for (let i = 0; i < view.length; i++) if (view[i] !== 0) return false;
  for (let i = tail; i < data.length; i++) if (data[i] !== 0) return false;
  return true;
}

/** The smallest rectangle holding every painted pixel, or null when nothing is. */
export function maskBounds(mask: Mask): Rect | null {
  const { width, height, data } = mask;
  const rowEmpty = (y: number) => {
    for (let i = y * width, end = i + width; i < end; i++) if (data[i] !== 0) return false;
    return true;
  };
  let top = 0;
  while (top < height && rowEmpty(top)) top++;
  if (top === height) return null;
  let bottom = height;
  while (rowEmpty(bottom - 1)) bottom--;
  let left = width;
  let right = 0;
  for (let y = top; y < bottom; y++) {
    const row = y * width;
    // Only the columns that could still widen the box.
    for (let x = 0; x < left; x++) {
      if (data[row + x] !== 0) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x >= right; x--) {
      if (data[row + x] !== 0) {
        right = x + 1;
        break;
      }
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Openfield's canonical mask (§0.9) as RGBA into `out`: RGB 0, alpha 0 where the model should change
 * the image and 255 where it keeps it, soft edges in between. `firstRow` and `rows` write a strip, so
 * an encoder can work through a 4K mask without a second full-size copy.
 */
export function writeMaskRgba(
  mask: Mask,
  out: Uint8Array | Uint8ClampedArray,
  firstRow = 0,
  rows = mask.height - firstRow,
): void {
  const { width, height, data } = mask;
  // Rows past the end would read as alpha 0, which means "change": refuse rather than guess.
  if (firstRow < 0 || rows < 0 || firstRow + rows > height)
    throw new RangeError("Those rows aren't in the mask");
  const start = firstRow * width;
  const count = rows * width;
  if (out.length < count * 4) throw new RangeError("The RGBA buffer is too small for those rows");
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 255 - data[start + i]!;
  }
}

/** The whole mask as RGBA, ready for `new ImageData(rgba, width, height)`. width × height × 4 bytes. */
export function maskRgba(mask: Mask): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(mask.width * mask.height * 4);
  writeMaskRgba(mask, out);
  return out;
}

/** A canonical mask read back (from getImageData, say) as coverage, to reopen an edit with its mask. */
export function coverageFromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Mask {
  const mask = createMask(width, height);
  if (rgba.length < mask.data.length * 4) throw new RangeError("The RGBA buffer is smaller than the mask");
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - rgba[i * 4 + 3]!;
  return mask;
}

/**
 * The on-screen overlay for `rect`: `color` with alpha scaled by coverage and `opacity` (0-1), as
 * rect-sized RGBA for putImageData at (rect.x, rect.y). Lets a stroke redraw only what it touched.
 */
export function overlayRgba(
  mask: Mask,
  rect: Rect,
  color: readonly [number, number, number],
  opacity: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const scale = clamp(opacity, 0, 1);
  const [r, g, b] = color;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * mask.width + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const o = (y * rect.width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = mask.data[row + x]! * scale;
    }
  }
  return out;
}

export interface MaskEditorOptions {
  /** Coverage to start from, width × height bytes: reopening an edit with the mask it used. */
  initial?: Uint8Array;
  /** Steps between snapshots. Two snapshots back keep at least 50 steps undoable (§4.6). */
  checkpointSteps?: number;
  /**
   * Also snapshot once replaying the steps since the last one would visit this many pixels. The
   * default, 32M, replays in about 35-80ms on a recent laptop: four passes over 3840x2160.
   */
  checkpointPixels?: number;
  /** Snapshots held at once, the oldest included; each is width × height bytes. At least 2. */
  maxSnapshots?: number;
}

interface Step extends Applied {
  op: MaskOp;
  rect: Rect;
}

interface Snapshot {
  /** How many steps it already holds. */
  at: number;
  /** null for an empty layer, which costs nothing to keep. */
  data: Uint8Array | null;
}

interface LiveStroke {
  brush: Brush;
  tip: Tip;
  /** The kept points: what gets painted and what the undo step replays. */
  points: Point[];
  /** Pointer points since the last kept one, too close to it to paint yet. */
  skipped: Point[];
  spacing: number;
  tolerance2: number;
  rect: Rect | null;
  cost: number;
}

/**
 * The mask layer plus undo and redo (⌘Z / ⇧⌘Z, §4.6). Undo rebuilds from the newest snapshot at or
 * before the target and replays the steps after it; redo applies the one step again. Snapshots are
 * taken every `checkpointSteps` steps, or sooner when the steps since the last were heavy, so an undo
 * never replays much more than `checkpointPixels` of work. Memory stays bounded: once more than
 * `maxSnapshots` are held, the oldest goes along with the steps before the next one. With the
 * defaults the layer plus history holds at most 4 copies: 33MB at 3840x2160, 67MB at 4096x4096.
 * The cost is reach: light steps keep 50 or more undoable, but only a few full-width strokes of a
 * 512px brush fit.
 */
export class MaskEditor {
  readonly mask: Mask;
  readonly #checkpointSteps: number;
  readonly #checkpointCost: number;
  readonly #maxSnapshots: number;
  /** Every step since the oldest snapshot; the ones from `#cursor` on are the redo stack. */
  #steps: Step[] = [];
  #cursor = 0;
  /** Oldest first; the first is where undo stops. */
  #snapshots: Snapshot[];
  #stroke: LiveStroke | null = null;
  /** Cached answer to isEmpty(), null when it needs a scan. */
  #empty: boolean | null;
  #version = 0;

  constructor(width: number, height: number, options: MaskEditorOptions = {}) {
    this.mask = createMask(width, height);
    const { initial } = options;
    if (initial) {
      if (initial.length !== this.mask.data.length) {
        throw new RangeError(`The starting mask is ${initial.length} bytes, not ${width}x${height}`);
      }
      this.mask.data.set(initial);
    }
    this.#empty = isMaskEmpty(this.mask);
    this.#snapshots = [{ at: 0, data: this.#empty ? null : this.mask.data.slice() }];
    this.#checkpointSteps = Math.max(1, options.checkpointSteps ?? 25);
    this.#checkpointCost = Math.max(1, options.checkpointPixels ?? 32_000_000);
    this.#maxSnapshots = Math.max(2, options.maxSnapshots ?? 3);
  }

  /** Goes up on every change, for useSyncExternalStore and friends. */
  get version(): number {
    return this.#version;
  }

  get canUndo(): boolean {
    return this.#stroke !== null || this.#cursor > 0;
  }

  get canRedo(): boolean {
    return this.#stroke === null && this.#cursor < this.#steps.length;
  }

  get undoSteps(): number {
    return this.#cursor;
  }

  get redoSteps(): number {
    return this.#steps.length - this.#cursor;
  }

  /** Bytes held in snapshots, not counting the layer itself. */
  get historyBytes(): number {
    return this.#snapshots.reduce((sum, snapshot) => sum + (snapshot.data?.byteLength ?? 0), 0);
  }

  get stroking(): boolean {
    return this.#stroke !== null;
  }

  isEmpty(): boolean {
    this.#empty ??= isMaskEmpty(this.mask);
    return this.#empty;
  }

  bounds(): Rect | null {
    return this.isEmpty() ? null : maskBounds(this.mask);
  }

  /** Starts a brush or eraser stroke with a dab at `at`. Returns the pixels to redraw. */
  beginStroke(brush: Brush, at: Point): Rect | null {
    if (this.#stroke) this.endStroke();
    if (!finite(at)) return null;
    const normal = normalizeBrush(brush);
    const tip = tipOf(normal);
    const rect = paintSegment(this.mask, tip, at, at);
    const tolerance = strokeTolerance(normal.size);
    this.#stroke = {
      brush: normal,
      tip,
      points: [{ x: at.x, y: at.y }],
      skipped: [],
      spacing: strokeSpacing(normal.size),
      tolerance2: tolerance * tolerance,
      rect,
      cost: area(rect),
    };
    this.#changed(normal.mode);
    return rect;
  }

  /**
   * Extends the stroke to `at`. A point closer to the last kept one than the brush's spacing waits
   * until a later one shows whether the stroke turned there. Returns the pixels to redraw.
   */
  strokeTo(at: Point): Rect | null {
    const stroke = this.#stroke;
    if (!stroke || !finite(at)) return null;
    return this.#follow(stroke, { x: at.x, y: at.y }, false);
  }

  /**
   * Ends the stroke at `at`, where the pointer let go, or at the last point it was given, and makes
   * it one undo step. Returns the pixels to redraw.
   */
  endStroke(at?: Point): Rect | null {
    const stroke = this.#stroke;
    if (!stroke) return null;
    const end = at && finite(at) ? { x: at.x, y: at.y } : stroke.skipped.at(-1);
    const rect = end ? this.#follow(stroke, end, true) : null;
    this.#stroke = null;
    if (stroke.rect) {
      this.#commit({ type: "stroke", brush: stroke.brush, points: stroke.points }, stroke.rect, stroke.cost);
    }
    this.#version++;
    return rect;
  }

  /** Drops the stroke in progress (Esc mid-drag). Returns the pixels to redraw. */
  cancelStroke(): Rect | null {
    const stroke = this.#stroke;
    if (!stroke) return null;
    this.#stroke = null;
    this.#restore(this.#cursor);
    this.#changed();
    return stroke.rect;
  }

  /** A lasso, rectangle, invert or clear (or a whole stroke at once) as one undo step. */
  apply(op: MaskOp): Rect | null {
    if (this.#stroke) this.endStroke();
    if (op.type === "clear" && this.isEmpty()) return null;
    const copy = copyOp(op);
    const { rect, cost } = applyOp(this.mask, copy);
    if (!rect) return null;
    this.#commit(copy, rect, cost);
    this.#changed(effectOf(copy));
    return rect;
  }

  /** Returns the pixels to redraw, or null when there's nothing to undo. Undo mid-stroke drops the stroke. */
  undo(): Rect | null {
    if (this.#stroke) return this.cancelStroke();
    const step = this.#steps[this.#cursor - 1];
    if (!step) return null;
    this.#cursor--;
    this.#restore(this.#cursor);
    this.#changed();
    return step.rect;
  }

  redo(): Rect | null {
    if (this.#stroke) return null;
    const step = this.#steps[this.#cursor];
    if (!step) return null;
    applyOp(this.mask, step.op);
    this.#cursor++;
    this.#changed();
    return step.rect;
  }

  /**
   * One pointer point. Points between kept ones are dropped only while they lie within the
   * tolerance of the straight line from the last kept point to the newest, so straight runs stay
   * sparse and a turn or a scrub back keeps the corners it needs.
   */
  #follow(stroke: LiveStroke, point: Point, end: boolean): Rect | null {
    let rect: Rect | null = null;
    let last = stroke.points.at(-1)!;
    if (stroke.skipped.some((p) => segmentDistance2(p, last, point) > stroke.tolerance2)) {
      const run = [last, ...stroke.skipped, point];
      const kept = corners(run, stroke.tolerance2);
      for (const i of kept) rect = unionRect(rect, this.#segment(stroke, run[i]!));
      // The ones after the last corner are within the tolerance of the line from it to `point`.
      stroke.skipped = run.slice(kept.at(-1)! + 1, -1);
      last = stroke.points.at(-1)!;
    }
    const gap = Math.hypot(point.x - last.x, point.y - last.y);
    if (end ? gap === 0 : gap < stroke.spacing) {
      const newest = stroke.skipped.at(-1);
      if (!end && (newest?.x !== point.x || newest.y !== point.y)) stroke.skipped.push(point);
      if (stroke.skipped.length < MAX_SKIPPED) return rect;
    }
    return unionRect(rect, this.#segment(stroke, point));
  }

  #segment(stroke: LiveStroke, point: Point): Rect | null {
    const from = stroke.points.at(-1)!;
    stroke.points.push(point);
    stroke.skipped = [];
    const rect = paintSegment(this.mask, stroke.tip, from, point);
    stroke.rect = unionRect(stroke.rect, rect);
    stroke.cost += area(rect);
    this.#changed(stroke.brush.mode);
    return rect;
  }

  /** Painting can't empty a layer and erasing can't fill one; anything else needs a fresh look. */
  #changed(effect?: Effect) {
    this.#version++;
    if (effect === "clear") this.#empty = true;
    else if (effect === "invert") this.#empty = this.#empty === true ? false : null;
    else if (
      !(effect === "paint" && this.#empty === false) &&
      !(effect === "erase" && this.#empty === true)
    ) {
      this.#empty = null;
    }
  }

  #commit(op: MaskOp, rect: Rect, cost: number) {
    // A new step forgets the redo stack and any snapshot taken along it.
    this.#steps.length = this.#cursor;
    this.#snapshots = this.#snapshots.filter((snapshot) => snapshot.at <= this.#cursor);
    this.#steps.push({ op, rect, cost });
    this.#cursor++;

    const newest = this.#snapshots.at(-1)!;
    let since = 0;
    for (let i = newest.at; i < this.#cursor; i++) since += this.#steps[i]!.cost;
    if (this.#cursor - newest.at < this.#checkpointSteps && since < this.#checkpointCost) return;

    // A snapshot is one memcpy of the layer.
    this.#snapshots.push({ at: this.#cursor, data: this.mask.data.slice() });
    while (this.#snapshots.filter((snapshot) => snapshot.data).length > this.#maxSnapshots) {
      this.#snapshots.shift();
      const floor = this.#snapshots[0]!.at;
      this.#steps.splice(0, floor);
      this.#cursor -= floor;
      for (const snapshot of this.#snapshots) snapshot.at -= floor;
    }
  }

  /** The layer as it was after `target` steps: the newest snapshot at or before it, then replay. */
  #restore(target: number) {
    let snapshot = this.#snapshots[0]!;
    for (const candidate of this.#snapshots) if (candidate.at <= target) snapshot = candidate;
    if (snapshot.data) this.mask.data.set(snapshot.data);
    else this.mask.data.fill(0);
    for (let i = snapshot.at; i < target; i++) applyOp(this.mask, this.#steps[i]!.op);
  }
}

type Effect = MaskMode | "invert" | "clear";

const effectOf = (op: MaskOp): Effect =>
  op.type === "stroke" ? op.brush.mode : op.type === "polygon" || op.type === "rect" ? op.mode : op.type;

/** History keeps its own copy, so a caller reusing its points array can't rewrite a past step. */
function copyOp(op: MaskOp): MaskOp {
  const points = (list: readonly Point[]) => list.map((p) => ({ x: p.x, y: p.y }));
  switch (op.type) {
    case "stroke":
      return { type: "stroke", brush: normalizeBrush(op.brush), points: points(op.points) };
    case "polygon":
      return { type: "polygon", mode: op.mode, points: points(op.points) };
    case "rect":
      return { type: "rect", mode: op.mode, from: { ...op.from }, to: { ...op.to } };
    default:
      return op;
  }
}

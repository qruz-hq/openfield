import type { CanvasViewport } from "@openfield/core/canvas";
import type { EngineContext } from "../engine/types";
import type { ImageSizes, NodeRegistry } from "../nodes/registry";
import { absolutePosition } from "../store/graph";
import type { DocSlice, Point, Size } from "../store/ops";

// Where a node goes when nobody said (§7.11): beside the node it works with, else to the right of
// everything, and never on top of another node. Canvas coordinates throughout, so a node inside a
// frame is placed where it shows. Every node counts at its real box: an image card at the shape of
// its image or its aspect ratio, not the square it starts from.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Between a node and the one it's placed beside, as the templates space them. */
export const PLACE_GAP = 80;
/** Around every node, so placed nodes never touch. */
export const PLACE_MARGIN = 24;
/** Frames keep this much inside their edges: the sides and bottom, and the title strip on top. */
export const FRAME_INSET = { x: 24, top: 48 };
/** Sized by its content (Text): about one line. */
const CONTENT_SIZED: Size = { w: 160, h: 40 };
const FALLBACK: Size = { w: 280, h: 200 };
/** The editor's snap grid. */
const GRID = 8;
/** The pane a saved viewport was measured in, for the first node of an empty canvas. */
const PANE: Size = { w: 1440, h: 900 };
const TRIES = 60;

/**
 * What an image card's box is worked out from where no browser measured it: the engine's view of
 * models (for a model's default aspect ratio) and the library's image sizes.
 */
export interface BoxSource {
  ctx: EngineContext;
  images?: ImageSizes;
}

/**
 * A node's size on the canvas: an image card's real box when there's a source to work it out from
 * (spec.imageBox), else its saved size or its type's default.
 */
export function nodeSize(doc: DocSlice, specs: NodeRegistry, id: string, source?: BoxSource): Size | null {
  const frame = doc.nodes[id];
  if (!frame) return null;
  const def = specs.get(frame.type);
  if (def?.imageBox && source) {
    return def.imageBox(
      { frame, params: doc.params[id] ?? {}, result: doc.results[id] ?? null, ctx: source.ctx },
      source.images ?? {},
    );
  }
  return frame.size ?? def?.size ?? (def && def.size === null ? CONTENT_SIZED : FALLBACK);
}

/** A node's box on the canvas, from nodeSize. */
export function nodeRect(doc: DocSlice, specs: NodeRegistry, id: string, source?: BoxSource): Rect | null {
  const size = nodeSize(doc, specs, id, source);
  if (!size) return null;
  const at = absolutePosition(doc, id);
  return { x: at.x, y: at.y, w: size.w, h: size.h };
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Closer than `margin`, or on top of each other. */
export const overlaps = (a: Rect, b: Rect, margin = PLACE_MARGIN) =>
  a.x < b.x + b.w + margin &&
  a.x + a.w + margin > b.x &&
  a.y < b.y + b.h + margin &&
  a.y + a.h + margin > b.y;

/** The frame and every frame around it: a node inside them sits on them, which is fine. */
export function framesAround(doc: DocSlice, frameId: string | null): Set<string> {
  const out = new Set<string>();
  for (let at = frameId; at !== null && !out.has(at); at = doc.nodes[at]?.parentId ?? null) out.add(at);
  return out;
}

/** The smallest box around both. */
export const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** A frame grown to hold `rect` inside its insets. It never shrinks. */
export const grownFrame = (frame: Rect, rect: Rect): Rect =>
  union(frame, {
    x: rect.x - FRAME_INSET.x,
    y: rect.y - FRAME_INSET.top,
    w: rect.w + FRAME_INSET.x * 2,
    h: rect.h + FRAME_INSET.top + FRAME_INSET.x,
  });

export interface PlaceRequest {
  size: Size;
  /** Place beside this node: to its right, or with side "left" to its left. */
  near?: string | null;
  side?: "right" | "left";
  /** The frame it goes into. */
  parentId?: string | null;
  /** The saved viewport, for the first node of an empty canvas. */
  viewport?: CanvasViewport;
  /** Where image cards' real boxes come from. Without it, every node counts at its saved size. */
  source?: BoxSource;
}

/** The top-left corner, in canvas coordinates, of a free spot for a node of this size. */
export function placeNode(doc: DocSlice, specs: NodeRegistry, request: PlaceRequest): Point {
  const { size, parentId = null, source } = request;
  const around = framesAround(doc, parentId);
  const rectOf = (id: string) => nodeRect(doc, specs, id, source);
  const obstacles = doc.order
    .filter((id) => !around.has(id))
    .flatMap((id) => {
      const rect = rectOf(id);
      return rect ? [rect] : [];
    });
  const free = (at: Point) => !obstacles.some((o) => overlaps({ ...at, ...size }, o));
  const at = (x: number, y: number): Point => ({ x: snap(x), y: snap(y) });

  // Down a column, then the next column over, from a starting point. A spot that's taken moves
  // down to just under whatever took it, so a column packs as tight as the nodes in it are tall.
  const scan = (start: Point, stepX: number): Point | null => {
    for (let col = 0; col < TRIES; col++) {
      let candidate = at(start.x + col * stepX, start.y);
      for (let row = 0; row < TRIES; row++) {
        const box = { ...candidate, ...size };
        const hits = obstacles.filter((o) => overlaps(box, o));
        if (!hits.length) return candidate;
        const under = Math.max(...hits.map((o) => o.y + o.h)) + PLACE_MARGIN * 2;
        candidate = { x: candidate.x, y: Math.ceil(under / GRID) * GRID };
      }
    }
    return null;
  };

  const near = request.near ? rectOf(request.near) : null;
  if (near) {
    const left = request.side === "left";
    const start = { x: left ? near.x - PLACE_GAP - size.w : near.x + near.w + PLACE_GAP, y: near.y };
    const found = scan(start, (left ? -1 : 1) * (size.w + PLACE_GAP));
    if (found) return found;
  }

  if (parentId !== null) {
    const frame = rectOf(parentId);
    const found = frame ? inFrame(doc, parentId, frame, size, { free, rectOf, at }) : null;
    if (found) return found;
  }

  const top = doc.order.filter((id) => doc.nodes[id]?.parentId === null && !around.has(id));
  if (top.length === 0) {
    const view = request.viewport;
    if (!view) return at(0, 0);
    // The middle of what the person last saw.
    const cx = (PANE.w / 2 - view.x) / view.zoom;
    const cy = (PANE.h / 2 - view.y) / view.zoom;
    return at(cx - size.w / 2, cy - size.h / 2);
  }
  const rects = top.flatMap((id) => {
    const rect = rectOf(id);
    return rect ? [rect] : [];
  });
  const bounds = {
    right: Math.max(...rects.map((r) => r.x + r.w)),
    top: Math.min(...rects.map((r) => r.y)),
  };
  return (
    scan({ x: bounds.right + PLACE_GAP, y: bounds.top }, size.w + PLACE_GAP) ??
    at(bounds.right + PLACE_GAP, bounds.top)
  );
}

/**
 * Inside a frame: rows left to right within its insets. A full frame grows to take the node, below
 * its last row or else to its right, wherever the bigger frame stays clear of what's around it. The
 * frame itself grows once the edits are in (frames.ts).
 */
function inFrame(
  doc: DocSlice,
  frameId: string,
  frame: Rect,
  size: Size,
  place: {
    free: (at: Point) => boolean;
    rectOf: (id: string) => Rect | null;
    at: (x: number, y: number) => Point;
  },
): Point | null {
  const { free, rectOf, at } = place;
  const width = frame.w - FRAME_INSET.x * 2;
  const perRow = Math.max(1, Math.floor((width + PLACE_MARGIN) / (size.w + PLACE_MARGIN)));
  const rows = Math.max(
    1,
    Math.floor((frame.h - FRAME_INSET.top - FRAME_INSET.x + PLACE_MARGIN) / (size.h + PLACE_MARGIN)),
  );
  const spot = (row: number, col: number) =>
    at(
      frame.x + FRAME_INSET.x + col * (size.w + PLACE_MARGIN),
      frame.y + FRAME_INSET.top + row * (size.h + PLACE_MARGIN),
    );
  const fits = (p: Point) =>
    p.x + size.w <= frame.x + frame.w - FRAME_INSET.x && p.y + size.h <= frame.y + frame.h - FRAME_INSET.x;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < perRow; col++) {
      const candidate = spot(row, col);
      if (fits(candidate) && free(candidate)) return candidate;
    }
  }

  // Full: it grows. What's around the frame now, not in it or around it, has to stay clear of it.
  const around = framesAround(doc, frameId);
  const within = (id: string) => {
    for (let p = doc.nodes[id]?.parentId ?? null; p !== null; p = doc.nodes[p]?.parentId ?? null)
      if (p === frameId) return true;
    return false;
  };
  const outside = doc.order
    .filter((id) => !around.has(id) && !within(id))
    .flatMap((id) => {
      const rect = rectOf(id);
      return rect && !overlaps(frame, rect) ? [rect] : [];
    });
  const clear = (p: Point) => !outside.some((o) => overlaps(grownFrame(frame, { ...p, ...size }), o));
  // Rows under what's in it now, then columns past its right edge.
  const content = doc.order.flatMap((id) => {
    const rect = doc.nodes[id]?.parentId === frameId ? rectOf(id) : null;
    return rect ? [rect] : [];
  });
  const floor = Math.max(frame.y + FRAME_INSET.top, ...content.map((r) => r.y + r.h + PLACE_MARGIN));
  const edge = Math.max(frame.x + FRAME_INSET.x, ...content.map((r) => r.x + r.w + PLACE_MARGIN));
  const below: Point[] = [];
  for (let row = 0; row < TRIES; row++)
    for (let col = 0; col < perRow; col++)
      below.push(
        at(frame.x + FRAME_INSET.x + col * (size.w + PLACE_MARGIN), floor + row * (size.h + PLACE_MARGIN)),
      );
  const right: Point[] = [];
  for (let col = 0; col < TRIES; col++)
    for (let row = 0; row < rows; row++)
      right.push(
        at(edge + col * (size.w + PLACE_MARGIN), frame.y + FRAME_INSET.top + row * (size.h + PLACE_MARGIN)),
      );
  const open = [...below, ...right].filter((p) => !fits(p) && free(p));
  return open.find(clear) ?? open[0] ?? null;
}

/**
 * The spot nearest `at` where a box of this size is clear of every obstacle by PLACE_MARGIN, for a
 * position given by hand that lands on another node. Tries each side of each obstacle, and every
 * mix of them, nearest first.
 */
export function nearestFree(at: Point, size: Size, obstacles: readonly Rect[]): Point {
  const hit = (p: Point) => obstacles.some((o) => overlaps({ ...p, ...size }, o));
  if (!hit(at)) return at;
  const xs = new Set([at.x]);
  const ys = new Set([at.y]);
  for (const o of obstacles) {
    xs.add(Math.floor(o.x - PLACE_MARGIN - size.w));
    xs.add(Math.ceil(o.x + o.w + PLACE_MARGIN));
    ys.add(Math.floor(o.y - PLACE_MARGIN - size.h));
    ys.add(Math.ceil(o.y + o.h + PLACE_MARGIN));
  }
  const candidates: { p: Point; d: number }[] = [];
  for (const x of xs) for (const y of ys) candidates.push({ p: { x, y }, d: Math.hypot(x - at.x, y - at.y) });
  candidates.sort((a, b) => a.d - b.d);
  return candidates.find((c) => !hit(c.p))?.p ?? at;
}

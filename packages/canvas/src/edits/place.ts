import type { CanvasViewport } from "@openfield/core/canvas";
import type { NodeRegistry } from "../nodes/registry";
import { absolutePosition } from "../store/graph";
import type { DocSlice, Point, Size } from "../store/ops";

// Where a node goes when nobody said (§7.11): beside the node it works with, else to the right of
// everything, and never on top of another node. Canvas coordinates throughout, so a node inside a
// frame is placed where it shows.

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
/** Frames keep this much inside their edges, the title strip on top. */
const FRAME_INSET = { x: 24, top: 48 };
/** Sized by its content (Text): about one line. */
const CONTENT_SIZED: Size = { w: 160, h: 40 };
const FALLBACK: Size = { w: 280, h: 200 };
/** The editor's snap grid. */
const GRID = 8;
/** The pane a saved viewport was measured in, for the first node of an empty canvas. */
const PANE: Size = { w: 1440, h: 900 };
const TRIES = 60;

/** A node's box on the canvas, from its saved size or its type's default. */
export function nodeRect(doc: DocSlice, specs: NodeRegistry, id: string): Rect | null {
  const frame = doc.nodes[id];
  if (!frame) return null;
  const at = absolutePosition(doc, id);
  const def = specs.get(frame.type);
  const size = frame.size ?? def?.size ?? (def && def.size === null ? CONTENT_SIZED : FALLBACK);
  return { x: at.x, y: at.y, w: size.w, h: size.h };
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

const overlaps = (a: Rect, b: Rect, margin = PLACE_MARGIN) =>
  a.x < b.x + b.w + margin &&
  a.x + a.w + margin > b.x &&
  a.y < b.y + b.h + margin &&
  a.y + a.h + margin > b.y;

/** The frame and every frame around it: a node inside them sits on them, which is fine. */
function framesAround(doc: DocSlice, frameId: string | null): Set<string> {
  const out = new Set<string>();
  for (let at = frameId; at !== null && !out.has(at); at = doc.nodes[at]?.parentId ?? null) out.add(at);
  return out;
}

export interface PlaceRequest {
  size: Size;
  /** Place beside this node: to its right, or with side "left" to its left. */
  near?: string | null;
  side?: "right" | "left";
  /** The frame it goes into. */
  parentId?: string | null;
  /** The saved viewport, for the first node of an empty canvas. */
  viewport?: CanvasViewport;
}

/** The top-left corner, in canvas coordinates, of a free spot for a node of this size. */
export function placeNode(doc: DocSlice, specs: NodeRegistry, request: PlaceRequest): Point {
  const { size, parentId = null } = request;
  const around = framesAround(doc, parentId);
  const obstacles = doc.order
    .filter((id) => !around.has(id))
    .flatMap((id) => {
      const rect = nodeRect(doc, specs, id);
      return rect ? [rect] : [];
    });
  const free = (at: Point) => !obstacles.some((o) => overlaps({ ...at, ...size }, o));
  const at = (x: number, y: number): Point => ({ x: snap(x), y: snap(y) });

  // Down a column, then the next column over, from a starting point.
  const scan = (start: Point, stepX: number): Point | null => {
    for (let col = 0; col < TRIES; col++) {
      for (let row = 0; row < TRIES; row++) {
        const candidate = at(start.x + col * stepX, start.y + row * (size.h + PLACE_MARGIN * 2));
        if (free(candidate)) return candidate;
      }
    }
    return null;
  };

  const near = request.near ? nodeRect(doc, specs, request.near) : null;
  if (near) {
    const left = request.side === "left";
    const start = { x: left ? near.x - PLACE_GAP - size.w : near.x + near.w + PLACE_GAP, y: near.y };
    const found = scan(start, (left ? -1 : 1) * (size.w + PLACE_GAP));
    if (found) return found;
  }

  if (parentId !== null) {
    const frame = nodeRect(doc, specs, parentId);
    if (frame) {
      // Rows inside the frame, left to right. A full frame takes it below its last row.
      const left = frame.x + FRAME_INSET.x;
      const width = frame.w - FRAME_INSET.x * 2;
      const perRow = Math.max(1, Math.floor((width + PLACE_MARGIN) / (size.w + PLACE_MARGIN)));
      for (let row = 0; row < TRIES; row++) {
        for (let col = 0; col < perRow; col++) {
          const candidate = at(
            left + col * (size.w + PLACE_MARGIN),
            frame.y + FRAME_INSET.top + row * (size.h + PLACE_MARGIN),
          );
          if (free(candidate)) return candidate;
        }
      }
    }
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
    const rect = nodeRect(doc, specs, id);
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

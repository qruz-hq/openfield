import type { CanvasNode } from "@openfield/core/canvas";
import { absolutePosition, type CanvasOp, containedIn, type DocSlice, type Point, type Size } from "../store";

// Pane geometry for the editor's commands: boxes, align, distribute, grouping and frame drops.
// Pure over the document plus a size lookup, so the rules are tested without React Flow.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A node's box on screen, in pane units. The editor passes React Flow's measured sizes. */
export type SizeOf = (id: string) => Size | undefined;

/** Frame padding around grouped nodes (§7.9). */
export const GROUP_PADDING = 32;
export const FRAME_TYPE = "frame";

export function nodeBox(doc: DocSlice, id: string, sizeOf: SizeOf): Box | null {
  const frame = doc.nodes[id];
  if (!frame) return null;
  const size = sizeOf(id) ?? frame.size;
  if (!size) return null;
  const at = absolutePosition(doc, id);
  return { x: at.x, y: at.y, w: size.w, h: size.h };
}

export function unionBox(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** A line drawn while dragging, where an edge or centre lines up with a neighbour's (§7.9). */
export interface Guide {
  axis: "x" | "y";
  /** Where the line sits on its axis, in pane units. */
  at: number;
  /** Its extent along the other axis. */
  from: number;
  to: number;
}

/** Left, centre and right (or top, middle and bottom) of a box on one axis. */
const stops = (box: Box, axis: "x" | "y"): number[] =>
  axis === "x" ? [box.x, box.x + box.w / 2, box.x + box.w] : [box.y, box.y + box.h / 2, box.y + box.h];

/**
 * Alignment guides (§7.9): the shift that lines the moving box's nearest edge or centre up with a
 * neighbour's when they're within `threshold`, on each axis on its own, and the lines to draw.
 */
export function alignToNeighbours(
  moving: Box,
  others: readonly Box[],
  threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const snap = (axis: "x" | "y") => {
    let best: { shift: number; at: number } | null = null;
    for (const other of others) {
      for (const mine of stops(moving, axis)) {
        for (const theirs of stops(other, axis)) {
          const shift = theirs - mine;
          if (Math.abs(shift) <= threshold && (!best || Math.abs(shift) < Math.abs(best.shift))) {
            best = { shift, at: theirs };
          }
        }
      }
    }
    return best;
  };
  const x = snap("x");
  const y = snap("y");
  const dx = x?.shift ?? 0;
  const dy = y?.shift ?? 0;
  const placed = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  for (const [axis, hit] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!hit) continue;
    // The line runs through every box that sits on it, the moving one included.
    const on = [placed, ...others].filter((b) => stops(b, axis).some((v) => Math.abs(v - hit.at) < 0.5));
    const along = axis === "x" ? on.flatMap((b) => [b.y, b.y + b.h]) : on.flatMap((b) => [b.x, b.x + b.w]);
    guides.push({ axis, at: hit.at, from: Math.min(...along), to: Math.max(...along) });
  }
  return { dx, dy, guides };
}

/** Selected ids without the ones already inside another selected frame, which move with it. */
export function topLevelSelection(doc: DocSlice, ids: readonly string[]): string[] {
  const picked = new Set(ids.filter((id) => doc.nodes[id]));
  return [...picked].filter((id) => {
    for (let at = doc.nodes[id]?.parentId ?? null; at !== null; at = doc.nodes[at]?.parentId ?? null) {
      if (picked.has(at)) return false;
    }
    return true;
  });
}

/** The move that puts a node's top-left at `absolute`, in its parent's coordinates. */
function moveTo(doc: DocSlice, id: string, absolute: Point): CanvasOp | null {
  const frame = doc.nodes[id];
  if (!frame) return null;
  const parent = frame.parentId ? absolutePosition(doc, frame.parentId) : { x: 0, y: 0 };
  const position = { x: Math.round(absolute.x - parent.x), y: Math.round(absolute.y - parent.y) };
  if (position.x === frame.position.x && position.y === frame.position.y) return null;
  return { op: "moveNode", id, position };
}

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

export function alignOps(doc: DocSlice, ids: readonly string[], how: Alignment, sizeOf: SizeOf): CanvasOp[] {
  const boxes = topLevelSelection(doc, ids).flatMap((id) => {
    const box = nodeBox(doc, id, sizeOf);
    return box ? [{ id, box }] : [];
  });
  const all = unionBox(boxes.map((b) => b.box));
  if (!all || boxes.length < 2) return [];
  const ops: CanvasOp[] = [];
  for (const { id, box } of boxes) {
    const target = { x: box.x, y: box.y };
    if (how === "left") target.x = all.x;
    if (how === "center") target.x = all.x + all.w / 2 - box.w / 2;
    if (how === "right") target.x = all.x + all.w - box.w;
    if (how === "top") target.y = all.y;
    if (how === "middle") target.y = all.y + all.h / 2 - box.h / 2;
    if (how === "bottom") target.y = all.y + all.h - box.h;
    const op = moveTo(doc, id, target);
    if (op) ops.push(op);
  }
  return ops;
}

/** Equal gaps between boxes, the first and last staying put. */
export function distributeOps(
  doc: DocSlice,
  ids: readonly string[],
  axis: "x" | "y",
  sizeOf: SizeOf,
): CanvasOp[] {
  const boxes = topLevelSelection(doc, ids)
    .flatMap((id) => {
      const box = nodeBox(doc, id, sizeOf);
      return box ? [{ id, box }] : [];
    })
    .sort((a, b) => a.box[axis] - b.box[axis]);
  if (boxes.length < 3) return [];
  const span = axis === "x" ? "w" : "h";
  const first = boxes[0]!.box;
  const last = boxes[boxes.length - 1]!.box;
  const used = boxes.reduce((sum, b) => sum + b.box[span], 0);
  const gap = (last[axis] + last[span] - first[axis] - used) / (boxes.length - 1);
  const ops: CanvasOp[] = [];
  let cursor = first[axis];
  for (const { id, box } of boxes) {
    const target = { x: box.x, y: box.y };
    target[axis] = cursor;
    cursor += box[span] + gap;
    const op = moveTo(doc, id, target);
    if (op) ops.push(op);
  }
  return ops;
}

/**
 * Group into frame (⌘G): a frame around the selection plus padding, in the selection's shared
 * frame when there is one, and every selected top-level node moved into it. One undo entry.
 */
export function groupIntoFrameOps(
  doc: DocSlice,
  ids: readonly string[],
  sizeOf: SizeOf,
  frameNode: (position: Point, size: Size, parentId: string | null) => CanvasNode,
): { ops: CanvasOp[]; frameId: string } | null {
  const top = topLevelSelection(doc, ids);
  const boxes = top.flatMap((id) => {
    const box = nodeBox(doc, id, sizeOf);
    return box ? [box] : [];
  });
  const all = unionBox(boxes);
  if (!all || !top.length) return null;
  const parents = new Set(top.map((id) => doc.nodes[id]!.parentId));
  const parentId = parents.size === 1 ? ([...parents][0] ?? null) : null;
  const origin = parentId ? absolutePosition(doc, parentId) : { x: 0, y: 0 };
  const frameAbs = { x: Math.round(all.x - GROUP_PADDING), y: Math.round(all.y - GROUP_PADDING) };
  const size = { w: Math.round(all.w + GROUP_PADDING * 2), h: Math.round(all.h + GROUP_PADDING * 2) };
  const node = frameNode({ x: frameAbs.x - origin.x, y: frameAbs.y - origin.y }, size, parentId);
  const index = Math.min(...top.map((id) => doc.order.indexOf(id)).filter((i) => i >= 0));
  const ops: CanvasOp[] = [{ op: "addNode", node, ...(Number.isFinite(index) && { index }) }];
  for (const id of top) {
    const at = absolutePosition(doc, id);
    ops.push({
      op: "reparent",
      id,
      parentId: node.id,
      position: { x: at.x - frameAbs.x, y: at.y - frameAbs.y },
    });
  }
  return { ops, frameId: node.id };
}

/** Ungroup (⇧⌘G): hand a frame's children to its own parent, where they are, then drop the frame. */
export function ungroupOps(doc: DocSlice, frameIds: readonly string[]): CanvasOp[] {
  const ops: CanvasOp[] = [];
  for (const frameId of frameIds) {
    const frame = doc.nodes[frameId];
    if (!frame || frame.type !== FRAME_TYPE) continue;
    for (const child of doc.order.filter((id) => doc.nodes[id]?.parentId === frameId)) {
      const c = doc.nodes[child]!;
      ops.push({
        op: "reparent",
        id: child,
        parentId: frame.parentId,
        position: { x: c.position.x + frame.position.x, y: c.position.y + frame.position.y },
      });
    }
    ops.push({ op: "deleteNode", id: frameId });
  }
  return ops;
}

/**
 * Where a dragged node belongs once dropped (§7.9): the innermost frame under its centre that isn't
 * itself or inside it, or the top level. Collapsed frames don't take drops.
 */
export function frameAtPoint(doc: DocSlice, nodeId: string, centre: Point, sizeOf: SizeOf): string | null {
  const own = new Set([nodeId, ...containedIn(doc, nodeId)]);
  let best: { id: string; depth: number } | null = null;
  for (const id of doc.order) {
    const frame = doc.nodes[id];
    if (!frame || frame.type !== FRAME_TYPE || own.has(id) || frame.collapsed) continue;
    const box = nodeBox(doc, id, sizeOf);
    if (!box) continue;
    if (centre.x < box.x || centre.x > box.x + box.w || centre.y < box.y || centre.y > box.y + box.h)
      continue;
    let depth = 0;
    for (let at = frame.parentId; at !== null; at = doc.nodes[at]?.parentId ?? null) depth++;
    if (!best || depth >= best.depth) best = { id, depth };
  }
  return best?.id ?? null;
}

/** The reparent a drop implies, or null when the node stays in its frame. */
export function dropOp(doc: DocSlice, nodeId: string, sizeOf: SizeOf): CanvasOp | null {
  const box = nodeBox(doc, nodeId, sizeOf);
  const frame = doc.nodes[nodeId];
  if (!box || !frame) return null;
  const target = frameAtPoint(doc, nodeId, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, sizeOf);
  if (target === frame.parentId) return null;
  const origin = target ? absolutePosition(doc, target) : { x: 0, y: 0 };
  return {
    op: "reparent",
    id: nodeId,
    parentId: target,
    position: { x: Math.round(box.x - origin.x), y: Math.round(box.y - origin.y) },
  };
}

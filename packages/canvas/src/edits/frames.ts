import type { NodeRegistry } from "../nodes/registry";
import { childrenOf, isLocked } from "../store/graph";
import { applyOps, type CanvasOp, type DocSlice } from "../store/ops";
import { type BoxSource, grownFrame, nodeRect, type Rect } from "./place";

// Frames hold what's in them (§7.9). After an agent's edits, each frame they reached, directly or
// through what's in it, grows until everything in it sits inside its insets: 24 at the sides and
// bottom, 48 on top for the title. A frame never shrinks here. When something sits left of or above
// it, the frame reaches out that way and what's in it shifts back by as much, so nothing moves on
// screen. Locked frames stay as they are. Plain document ops, so tabs replay them like any edit.

export interface FittedFrames {
  ops: CanvasOp[];
  doc: DocSlice;
  /** Frames that grew. */
  grown: string[];
}

export function fitFrames(
  doc: DocSlice,
  specs: NodeRegistry,
  frameIds: Iterable<string>,
  source?: BoxSource,
): FittedFrames {
  const depth = (id: string) => {
    let d = 0;
    for (
      let at = doc.nodes[id]?.parentId ?? null;
      at !== null && d < 64;
      at = doc.nodes[at]?.parentId ?? null
    )
      d++;
    return d;
  };
  // Innermost first, so a frame that grows is the right size by the time the one around it fits.
  const frames = [...new Set(frameIds)]
    .filter((id) => doc.nodes[id]?.type === "frame" && !isLocked(doc, id))
    .sort((a, b) => depth(b) - depth(a));
  let current = doc;
  const ops: CanvasOp[] = [];
  const grown: string[] = [];
  for (const id of frames) {
    const frame = current.nodes[id]!;
    const box = nodeRect(current, specs, id, source);
    const children = childrenOf(current, id);
    if (!box || !children.length) continue;
    let need: Rect = box;
    for (const child of children) {
      const rect = nodeRect(current, specs, child, source);
      if (rect) need = grownFrame(need, rect);
    }
    // Whole pixels, rounded outwards.
    const x = Math.floor(need.x);
    const y = Math.floor(need.y);
    const w = Math.ceil(need.x + need.w) - x;
    const h = Math.ceil(need.y + need.h) - y;
    const dx = Math.max(0, Math.round(box.x - x));
    const dy = Math.max(0, Math.round(box.y - y));
    if (!dx && !dy && w <= Math.ceil(box.w) && h <= Math.ceil(box.h)) continue;
    const next: CanvasOp[] = [];
    if (dx || dy) {
      for (const child of children) {
        const at = current.nodes[child]!.position;
        next.push({ op: "moveNode", id: child, position: { x: at.x + dx, y: at.y + dy } });
      }
    }
    next.push({
      op: "resizeNode",
      id,
      size: { w: Math.max(w, box.w + dx), h: Math.max(h, box.h + dy) },
      ...((dx || dy) && { position: { x: frame.position.x - dx, y: frame.position.y - dy } }),
    });
    current = applyOps(current, next).doc;
    ops.push(...next);
    grown.push(id);
  }
  return { ops, doc: current, grown };
}

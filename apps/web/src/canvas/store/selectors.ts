import type { NodeRuntime } from "@openfield/canvas/engine/types";
import type { CanvasState } from "./types";

// Plain selectors, usable with useCanvas, useCanvasShallow or getState().

const ACTIVE_STATES = new Set<NodeRuntime["state"]>(["queued", "running"]);

/** Any node on the canvas is queued or running: the top bar shows Stop. */
export const selectAnyRunning = (state: CanvasState): boolean =>
  Object.values(state.runtime).some((r) => ACTIVE_STATES.has(r.state));

const childCounts = new WeakMap<CanvasState["doc"]["nodes"], ReadonlyMap<string, number>>();

/**
 * How many nodes sit directly in a frame. Counted once per document change for every frame, so
 * frames don't each walk the whole canvas.
 */
export function selectChildCount(state: CanvasState, frameId: string): number {
  const { nodes, order } = state.doc;
  let counts = childCounts.get(nodes);
  if (!counts) {
    const next = new Map<string, number>();
    for (const id of order) {
      const parent = nodes[id]?.parentId;
      if (parent) next.set(parent, (next.get(parent) ?? 0) + 1);
    }
    childCounts.set(nodes, next);
    counts = next;
  }
  return counts.get(frameId) ?? 0;
}

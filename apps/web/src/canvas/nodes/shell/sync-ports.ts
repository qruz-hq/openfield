import { useStoreApi } from "@xyflow/react";
import { useLayoutEffect, useRef } from "react";
import { type Measured, sameMeasure } from "../../editor/flow/adapter";

// Ports sit on a card's middle, so they move whenever its box does (an aspect ratio picked in the
// settings, a new image). A node with a known box carries its handles (flow/handles.ts), and React
// Flow places its links from them in the same frame. A card it can't place that way has React Flow
// measure it again: every such card of a render at once, before the frame is painted.

type FlowStore = ReturnType<typeof useStoreApi>;

const pending = new Map<FlowStore, Set<string>>();
let scheduled = false;

function flush() {
  scheduled = false;
  for (const [flow, ids] of pending) {
    const { domNode, updateNodeInternals } = flow.getState();
    const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
    for (const id of ids) {
      const nodeElement = domNode?.querySelector<HTMLDivElement>(
        `.react-flow__node[data-id="${CSS.escape(id)}"]`,
      );
      if (nodeElement) updates.set(id, { id, nodeElement, force: true });
    }
    if (updates.size) updateNodeInternals(updates);
  }
  pending.clear();
}

function queue(flow: FlowStore, id: string) {
  let ids = pending.get(flow);
  if (!ids) {
    ids = new Set();
    pending.set(flow, ids);
  }
  ids.add(id);
  if (scheduled) return;
  scheduled = true;
  // After every layout effect of this render, before the paint. While a fit to the nodes waits for
  // them all to be measured, a frame later like React Flow's own hook: measuring a node early would
  // fit the view to that node alone.
  if (flow.getState().fitViewQueued) requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

/**
 * Keeps a card's port handles on its edge as its box changes. `width` and `height` are the box React
 * Flow's wrapper has in this render, so the DOM is already resized. The first box is React Flow's
 * to measure, like every node's.
 */
export function useSyncPorts(id: string, width: number | undefined, height: number | undefined) {
  const flow = useStoreApi();
  const last = useRef<Measured | null>(null);
  useLayoutEffect(() => {
    if (!width || !height) return;
    const before = last.current;
    last.current = { width, height };
    if (!before || sameMeasure(before, last.current)) return;
    if (flow.getState().nodeLookup.get(id)?.handles) return;
    queue(flow, id);
  }, [flow, id, width, height]);
}

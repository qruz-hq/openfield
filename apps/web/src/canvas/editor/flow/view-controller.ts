import type { ReactFlowInstance } from "@xyflow/react";
import type { ViewController } from "../../store/types";
import type { FlowEdge, FlowNode } from "./adapter";

// Pane moves other parts ask for: Find centring a match, "Generate finished · Jump to node",
// Zoom to fit, keeping a new or edited node in view, and screen-to-pane conversion for menus
// opened from outside the pane.

export const FIT_PADDING = 0.15;
const MOVE_MS = 240;

export function nodeRect(rf: ReactFlowInstance<FlowNode, FlowEdge>, id: string) {
  const node = rf.getInternalNode(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? node.width ?? 0;
  const h = node.measured.height ?? node.height ?? 0;
  return { x, y, w, h };
}

/** The pane's visible area in pane units. */
export function visibleRect(
  rf: ReactFlowInstance<FlowNode, FlowEdge>,
  pane: { width: number; height: number },
) {
  const { x, y, zoom } = rf.getViewport();
  return { x: -x / zoom, y: -y / zoom, w: pane.width / zoom, h: pane.height / zoom };
}

function paneSize(): { width: number; height: number } {
  const el = document.querySelector(".of-canvas .react-flow");
  const box = el?.getBoundingClientRect();
  return { width: box?.width ?? window.innerWidth, height: box?.height ?? window.innerHeight };
}

export function createViewController(rf: ReactFlowInstance<FlowNode, FlowEdge>): ViewController {
  return {
    ready: true,
    focusNode(nodeId) {
      const rect = nodeRect(rf, nodeId);
      if (!rect) return;
      // Centre it at the current zoom, never past 100%.
      const zoom = Math.min(rf.getZoom(), 1);
      void rf.setCenter(rect.x + rect.w / 2, rect.y + rect.h / 2, { zoom, duration: MOVE_MS });
    },
    fitView() {
      void rf.fitView({ padding: FIT_PADDING, duration: MOVE_MS });
    },
    screenToFlow(point) {
      return rf.screenToFlowPosition(point);
    },
    revealNode(nodeId, insets = {}) {
      const rect = nodeRect(rf, nodeId);
      if (!rect) return;
      const { x, y, zoom } = rf.getViewport();
      const pane = paneSize();
      const inset = { top: 64, right: 12, bottom: 72, left: 12, ...insets };
      // The node's box on screen, and how far it has to move to sit inside the free area.
      const left = rect.x * zoom + x;
      const top = rect.y * zoom + y;
      const right = left + rect.w * zoom;
      const bottom = top + rect.h * zoom;
      const shift = (lo: number, hi: number, min: number, max: number) =>
        hi - lo > max - min ? min - lo : lo < min ? min - lo : hi > max ? max - hi : 0;
      const dx = shift(left, right, inset.left, pane.width - inset.right);
      const dy = shift(top, bottom, inset.top, pane.height - inset.bottom);
      if (dx || dy) void rf.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: MOVE_MS });
    },
    isNodeVisible(nodeId) {
      const rect = nodeRect(rf, nodeId);
      if (!rect) return false;
      const view = visibleRect(rf, paneSize());
      return (
        rect.x < view.x + view.w &&
        rect.x + rect.w > view.x &&
        rect.y < view.y + view.h &&
        rect.y + rect.h > view.y
      );
    },
  };
}

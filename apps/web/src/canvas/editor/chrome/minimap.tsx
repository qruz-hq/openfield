import { t } from "@openfield/core";
import { type ReactFlowState, useReactFlow, useStore } from "@xyflow/react";
import { type PointerEvent, useRef } from "react";
import { shallow } from "zustand/shallow";
import { nodeRegistry } from "../../nodes/registry";
import { type FlowEdge, type FlowNode, FRAME_NODE_TYPE } from "../flow/adapter";
import { type Box, unionBox } from "../geometry";

// Minimap (design zM5C9): 205×132 on $elevated, 1 px $border, radius 12. Nodes are flat rects
// (frames $elevated-2, runnable nodes $border-strong, the rest $border) and the view is an
// $accent-soft rect with a 1 px $accent line. Click or drag to move the view there.

const WIDTH = 205;
const HEIGHT = 132;
const INSET = 16;

interface MiniNode extends Box {
  id: string;
  fill: string;
}

const selectNodes = (s: ReactFlowState): MiniNode[] => {
  const out: MiniNode[] = [];
  for (const node of s.nodeLookup.values()) {
    if (node.hidden) continue;
    const w = node.measured.width ?? node.width ?? 0;
    const h = node.measured.height ?? node.height ?? 0;
    if (!w || !h) continue;
    const { x, y } = node.internals.positionAbsolute;
    const fill =
      node.type === FRAME_NODE_TYPE
        ? "var(--of-elevated-2)"
        : nodeRegistry.get(node.type ?? "")?.runnable
          ? "var(--of-border-strong)"
          : "var(--of-border)";
    out.push({ id: node.id, x, y, w, h, fill });
  }
  // Frames first so the nodes inside them draw on top.
  return out.sort(
    (a, b) => Number(b.fill === "var(--of-elevated-2)") - Number(a.fill === "var(--of-elevated-2)"),
  );
};

const sameNodes = (a: MiniNode[], b: MiniNode[]) =>
  a.length === b.length &&
  a.every((n, i) => {
    const m = b[i]!;
    return n.id === m.id && n.x === m.x && n.y === m.y && n.w === m.w && n.h === m.h && n.fill === m.fill;
  });

const selectView = (s: ReactFlowState) => ({
  x: s.transform[0],
  y: s.transform[1],
  zoom: s.transform[2],
  width: s.width,
  height: s.height,
});

export function Minimap() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const nodes = useStore(selectNodes, sameNodes);
  const view = useStore(selectView, shallow);
  const dragging = useRef(false);

  const visible: Box = {
    x: -view.x / view.zoom,
    y: -view.y / view.zoom,
    w: view.width / view.zoom,
    h: view.height / view.zoom,
  };
  // Until React Flow has measured the pane there's nothing to draw.
  const measured = view.width > 0 && view.height > 0 && view.zoom > 0;
  const bounds = unionBox(measured ? [...nodes, visible] : nodes) ?? { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.min(
    (WIDTH - INSET * 2) / Math.max(bounds.w, 1),
    (HEIGHT - INSET * 2) / Math.max(bounds.h, 1),
  );
  const ox = (WIDTH - bounds.w * scale) / 2 - bounds.x * scale;
  const oy = (HEIGHT - bounds.h * scale) / 2 - bounds.y * scale;
  const toPane = (px: number, py: number) => ({ x: (px - ox) / scale, y: (py - oy) / scale });

  const moveTo = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = toPane(e.clientX - box.left, e.clientY - box.top);
    void rf.setCenter(at.x, at.y, { zoom: view.zoom, duration: dragging.current ? 0 : 200 });
  };

  return (
    <div className="h-132 w-205 overflow-hidden rounded-12 bg-elevated inset-ring inset-ring-border shadow-popover">
      <svg
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={t("canvas.editor.zoom.minimap")}
        className="block cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
          dragging.current = true;
        }}
        onPointerMove={(e) => {
          if (dragging.current) moveTo(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
      >
        {nodes.map((n) => (
          <rect
            key={n.id}
            x={n.x * scale + ox}
            y={n.y * scale + oy}
            width={Math.max(1, n.w * scale)}
            height={Math.max(1, n.h * scale)}
            rx={2}
            fill={n.fill}
          />
        ))}
        {measured ? (
          <rect
            x={visible.x * scale + ox}
            y={visible.y * scale + oy}
            width={visible.w * scale}
            height={visible.h * scale}
            rx={4}
            className="fill-accent-soft stroke-accent"
            strokeWidth={1}
          />
        ) : null}
      </svg>
    </div>
  );
}

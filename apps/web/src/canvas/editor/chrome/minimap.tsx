import { t } from "@openfield/core";
import { type ReactFlowState, useReactFlow, useStoreApi } from "@xyflow/react";
import { type PointerEvent, useEffect, useRef } from "react";
import { onThemeChange, resolveColors } from "../../../lib/theme";
import { nodeRegistry } from "../../nodes/registry";
import { type FlowEdge, type FlowNode, FRAME_NODE_TYPE } from "../flow/adapter";
import { type Box, unionBox } from "../geometry";

// Minimap (design zM5C9): 205×132 on $elevated, 1 px $border, radius 12. Nodes are flat rects
// (frames $elevated-2, runnable nodes $border-strong, the rest $border) and the view is an
// $accent-soft rect with a 1 px $accent line. Click or drag to move the view there. Drawn on a
// canvas straight from React Flow's store, once a frame while the view moves: a pan re-renders
// nothing, however many nodes there are.

const WIDTH = 205;
const HEIGHT = 132;
const INSET = 16;

type Fill = "frame" | "runnable" | "other";

interface MiniNode extends Box {
  fill: Fill;
}

const TOKENS = {
  frame: "--of-elevated-2",
  runnable: "--of-border-strong",
  other: "--of-border",
  view: "--of-accent-soft",
  viewLine: "--of-accent",
} as const;

function readNodes(s: ReactFlowState<FlowNode, FlowEdge>): MiniNode[] {
  const frames: MiniNode[] = [];
  const rest: MiniNode[] = [];
  for (const node of s.nodeLookup.values()) {
    if (node.hidden) continue;
    const w = node.measured.width ?? node.width ?? 0;
    const h = node.measured.height ?? node.height ?? 0;
    if (!w || !h) continue;
    const { x, y } = node.internals.positionAbsolute;
    if (node.type === FRAME_NODE_TYPE) frames.push({ x, y, w, h, fill: "frame" });
    else rest.push({ x, y, w, h, fill: nodeRegistry.get(node.type ?? "")?.runnable ? "runnable" : "other" });
  }
  // Frames first so the nodes inside them draw on top.
  return [...frames, ...rest];
}

/** The pane's visible area, in pane units, once React Flow has measured the pane. */
function visibleBox(s: ReactFlowState<FlowNode, FlowEdge>): Box | null {
  const [tx, ty, zoom] = s.transform;
  if (!(s.width > 0 && s.height > 0 && zoom > 0)) return null;
  return { x: -tx / zoom, y: -ty / zoom, w: s.width / zoom, h: s.height / zoom };
}

/** Pane to minimap: everything on the canvas and the view, centred and inset. */
function fit(nodes: readonly MiniNode[], view: Box | null) {
  const bounds = unionBox(view ? [...nodes, view] : nodes) ?? { x: 0, y: 0, w: 1, h: 1 };
  const scale = Math.min(
    (WIDTH - INSET * 2) / Math.max(bounds.w, 1),
    (HEIGHT - INSET * 2) / Math.max(bounds.h, 1),
  );
  return {
    scale,
    ox: (WIDTH - bounds.w * scale) / 2 - bounds.x * scale,
    oy: (HEIGHT - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

export function Minimap() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const flow = useStoreApi<FlowNode, FlowEdge>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const nodes = useRef<MiniNode[]>([]);
  const dragging = useRef(false);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let seen: unknown = null;
    let colors: Record<keyof typeof TOKENS, string> | null = null;
    let frame = 0;

    const draw = () => {
      frame = 0;
      const s = flow.getState();
      // Nodes change far less often than the view: read them again only when React Flow's do.
      if (s.nodes !== seen) {
        seen = s.nodes;
        nodes.current = readNodes(s);
      }
      colors ??= resolveColors(el, TOKENS);
      const dpr = window.devicePixelRatio || 1;
      if (el.width !== Math.round(WIDTH * dpr)) {
        el.width = Math.round(WIDTH * dpr);
        el.height = Math.round(HEIGHT * dpr);
      }
      const view = visibleBox(s);
      const { scale, ox, oy } = fit(nodes.current, view);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      for (const n of nodes.current) {
        ctx.fillStyle = colors[n.fill];
        ctx.beginPath();
        ctx.roundRect(
          n.x * scale + ox,
          n.y * scale + oy,
          Math.max(1, n.w * scale),
          Math.max(1, n.h * scale),
          2,
        );
        ctx.fill();
      }
      if (view) {
        // The line sits inside the view's box, like the SVG stroke it replaces sat on its edge.
        ctx.beginPath();
        ctx.roundRect(view.x * scale + ox, view.y * scale + oy, view.w * scale, view.h * scale, 4);
        ctx.fillStyle = colors.view;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = colors.viewLine;
        ctx.stroke();
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    const unsubscribe = flow.subscribe(schedule);
    const unwatch = onThemeChange(() => {
      colors = null;
      schedule();
    });
    return () => {
      unsubscribe();
      unwatch();
      cancelAnimationFrame(frame);
    };
  }, [flow]);

  const moveTo = (e: PointerEvent<HTMLCanvasElement>) => {
    const s = flow.getState();
    const box = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = fit(nodes.current, visibleBox(s));
    const at = { x: (e.clientX - box.left - ox) / scale, y: (e.clientY - box.top - oy) / scale };
    void rf.setCenter(at.x, at.y, { zoom: s.transform[2], duration: dragging.current ? 0 : 200 });
  };

  return (
    <div className="h-132 w-205 overflow-hidden rounded-12 bg-elevated inset-ring inset-ring-border shadow-popover">
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={t("canvas.editor.zoom.minimap")}
        className="block h-132 w-205 cursor-pointer touch-none"
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
      />
    </div>
  );
}

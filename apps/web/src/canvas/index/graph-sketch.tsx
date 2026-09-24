import type { CanvasDocument } from "@openfield/core/canvas";
import { cn } from "@openfield/ui";
import { Image as ImageIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { roundedRectPath, type SketchColor, type SketchShape, sketchLayout } from "./sketch";

// Draws a graph as the design's card sketch (KkAp5, MF9Sm): the dotted pane, node boxes, ports and
// edges. Cards are 16:9, so everything is laid out on the design's 320×180 box and scales with it.

export const SKETCH_WIDTH = 320;
export const SKETCH_HEIGHT = 180;

// Full class names, so Tailwind finds them.
const FILL: Record<SketchColor, string> = {
  surface: "fill-surface",
  elevated: "fill-elevated",
  "elevated-2": "fill-elevated-2",
  border: "fill-border",
  "border-strong": "fill-border-strong",
  accent: "fill-accent",
  "accent-soft": "fill-accent-soft",
  "accent-line": "fill-accent-line",
};
const STROKE: Record<SketchColor, string> = {
  surface: "stroke-surface",
  elevated: "stroke-elevated",
  "elevated-2": "stroke-elevated-2",
  border: "stroke-border",
  "border-strong": "stroke-border-strong",
  accent: "stroke-accent",
  "accent-soft": "stroke-accent-soft",
  "accent-line": "stroke-accent-line",
};

/** useId, made safe for url(#…) references. */
export function usePatternId(): string {
  return `dots${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Canvas / Pane / Dots (DSM0X): 2px dots every 24px from 12,12. */
export function SketchDots({ id }: { id: string }) {
  return (
    <>
      <defs>
        <pattern id={id} width={24} height={24} patternUnits="userSpaceOnUse">
          <circle cx={12} cy={12} r={1} className="fill-grid-dot" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </>
  );
}

function Shape({ shape }: { shape: SketchShape }) {
  switch (shape.kind) {
    case "rect": {
      if (!shape.fill && !shape.stroke) return null;
      // Design strokes sit inside the box; a centred 1px stroke on a box inset by half does the same.
      const inset = shape.stroke ? 0.5 : 0;
      const r =
        typeof shape.r === "number"
          ? Math.max(0, shape.r - inset)
          : (shape.r.map((v) => Math.max(0, v - inset)) as [number, number, number, number]);
      return (
        <path
          d={roundedRectPath(
            shape.x + inset,
            shape.y + inset,
            Math.max(0, shape.w - inset * 2),
            Math.max(0, shape.h - inset * 2),
            r,
          )}
          className={cn(shape.fill ? FILL[shape.fill] : "fill-none", shape.stroke && STROKE[shape.stroke])}
          strokeWidth={shape.stroke ? 1 : undefined}
          vectorEffect="non-scaling-stroke"
          opacity={shape.opacity}
        />
      );
    }
    case "mark":
      return (
        <ImageIcon
          x={shape.cx - shape.size / 2}
          y={shape.cy - shape.size / 2}
          size={shape.size}
          className="text-border-strong"
        />
      );
    case "port":
      return (
        <circle
          cx={shape.cx}
          cy={shape.cy}
          r={Math.max(0, shape.r - 0.5)}
          className="fill-elevated-2 stroke-border-strong"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      );
    case "edge":
      return (
        <path
          d={shape.d}
          className="fill-none stroke-border-strong"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      );
  }
}

export interface GraphSketchProps {
  graph: Pick<CanvasDocument, "nodes" | "edges"> | null;
  /** [top, right, bottom, left] around the graph. */
  padding?: readonly [number, number, number, number];
  className?: string;
}

const CARD_PADDING = [20, 20, 20, 20] as const;

/** The whole preview: dots, then the graph when there is one. Decorative; the card names it. */
export function GraphSketch({ graph, padding = CARD_PADDING, className }: GraphSketchProps) {
  const dots = usePatternId();
  const layout = useMemo(
    () =>
      graph
        ? sketchLayout(graph.nodes, graph.edges, { width: SKETCH_WIDTH, height: SKETCH_HEIGHT, padding })
        : null,
    [graph, padding],
  );
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      className={cn("absolute inset-0 size-full", className)}
    >
      <SketchDots id={dots} />
      {layout?.shapes.map((shape, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole, never reordered.
        <Shape key={i} shape={shape} />
      ))}
    </svg>
  );
}

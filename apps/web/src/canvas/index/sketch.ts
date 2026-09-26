import type { CanvasEdge, CanvasNode } from "@openfield/core/canvas";

// The graph sketch on index and template cards: node boxes, ports and bezier edges drawn from the
// document, with no images (design KkAp5 card previews, MF9Sm template previews). Pure, so the
// layout is tested without a browser. Values are in node units (the editor's pixels at 100%); the
// design draws its sketches at a quarter of that, which is also the largest scale used here.

export type SketchColor =
  | "surface"
  | "elevated"
  | "elevated-2"
  | "border"
  | "border-strong"
  | "accent"
  | "accent-soft"
  | "accent-line";

export type SketchShape =
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      /** One radius, or [top-left, top-right, bottom-right, bottom-left]. */
      r: number | readonly [number, number, number, number];
      fill?: SketchColor;
      stroke?: SketchColor;
      opacity?: number;
    }
  /** The empty image mark (Lucide image), centred at cx, cy. */
  | { kind: "mark"; cx: number; cy: number; size: number }
  | { kind: "port"; cx: number; cy: number; r: number }
  | { kind: "edge"; d: string };

export interface SketchBox {
  width: number;
  height: number;
  /** [top, right, bottom, left] */
  padding: readonly [number, number, number, number];
  /** The design's sketches are a quarter of the real size; small graphs never grow past it. */
  maxScale?: number;
}

export interface SketchLayout {
  scale: number;
  shapes: SketchShape[];
}

type SketchNode = Pick<CanvasNode, "id" | "type" | "position" | "size" | "parentId" | "collapsed" | "params">;
type SketchEdge = Pick<CanvasEdge, "source" | "sourceHandle" | "target" | "targetHandle" | "kind">;

const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  prompt: { w: 296, h: 151 },
  "image.upload": { w: 280, h: 280 },
  "image.asset": { w: 280, h: 280 },
  "image.generate": { w: 320, h: 400 },
  "image.variations": { w: 320, h: 360 },
  note: { w: 240, h: 240 },
  frame: { w: 640, h: 420 },
  shape: { w: 210, h: 126 },
};
const FALLBACK_SIZE = { w: 280, h: 280 };
const COLLAPSED_HEIGHT = 56;

// Visible ports in rail order (canvas plan §1); null is a slot kept empty for a port still to
// come (Generate's style input). Types this build doesn't define (Edit, Style) take their ports
// from the edges that touch them.
const PORTS: Record<string, { in: readonly (string | null)[]; out: readonly (string | null)[] }> = {
  prompt: { in: ["text"], out: ["text"] },
  "image.upload": { in: [], out: ["images"] },
  "image.asset": { in: [], out: ["images"] },
  "image.generate": { in: ["prompt", "input_images", null], out: ["images"] },
  "image.variations": { in: ["image", "prompt"], out: ["images"] },
  note: { in: [], out: [] },
  frame: { in: [], out: [] },
  text: { in: [], out: [] },
  shape: { in: [], out: [] },
};

const PORT_SPACING = 36;
const PORT_RADIUS = 10;
const NODE_RADIUS = 16;
const FRAME_TITLE = { y: -44, w: 152, h: 28, r: 14 };
/** Below this scale the boxes are too small for ports and inner parts to read. */
const DETAIL_SCALE = 0.1;
/** Past this many nodes only the boxes are drawn. */
const DETAIL_NODES = 400;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

export function nodeBox(node: SketchNode): { w: number; h: number } {
  // Text is sized by its content, so a saved one may have no box.
  const size =
    node.size ??
    (node.type === "text"
      ? { w: Math.max(40, str(node.params.text).length * 9), h: 24 }
      : (DEFAULT_SIZES[node.type] ?? FALLBACK_SIZE));
  return { w: size.w, h: node.collapsed ? COLLAPSED_HEIGHT : size.h };
}

/** Port centres from the node's top: 36 apart around the vertical middle (Canvas kit pUPWt). */
function rail(count: number, height: number): number[] {
  const first = height / 2 - ((count - 1) * PORT_SPACING) / 2;
  return Array.from({ length: count }, (_, i) => first + i * PORT_SPACING);
}

/** The rounded-rect path, with a radius per corner. */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | readonly [number, number, number, number],
): string {
  const max = Math.min(w, h) / 2;
  const clamp = (v: number) => Math.min(Math.max(0, v), max);
  const [tl, tr, br, bl] = typeof r === "number" ? [r, r, r, r].map(clamp) : r.map(clamp);
  return [
    `M${x + tl!} ${y}`,
    `H${x + w - tr!}`,
    tr ? `A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}` : "",
    `V${y + h - br!}`,
    br ? `A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` : "",
    `H${x + bl!}`,
    bl ? `A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}` : "",
    `V${y + tl!}`,
    tl ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join("");
}

/** Line widths for a block of text, as a fraction of the box: a few bars, the last one shorter. */
function textBars(text: string, perLine: number): number[] {
  const length = text.trim().length;
  if (!length) return [0.35];
  const lines = Math.min(3, Math.ceil(length / perLine));
  const full = [0.78, 0.6, 0.39];
  return full.slice(0, lines).map((width, i) => {
    if (i < lines - 1) return width;
    const rest = (length - i * perLine) / perLine;
    return Math.max(0.2, Math.min(width, rest * 0.78));
  });
}

interface Placed {
  node: SketchNode;
  x: number;
  y: number;
  w: number;
  h: number;
  ports: { in: (string | null)[]; out: (string | null)[] };
}

/** Rects inside a node, in node units relative to its top-left. */
function parts(p: Placed): SketchShape[] {
  const { node, w, h } = p;
  const r = NODE_RADIUS;
  const bar = (x: number, y: number, width: number): SketchShape => ({
    kind: "rect",
    x,
    y,
    w: width,
    h: 10,
    r: 5,
    fill: "border-strong",
  });
  if (node.collapsed) return [];
  switch (node.type) {
    case "prompt":
      return [
        { kind: "rect", x: 8, y: 8, w: w - 16, h: h - 16, r: 12, fill: "surface" },
        ...textBars(str(node.params.text), 48).map((f, i) => bar(20, 24 + i * 18, f * w)),
      ];
    case "image.generate": {
      const image = h - 90;
      return [
        { kind: "rect", x: 0, y: 0, w, h: image, r: [r, r, 0, 0], fill: "surface" },
        { kind: "mark", cx: w / 2, cy: image / 2, size: 56 },
        bar(12, h - 78, (str(node.params.prompt).trim() ? 0.6 : 0.35) * w),
        { kind: "rect", x: 12, y: h - 43, w: 0.46 * w, h: 20, r: 10, fill: "elevated-2" },
        { kind: "rect", x: w - 64, y: h - 43, w: 52, h: 20, r: 10, fill: "accent" },
      ];
    }
    case "image.variations": {
      const cell = (w - 4) / 2;
      return [
        { kind: "rect", x: 0, y: 0, w: cell, h: 124, r: [r, 0, 0, 0], fill: "surface" },
        { kind: "rect", x: cell + 4, y: 0, w: cell, h: 124, r: [0, r, 0, 0], fill: "surface" },
        { kind: "rect", x: 0, y: 128, w: cell, h: 124, r: 0, fill: "surface" },
        { kind: "rect", x: cell + 4, y: 128, w: cell, h: 124, r: 0, fill: "surface" },
        { kind: "rect", x: 12, y: 266, w: w - 24, h: 20, r: 10, fill: "surface" },
        { kind: "rect", x: w - 64, y: h - 32, w: 52, h: 20, r: 10, fill: "accent" },
      ];
    }
    case "image.upload":
    case "image.asset": {
      const image = h - 72;
      const thumbs = Math.min(2, count(node.params.assetIds));
      const shapes: SketchShape[] = [
        { kind: "rect", x: 0, y: 0, w, h: image, r: [r, r, 0, 0], fill: "surface" },
        { kind: "mark", cx: w / 2, cy: image / 2, size: 56 },
      ];
      for (let i = 0; i < thumbs; i++) {
        shapes.push({ kind: "rect", x: 16 + i * 52, y: image + 16, w: 40, h: 40, r: 8, fill: "elevated-2" });
      }
      shapes.push({
        kind: "rect",
        x: 16 + thumbs * 52,
        y: image + 16,
        w: 40,
        h: 40,
        r: 8,
        stroke: "border-strong",
      });
      return shapes;
    }
    case "note":
      return textBars(str(node.params.text), 24).map((f, i) => bar(16, 20 + i * 18, f * w));
    case "text":
      return [bar(0, 7, w)];
    default:
      return [];
  }
}

function body(p: Placed): { fill: SketchShape; outline: SketchShape; extra: SketchShape[] } {
  const { node, w, h } = p;
  const at = { kind: "rect" as const, x: 0, y: 0, w, h };
  switch (node.type) {
    case "frame":
      return {
        fill: { ...at, r: 20, fill: "elevated", opacity: 0.5 },
        outline: { ...at, r: 20, stroke: "border-strong" },
        extra: [{ kind: "rect", x: 0, ...FRAME_TITLE, fill: "elevated-2", stroke: "border" }],
      };
    case "note":
      return {
        fill: { ...at, r: 8, fill: "accent-soft" },
        outline: { ...at, r: 8, stroke: "accent-line" },
        extra: [{ ...at, r: 8, fill: "accent-soft" }],
      };
    case "shape":
      return {
        fill: { ...at, r: 8, fill: "elevated-2" },
        outline: { ...at, r: 8, stroke: "border-strong" },
        extra: [],
      };
    case "text":
      return { fill: { ...at, r: 0 }, outline: { ...at, r: 0 }, extra: [] };
    default:
      return {
        fill: { ...at, r: NODE_RADIUS, fill: "elevated" },
        outline: { ...at, r: NODE_RADIUS, stroke: "border" },
        extra: [],
      };
  }
}

function place(nodes: readonly SketchNode[], edges: readonly SketchEdge[]): Placed[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absolute = (node: SketchNode) => {
    let x = 0;
    let y = 0;
    let at: SketchNode | undefined = node;
    for (let guard = 0; at && guard < 64; guard++) {
      x += at.position.x;
      y += at.position.y;
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return { x, y };
  };
  const inferred = new Map<string, { in: string[]; out: string[] }>();
  for (const edge of edges) {
    if (edge.kind !== "data") continue;
    const add = (id: string, side: "in" | "out", handle: string) => {
      const ports = inferred.get(id) ?? { in: [], out: [] };
      if (!ports[side].includes(handle)) ports[side].push(handle);
      inferred.set(id, ports);
    };
    add(edge.source, "out", edge.sourceHandle);
    add(edge.target, "in", edge.targetHandle);
  }
  return nodes.map((node) => {
    const known = PORTS[node.type];
    const ports = known
      ? { in: [...known.in], out: [...known.out] }
      : (inferred.get(node.id) ?? { in: [], out: [] });
    return { node, ...absolute(node), ...nodeBox(node), ports };
  });
}

function portY(p: Placed, side: "in" | "out", handle: string): number {
  const list = p.ports[side];
  if (p.node.collapsed) return p.h / 2;
  const index = list.indexOf(handle);
  return index < 0 ? p.h / 2 : rail(list.length, p.h)[index]!;
}

export function sketchLayout(
  nodes: readonly SketchNode[],
  edges: readonly SketchEdge[],
  box: SketchBox,
): SketchLayout {
  const maxScale = box.maxScale ?? 0.25;
  if (!nodes.length) return { scale: maxScale, shapes: [] };
  const placed = place(nodes, edges);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of placed) {
    const overhang = p.ports.in.length || p.ports.out.length ? PORT_RADIUS : 0;
    minX = Math.min(minX, p.x - (p.ports.in.length ? overhang : 0));
    maxX = Math.max(maxX, p.x + p.w + (p.ports.out.length ? overhang : 0));
    minY = Math.min(minY, p.y + (p.node.type === "frame" ? FRAME_TITLE.y : 0));
    maxY = Math.max(maxY, p.y + p.h);
  }
  const [top, right, bottom, left] = box.padding;
  const availW = Math.max(1, box.width - left - right);
  const availH = Math.max(1, box.height - top - bottom);
  const spanW = Math.max(1, maxX - minX);
  const spanH = Math.max(1, maxY - minY);
  const scale = Math.min(maxScale, availW / spanW, availH / spanH);
  const offX = left + (availW - spanW * scale) / 2 - minX * scale;
  const offY = top + (availH - spanH * scale) / 2 - minY * scale;
  const X = (x: number) => offX + x * scale;
  const Y = (y: number) => offY + y * scale;

  const detailed = scale >= DETAIL_SCALE && nodes.length <= DETAIL_NODES;
  const toBox = (p: Placed, shape: SketchShape): SketchShape => {
    switch (shape.kind) {
      case "rect":
        return {
          ...shape,
          x: X(p.x + shape.x),
          y: Y(p.y + shape.y),
          w: shape.w * scale,
          h: shape.h * scale,
          r: typeof shape.r === "number" ? shape.r * scale : (shape.r.map((v) => v * scale) as never),
        };
      case "mark":
        return { ...shape, cx: X(p.x + shape.cx), cy: Y(p.y + shape.cy), size: shape.size * scale };
      case "port":
        return { ...shape, cx: X(p.x + shape.cx), cy: Y(p.y + shape.cy), r: shape.r * scale };
      default:
        return shape;
    }
  };

  // Frames sit under everything, then edges, then the other nodes and their ports.
  const frames = placed.filter((p) => p.node.type === "frame");
  const others = placed.filter((p) => p.node.type !== "frame");
  const shapes: SketchShape[] = [];
  const drawNode = (p: Placed) => {
    const b = body(p);
    shapes.push(toBox(p, b.fill));
    for (const extra of b.extra) shapes.push(toBox(p, extra));
    if (detailed) for (const part of parts(p)) shapes.push(toBox(p, part));
    shapes.push(toBox(p, b.outline));
  };
  for (const p of frames) drawNode(p);

  const byId = new Map(placed.map((p) => [p.node.id, p]));
  for (const edge of edges) {
    if (edge.kind !== "data") continue;
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    const x1 = X(from.x + from.w);
    const y1 = Y(from.y + portY(from, "out", edge.sourceHandle));
    const x2 = X(to.x);
    const y2 = Y(to.y + portY(to, "in", edge.targetHandle));
    const mid = (x1 + x2) / 2;
    shapes.push({ kind: "edge", d: `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` });
  }

  for (const p of others) {
    drawNode(p);
    if (!detailed) continue;
    for (const side of ["in", "out"] as const) {
      const list = p.ports[side];
      const ys = p.node.collapsed ? list.map(() => p.h / 2) : rail(list.length, p.h);
      ys.forEach((y, i) => {
        if (list[i] === null) return;
        shapes.push(toBox(p, { kind: "port", cx: side === "in" ? 0 : p.w, cy: y, r: PORT_RADIUS }));
      });
    }
  }
  return { scale, shapes };
}

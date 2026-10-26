import type { CanvasEdge } from "@openfield/core/canvas";
import { type InternalNode, Position, useStoreApi } from "@xyflow/react";
import { useEffect, useRef } from "react";
import { imagesLoading } from "../../../api/hooks/images";
import { onThemeChange, resolveColors } from "../../../lib/theme";
import { cardMedia } from "../../nodes/generate/card-media";
import { type CanvasState, useCanvasStoreApi } from "../../store";
import type { FlowEdge, FlowNode } from "./adapter";
import { createTileBitmaps, type Drawable, type TileBitmaps } from "./tile-bitmaps";

// Zoomed out (level of detail "canvas", below about 40%), every node is painted on this one canvas
// as a plain tile, Figma-style: image cards as their image, Assets and Upload as a 2×2 grid of
// their first images, notes, prompts and shapes as their fill, frames as their tint and line. Links
// are simple curves that fade out between 25% and 20%. Selection and running outlines are painted
// here too. React Flow keeps its own box around each node (empty, node-types.tsx), so selecting,
// dragging and box-selecting work as before; this layer only follows the store and the view, and
// paints at most once a frame, with no React render.
//
// It sits between the pane and React Flow's nodes. Zooming back in, it stays on top of the nodes
// until their images have loaded, then fades, so the cards never show empty.

const TOKENS = {
  elevated: "--of-elevated",
  elevated2: "--of-elevated-2",
  surface: "--of-surface",
  border: "--of-border",
  borderStrong: "--of-border-strong",
  accent: "--of-accent",
  accentLine: "--of-accent-line",
  note: "--of-note",
  textTertiary: "--of-text-tertiary",
} as const;
type Colors = Record<keyof typeof TOKENS, string>;

/** Links are fully drawn above this zoom and gone below LINKS_GONE. */
const LINKS_FULL = 0.25;
const LINKS_GONE = 0.2;
/** Past 300 links the DOM draws the cheaper curve (edges.tsx); so does this. */
const SIMPLE_EDGES_ABOVE = 300;
/** Gap between the images of a grid tile, in pane units (assets-node.tsx gap-2). */
const GRID_GAP = 2;
/** Corner radii in pane units: image and panel cards, notes and shapes, frames. */
const CARD_RADIUS = 14;
const SMALL_RADIUS = 8;
const FRAME_RADIUS = 16;
/** The zoom a fresh zoom-out lands at first: the images it needs are loaded at this size ahead. */
const FIRST_FAR_ZOOM = 0.38;
/** How long the view has to rest before images for the next zoom-out are loaded. */
const PREFETCH_AFTER_MS = 700;
/** Most images loaded ahead at once. */
const PREFETCH_MAX = 400;
/** Zooming back in, the layer stays over the nodes at most this long for their images. */
const HANDOFF_MAX_MS = 1200;
/** And at least this long, so images that just arrived get painted. */
const HANDOFF_MIN_MS = 120;
const FADE_MS = 150;

type Tile =
  | { kind: "image"; assetIds: readonly string[]; grid: boolean }
  | { kind: "fill"; fill: keyof Colors; line: keyof Colors; radius: number };

const RUNNING = new Set(["running", "queued"]);
const NO_IDS: readonly string[] = [];

const stringIds = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : NO_IDS;

/** What a node looks like zoomed out. Null: nothing here (text stays in the DOM, frames go first). */
function tileOf(c: CanvasState, id: string, type: string, shown: Record<string, string>): Tile | null {
  const node = c.doc.nodes[id];
  if (!node) return null;
  switch (type) {
    case "frame":
    case "text":
      return null;
    case "note":
      return { kind: "fill", fill: "note", line: "accentLine", radius: SMALL_RADIUS };
    case "shape":
      return { kind: "fill", fill: "elevated2", line: "borderStrong", radius: SMALL_RADIUS };
  }
  const panel: Tile = { kind: "fill", fill: "elevated", line: "border", radius: CARD_RADIUS };
  if (node.collapsed) return panel;
  switch (type) {
    case "image.generate":
    case "video.generate": {
      const made = c.doc.results[id]?.assetIds ?? NO_IDS;
      if (!made.length) return panel;
      const pick = shown[id];
      return { kind: "image", assetIds: [pick && made.includes(pick) ? pick : made[0]!], grid: false };
    }
    case "image.variations": {
      const made = c.doc.results[id]?.assetIds ?? NO_IDS;
      return made.length ? { kind: "image", assetIds: made.slice(0, 4), grid: true } : panel;
    }
    case "image.asset":
    case "image.upload": {
      const own = stringIds(c.doc.params[id]?.assetIds);
      return own.length ? { kind: "image", assetIds: own.slice(0, 4), grid: true } : panel;
    }
    default:
      return panel;
  }
}

interface Cell {
  assetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tile's images laid out like the Assets card: rows of two, the last row as wide as it needs. */
function cellsOf(tile: Extract<Tile, { kind: "image" }>, x: number, y: number, w: number, h: number): Cell[] {
  if (!tile.grid || tile.assetIds.length === 1) return [{ assetId: tile.assetIds[0]!, x, y, w, h }];
  const rows = [tile.assetIds.slice(0, 2), tile.assetIds.slice(2, 4)].filter((r) => r.length);
  const rowH = (h - GRID_GAP * (rows.length - 1)) / rows.length;
  const out: Cell[] = [];
  rows.forEach((row, r) => {
    const cellW = (w - GRID_GAP * (row.length - 1)) / row.length;
    row.forEach((assetId, i) => {
      out.push({ assetId, x: x + i * (cellW + GRID_GAP), y: y + r * (rowH + GRID_GAP), w: cellW, h: rowH });
    });
  });
  return out;
}

const sizeOf = (image: Drawable) =>
  "naturalWidth" in image
    ? { w: image.naturalWidth, h: image.naturalHeight }
    : { w: image.width, h: image.height };

/** Draws `image` to fill the box, cropped to its shape like object-fit: cover. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  image: Drawable,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const { w: sw, h: sh } = sizeOf(image);
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const cw = w / scale;
  const ch = h / scale;
  ctx.drawImage(image, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

/** A bezier control point, the way React Flow's getBezierPath and getSimpleBezierPath place it. */
function control(position: Position, x1: number, y1: number, x2: number, y2: number, simple: boolean) {
  const offset = (distance: number) => (distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance));
  const horizontal = position === Position.Left || position === Position.Right;
  if (simple) return horizontal ? { x: (x1 + x2) / 2, y: y1 } : { x: x1, y: (y1 + y2) / 2 };
  switch (position) {
    case Position.Left:
      return { x: x1 - offset(x1 - x2), y: y1 };
    case Position.Right:
      return { x: x1 + offset(x2 - x1), y: y1 };
    case Position.Top:
      return { x: x1, y: y1 - offset(y1 - y2) };
    default:
      return { x: x1, y: y1 + offset(y2 - y1) };
  }
}

/** A handle's centre in pane units, from the handles the adapter gives every node (handles.ts). */
function handleAt(node: InternalNode<FlowNode>, id: string | null, kind: "source" | "target") {
  const handles = node.internals.handleBounds?.[kind];
  const handle = handles?.find((h) => h.id === id) ?? (id === null ? handles?.[0] : undefined);
  if (!handle) return null;
  const { x, y } = node.internals.positionAbsolute;
  return {
    x: x + handle.x + handle.width / 2,
    y: y + handle.y + handle.height / 2,
    position: handle.position,
  };
}

export function CanvasLayer() {
  const flow = useStoreApi<FlowNode, FlowEdge>();
  const store = useCanvasStoreApi();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = ref.current;
    const context = el?.getContext("2d");
    const root = el?.closest<HTMLElement>(".react-flow");
    if (!el || !context || !root) return;
    const ctx = context;
    const bitmaps: TileBitmaps = createTileBitmaps();
    let colors: Colors | null = null;
    let raf = 0;
    let lastZoom = 0;
    /** "on" zoomed out; "over" briefly after zooming back in; "off" otherwise. */
    let mode: "on" | "over" | "off" = "off";
    let overSince = 0;
    let fade: ReturnType<typeof setTimeout> | undefined;
    let prefetchTimer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (!raf && mode !== "off") raf = requestAnimationFrame(draw);
    };

    const setMode = (next: typeof mode) => {
      if (next === mode) return;
      clearTimeout(fade);
      mode = next;
      el.dataset.mode = next;
      el.style.opacity = "";
      if (next === "over") overSince = performance.now();
      if (next === "off") ctx.clearRect(0, 0, el.width, el.height);
      schedule();
    };

    const draw = () => {
      raf = 0;
      if (mode === "off") return;
      const s = flow.getState();
      const c = store.getState();
      const [tx, ty, zoom] = s.transform;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(s.width * dpr);
      const height = Math.round(s.height * dpr);
      if (!width || !height) return;
      if (el.width !== width || el.height !== height) {
        el.width = width;
        el.height = height;
      }
      if (zoom !== lastZoom) {
        lastZoom = zoom;
        // The frame title pills keep their size on screen (frame-node.tsx).
        root.style.setProperty("--of-zoom", String(zoom));
        root.style.setProperty("--of-inv-zoom", String(1 / zoom));
      }
      colors ??= resolveColors(el, TOKENS);
      bitmaps.frame();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * tx, dpr * ty);
      const px = 1 / zoom;
      const view = { x: -tx / zoom, y: -ty / zoom, r: (s.width - tx) / zoom, b: (s.height - ty) / zoom };
      const inView = (x: number, y: number, w: number, h: number) =>
        x < view.r && x + w > view.x && y < view.b && y + h > view.y;
      const over = mode === "over";
      const shown = cardMedia.getState().shown;
      const clipCorners = CARD_RADIUS * zoom >= 1.5;

      // Frames first: everything else sits on top of them.
      if (!over) {
        for (const node of s.nodeLookup.values()) {
          if (node.type !== "frame" || node.hidden) continue;
          const w = node.measured.width ?? node.width ?? 0;
          const h = node.measured.height ?? node.height ?? 0;
          const { x, y } = node.internals.positionAbsolute;
          if (!w || !h || !inView(x, y, w, h)) continue;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, FRAME_RADIUS);
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = colors.elevated;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = px;
          ctx.strokeStyle = node.selected ? colors.accent : colors.borderStrong;
          if (node.selected) ctx.lineWidth = 2 * px;
          ctx.stroke();
        }
        drawLinks(c.doc.edges, c.doc.edgeOrder);
      }

      const outlines: {
        x: number;
        y: number;
        w: number;
        h: number;
        r: number;
        color: string;
        gap: number;
      }[] = [];
      for (const node of s.nodeLookup.values()) {
        if (node.hidden || !node.type) continue;
        const w = node.measured.width ?? node.width ?? 0;
        const h = node.measured.height ?? node.height ?? 0;
        const { x, y } = node.internals.positionAbsolute;
        if (!w || !h || !inView(x, y, w, h)) continue;
        const tile = tileOf(c, node.id, node.type, shown);
        if (!tile) continue;
        if (tile.kind === "fill") {
          if (over) continue;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, tile.radius);
          ctx.fillStyle = colors[tile.fill];
          ctx.fill();
          ctx.lineWidth = px;
          ctx.strokeStyle = colors[tile.line];
          ctx.stroke();
        } else {
          const cells = cellsOf(tile, x, y, w, h);
          const images = cells.map((cell) => {
            if (c.missingAssets.has(cell.assetId)) return null;
            return bitmaps.get(cell.assetId, cell.h * zoom * dpr);
          });
          // Zooming back in, only images are painted over the nodes, and only ready ones.
          if (over && images.every((image) => !image)) continue;
          ctx.save();
          if (clipCorners) {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, CARD_RADIUS);
            ctx.clip();
          }
          if (!over || images.some((image) => !image)) {
            ctx.fillStyle = colors.surface;
            ctx.fillRect(x, y, w, h);
          }
          cells.forEach((cell, i) => {
            const image = images[i];
            if (image) drawCover(ctx, image, cell.x, cell.y, cell.w, cell.h);
            else if (c.missingAssets.has(cell.assetId)) missing(cell);
          });
          ctx.restore();
        }
        if (over) continue;
        const radius = tile.kind === "fill" ? tile.radius : CARD_RADIUS;
        if (node.selected) outlines.push({ x, y, w, h, r: radius, color: colors.accent, gap: 0 });
        if (RUNNING.has(c.runtime[node.id]?.state ?? "")) {
          outlines.push({ x, y, w, h, r: radius, color: colors.accentLine, gap: node.selected ? 4 : 0 });
        }
      }

      // Selection and running outlines: 2 px on screen, just outside the tile, over its neighbours.
      ctx.lineWidth = 2 * px;
      for (const o of outlines) {
        const out = (1 + o.gap) * px;
        ctx.beginPath();
        ctx.roundRect(o.x - out, o.y - out, o.w + 2 * out, o.h + 2 * out, o.r + out);
        ctx.strokeStyle = o.color;
        ctx.stroke();
      }

      if (over) {
        const since = performance.now() - overSince;
        const ready = since > HANDOFF_MIN_MS && imagesLoading() === 0;
        if ((ready || since > HANDOFF_MAX_MS) && !fade) {
          el.style.opacity = "0";
          fade = setTimeout(() => {
            fade = undefined;
            if (mode === "over") setMode("off");
          }, FADE_MS);
        }
        if (!fade) schedule();
      }

      /** An image this library doesn't have: a crossed-out square in the tile's middle. */
      function missing(cell: Cell) {
        const size = Math.min(16 * px, cell.w / 3, cell.h / 3);
        const cx = cell.x + cell.w / 2;
        const cy = cell.y + cell.h / 2;
        ctx.strokeStyle = colors!.textTertiary;
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.roundRect(cx - size / 2, cy - size / 2, size, size, size / 6);
        ctx.moveTo(cx - size * 0.7, cy - size * 0.7);
        ctx.lineTo(cx + size * 0.7, cy + size * 0.7);
        ctx.stroke();
      }

      function drawLinks(edges: Readonly<Record<string, CanvasEdge>>, order: readonly string[]) {
        const alpha = Math.min(1, Math.max(0, (zoom - LINKS_GONE) / (LINKS_FULL - LINKS_GONE)));
        if (alpha <= 0) return;
        const simple = order.length > SIMPLE_EDGES_ABOVE;
        const idle = new Path2D();
        const lit = new Path2D();
        const arrows = new Path2D();
        for (const id of order) {
          const edge = edges[id];
          if (!edge) continue;
          const from = s.nodeLookup.get(edge.source);
          const to = s.nodeLookup.get(edge.target);
          if (!from || !to || from.hidden || to.hidden) continue;
          const a = handleAt(from, edge.sourceHandle, "source");
          const b = handleAt(to, edge.targetHandle, "target");
          if (!a || !b) continue;
          const c1 = control(a.position, a.x, a.y, b.x, b.y, simple);
          const c2 = control(b.position, b.x, b.y, a.x, a.y, simple);
          const left = Math.min(a.x, b.x, c1.x, c2.x);
          const top = Math.min(a.y, b.y, c1.y, c2.y);
          if (!inView(left, top, Math.max(a.x, b.x, c1.x, c2.x) - left, Math.max(a.y, b.y, c1.y, c2.y) - top))
            continue;
          const path =
            edge.kind !== "data" ? arrows : RUNNING.has(c.runtime[edge.target]?.state ?? "") ? lit : idle;
          path.moveTo(a.x, a.y);
          path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
        }
        ctx.globalAlpha = alpha;
        // Never thinner than a screen pixel, or they'd vanish before they fade.
        ctx.lineWidth = Math.max(1.5, px);
        ctx.strokeStyle = colors!.borderStrong;
        ctx.stroke(idle);
        ctx.lineWidth = Math.max(2, px);
        ctx.strokeStyle = colors!.accentLine;
        ctx.stroke(lit);
        ctx.lineWidth = Math.max(1.5, px);
        ctx.strokeStyle = colors!.textTertiary;
        ctx.setLineDash([4, 4]);
        ctx.stroke(arrows);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    };

    /**
     * Images the next zoom-out will paint, loaded while the view rests: what the view would show at
     * the first zoomed-out level (a margin around it when already there), nearest the middle first.
     */
    const prefetch = () => {
      const s = flow.getState();
      const c = store.getState();
      const [tx, ty, zoom] = s.transform;
      if (!s.width || !zoom) return;
      const grow = zoom > FIRST_FAR_ZOOM ? zoom / FIRST_FAR_ZOOM : 1.5;
      const at = Math.min(zoom, FIRST_FAR_ZOOM);
      const cx = (s.width / 2 - tx) / zoom;
      const cy = (s.height / 2 - ty) / zoom;
      const halfW = (s.width / zoom / 2) * grow;
      const halfH = (s.height / zoom / 2) * grow;
      const dpr = window.devicePixelRatio || 1;
      const shown = cardMedia.getState().shown;
      const wanted: { assetId: string; pixels: number; d: number }[] = [];
      for (const node of s.nodeLookup.values()) {
        if (node.hidden || !node.type) continue;
        const w = node.measured.width ?? node.width ?? 0;
        const h = node.measured.height ?? node.height ?? 0;
        const { x, y } = node.internals.positionAbsolute;
        if (x > cx + halfW || x + w < cx - halfW || y > cy + halfH || y + h < cy - halfH) continue;
        const tile = tileOf(c, node.id, node.type, shown);
        if (tile?.kind !== "image") continue;
        const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
        for (const cell of cellsOf(tile, x, y, w, h)) {
          if (!c.missingAssets.has(cell.assetId))
            wanted.push({ assetId: cell.assetId, pixels: cell.h * at * dpr, d });
        }
      }
      wanted.sort((p, q) => p.d - q.d);
      bitmaps.prefetch(wanted.slice(0, PREFETCH_MAX));
    };
    const prefetchSoon = () => {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(prefetch, PREFETCH_AFTER_MS);
    };

    let transform = flow.getState().transform;
    const offFlow = flow.subscribe((s) => {
      if (s.transform !== transform) {
        transform = s.transform;
        prefetchSoon();
      }
      schedule();
    });
    let lod = store.getState().ui.lod;
    const offStore = store.subscribe((c) => {
      if (c.ui.lod !== lod) {
        const was = lod;
        lod = c.ui.lod;
        setMode(lod === "canvas" ? "on" : was === "canvas" ? "over" : "off");
      }
      schedule();
    });
    const offMedia = cardMedia.subscribe(schedule);
    const offBitmaps = bitmaps.subscribe(schedule);
    const offTheme = onThemeChange(() => {
      colors = null;
      schedule();
    });
    el.dataset.mode = mode;
    setMode(lod === "canvas" ? "on" : "off");
    prefetchSoon();

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fade);
      clearTimeout(prefetchTimer);
      offFlow();
      offStore();
      offMedia();
      offBitmaps();
      offTheme();
      bitmaps.dispose();
    };
  }, [flow, store]);

  return <canvas ref={ref} aria-hidden className="of-canvas-layer" />;
}

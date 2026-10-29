import { cn } from "@openfield/ui";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type LassoDraft, type LassoStep, lassoDoubleClick, lassoDown, lassoMove, lassoUp } from "./lasso";
import { type Mask, overlayRgba, type Point, type Rect, unionRect } from "./mask";
import { subscribeMask, useEditSession } from "./session";
import { screenScale, screenToImage } from "./view";

// The Edit tab's paint surface (design GadOMK1qPD, EM7Gq6YTHg, GBehrlQZ5o). Two parts, both handed
// to Media: the layer inside the image's zoomed box, which draws the mask's tint and what's being
// drawn (the brush circle, the lasso, the box), and the input over the whole media area, which takes
// the pointer, so a stroke can start or wander past the image's edge.
//
// The tint is a canvas at the image's own pixel size, painted from the mask a changed rectangle at a
// time, once a frame. It's drawn at full strength in the accent; the Mask slider is the canvas's
// CSS opacity, so moving it repaints nothing.

/** Pixels per putImageData: about 4MB of RGBA, so a whole 4K repaint never holds a full copy. */
const STRIP_PIXELS = 1 << 20;

/** The brush circle's line, and the lasso's and box's, in screen px (design: 1.5, dashes 5 and 4). */
const LINE_PX = 1.5;
const DASH_PX = [5, 4] as const;
/** A lasso corner's dot and the box's handle, in screen px. */
const DOT_PX = 8;

interface SurfaceOptions {
  width: number;
  height: number;
  /** Screen px per image px. */
  zoom: number;
  /** Pan instead of paint: the Pan tool, or Space held. */
  panning: boolean;
  /** The Edit tab is open, so the layer is on screen. */
  enabled: boolean;
  /** A run is going: the mask can't change and shows fainter (design DFd2yqIj0C, 35% at 50). */
  resting?: boolean;
}

/** How much of its strength the mask keeps while a run goes. */
const RESTING_STRENGTH = 0.7;

export interface PaintSurface {
  layer: ReactNode;
  input: ReactNode;
  /** Esc: drops what's being drawn. True when there was something. */
  cancel: () => boolean;
}

/** The accent as RGB, read the way the canvas will draw it, whatever form the theme wrote it in. */
function rgbOf(color: string): [number, number, number] {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return [233, 227, 216];
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

const clipTo = (rect: Rect, mask: Mask): Rect | null => {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(mask.width, rect.x + rect.width);
  const bottom = Math.min(mask.height, rect.y + rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

/** Repaints `rect` of the tint from the mask, a strip at a time. */
function paintTint(
  context: CanvasRenderingContext2D,
  mask: Mask,
  area: Rect,
  color: readonly [number, number, number],
) {
  const rect = clipTo(area, mask);
  if (!rect) return;
  const rows = Math.max(1, Math.floor(STRIP_PIXELS / rect.width));
  for (let y = rect.y; y < rect.y + rect.height; y += rows) {
    const strip = { x: rect.x, y, width: rect.width, height: Math.min(rows, rect.y + rect.height - y) };
    const rgba = overlayRgba(mask, strip, color, 1);
    context.putImageData(new ImageData(rgba, strip.width, strip.height), strip.x, strip.y);
  }
}

/** Keeps the tint canvas in step with the mask: changed rectangles once a frame, all of it on a theme change. */
function useTint(element: HTMLCanvasElement | null, width: number, height: number) {
  useEffect(() => {
    const context = element?.getContext("2d");
    if (!element || !context) return;
    let color = rgbOf(getComputedStyle(element).color);
    let pending: Rect | "all" | null = "all";
    let frame = 0;

    const flush = () => {
      frame = 0;
      const editor = useEditSession.getState().editor;
      const dirty = pending;
      pending = null;
      if (!editor || editor.mask.width !== width || editor.mask.height !== height || !dirty) return;
      const all = { x: 0, y: 0, width, height };
      paintTint(context, editor.mask, dirty === "all" ? all : dirty, color);
    };
    const schedule = (rect: Rect | null) => {
      pending = rect === null || pending === "all" ? "all" : unionRect(pending, rect);
      if (!frame) frame = requestAnimationFrame(flush);
    };

    // The accent changes with the theme: the person's pick, or the system's when they follow it.
    const recolor = () => {
      const next = rgbOf(getComputedStyle(element).color);
      if (next.every((v, i) => v === color[i])) return;
      color = next;
      schedule(null);
    };
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    scheme.addEventListener("change", recolor);
    const themes = new MutationObserver(recolor);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const unsubscribe = subscribeMask(schedule);
    flush();
    return () => {
      unsubscribe();
      scheme.removeEventListener("change", recolor);
      themes.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [element, width, height]);
}

interface Box {
  from: Point;
  to: Point;
}

const pathOf = (points: readonly Point[]) =>
  points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");

export function usePaintSurface({
  width,
  height,
  zoom,
  panning,
  enabled,
  resting = false,
}: SurfaceOptions): PaintSurface {
  const tool = useEditSession((s) => s.tool);
  const brushSize = useEditSession((s) => s.brushSize);
  const maskOpacity = useEditSession((s) => s.maskOpacity);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Media mounts the layer only once its box has a size, so the tint follows the element itself.
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null);
  const canvasRef = useCallback((element: HTMLCanvasElement | null) => {
    canvas.current = element;
    setCanvasElement(element);
  }, []);
  const input = useRef<HTMLDivElement>(null);
  const cursor = useRef<SVGCircleElement>(null);
  /** The pointer drawing a stroke or a box. */
  const pressed = useRef<number | null>(null);
  const lassoRef = useRef<LassoDraft | null>(null);
  const [lasso, setLassoView] = useState<LassoDraft | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);

  useTint(enabled ? canvasElement : null, width, height);

  const brushing = tool === "brush" || tool === "eraser";
  const image = { width, height };

  const setLasso = useCallback((step: LassoStep) => {
    lassoRef.current = step.draft;
    setLassoView(step.draft);
    if (step.closed) {
      const points = step.closed;
      useEditSession
        .getState()
        .changeMask((editor) => editor.apply({ type: "polygon", mode: "paint", points }));
    }
  }, []);
  const updateBox = (next: Box | null) => {
    boxRef.current = next;
    setBox(next);
  };

  const cancel = useCallback(() => {
    let dropped = false;
    if (useEditSession.getState().editor?.stroking) {
      useEditSession.getState().changeMask((editor) => editor.cancelStroke());
      dropped = true;
    }
    if (lassoRef.current) {
      setLasso({ draft: null });
      dropped = true;
    }
    if (boxRef.current) {
      boxRef.current = null;
      setBox(null);
      dropped = true;
    }
    pressed.current = null;
    return dropped;
  }, [setLasso]);

  // Changing tools drops a half-drawn shape; a stroke already under way finishes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the tool change drops it.
  useEffect(() => {
    if (lassoRef.current) setLasso({ draft: null });
    if (boxRef.current) updateBox(null);
    if (input.current) input.current.style.cursor = "";
  }, [tool]);

  /** Where the pointer is on the image, and how many screen px an image px is right now. */
  const locate = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const toImage = (e: { clientX: number; clientY: number }) =>
      screenToImage(rect, image, { x: e.clientX, y: e.clientY });
    const at = toImage(event);
    const inside = at.x >= 0 && at.y >= 0 && at.x < width && at.y < height;
    return { at, scale: screenScale(rect, image), inside, toImage };
  };

  /** The brush circle follows the pointer outside React, so a move re-renders nothing. */
  const moveCursor = (at: Point | null) => {
    const circle = cursor.current;
    if (!circle) return;
    if (!at) {
      circle.style.visibility = "hidden";
      return;
    }
    circle.setAttribute("cx", String(at.x));
    circle.setAttribute("cy", String(at.y));
    circle.style.visibility = "visible";
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pressed.current !== null) return;
    const where = locate(event);
    if (!where) return;
    // The media area under this would start a pan.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { at, scale } = where;
    const state = useEditSession.getState();
    if (brushing) {
      pressed.current = event.pointerId;
      const brush = {
        mode: tool === "eraser" ? "erase" : "paint",
        size: state.brushSize,
        hardness: state.hardness,
      } as const;
      state.changeMask((editor) => editor.beginStroke(brush, at));
    } else if (tool === "lasso") {
      setLasso(lassoDown(lassoRef.current, at, scale));
    } else if (tool === "rect") {
      pressed.current = event.pointerId;
      updateBox({ from: at, to: at });
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const where = locate(event);
    if (!where) return;
    const { at, scale, inside, toImage } = where;
    if (brushing) {
      moveCursor(at);
      // Off the image the circle is clipped away, so the pointer shows there instead.
      if (input.current) input.current.style.cursor = inside ? "none" : "crosshair";
    }
    const state = useEditSession.getState();
    if (brushing && pressed.current === event.pointerId) {
      // Every point the pointer reported since the last frame, so a fast stroke keeps its curve.
      const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = events.length > 0 ? events.map(toImage) : [at];
      state.changeMask((editor) => {
        let rect: Rect | null = null;
        for (const point of points) rect = unionRect(rect, editor.strokeTo(point));
        return rect;
      });
    } else if (tool === "lasso" && lassoRef.current) {
      setLasso(lassoMove(lassoRef.current, at, scale));
    } else if (tool === "rect" && pressed.current === event.pointerId && boxRef.current) {
      updateBox({ ...boxRef.current, to: at });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const where = locate(event);
    const state = useEditSession.getState();
    if (pressed.current !== event.pointerId) {
      if (tool === "lasso" && where) setLasso(lassoUp(lassoRef.current, where.at, where.scale));
      return;
    }
    pressed.current = null;
    // A stroke ends where the button came up, even if a key changed the tool on the way.
    if (state.editor?.stroking) {
      state.changeMask((editor) => editor.endStroke(where?.at));
    } else if (tool === "rect" && boxRef.current) {
      const { from } = boxRef.current;
      const to = where?.at ?? boxRef.current.to;
      updateBox(null);
      state.changeMask((editor) => editor.apply({ type: "rect", mode: "paint", from, to }));
    }
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (pressed.current === event.pointerId || lassoRef.current?.press) cancel();
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (tool !== "lasso") return;
    event.stopPropagation();
    setLasso(lassoDoubleClick(lassoRef.current));
  };

  // Lines and dots keep their screen size at any zoom: the layer is drawn in image px.
  const unit = zoom > 0 ? 1 / zoom : 1;
  const line = { strokeWidth: LINE_PX * unit, strokeDasharray: DASH_PX.map((d) => d * unit).join(" ") };
  const dot = DOT_PX * unit;

  const layer = (
    <>
      {/* Mask: the painted area, tinted in the accent. */}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        aria-hidden
        data-mask-layer
        className="absolute inset-0 size-full text-accent"
        style={{ opacity: (maskOpacity / 100) * (resting ? RESTING_STRENGTH : 1) }}
      />
      <svg
        aria-hidden
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full"
      >
        {box ? (
          <>
            {/* Box · mask, Box · outline, Handle */}
            <rect {...rectOf(box)} className="fill-accent" style={{ opacity: maskOpacity / 100 }} />
            <rect {...rectOf(box)} className="fill-none stroke-text-primary" style={line} />
            <rect
              x={box.to.x - dot / 2}
              y={box.to.y - dot / 2}
              width={dot}
              height={dot}
              className="fill-text-primary stroke-canvas"
              style={{ strokeWidth: unit }}
            />
          </>
        ) : null}
        {lasso ? (
          <>
            <path
              d={pathOf(lasso.pointer ? [...lasso.points, lasso.pointer] : lasso.points)}
              className="fill-none stroke-text-primary"
              style={line}
            />
            {lasso.corners.map((i) => (
              <circle
                key={i}
                cx={lasso.points[i]!.x}
                cy={lasso.points[i]!.y}
                r={dot / 2}
                className="fill-text-primary stroke-canvas"
                style={{ strokeWidth: unit }}
              />
            ))}
          </>
        ) : null}
        {/* Brush cursor: the brush's real size, wherever the pointer is. */}
        <circle
          ref={cursor}
          r={brushSize / 2}
          className={cn("fill-none stroke-text-primary", !brushing || panning ? "hidden" : null)}
          style={{ strokeWidth: LINE_PX * unit, visibility: "hidden" }}
        />
      </svg>
    </>
  );

  const surface = (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer only; the tools' keys are the view's (keys.ts).
    <div
      ref={input}
      data-paint-input
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => {
        moveCursor(null);
        if (input.current) input.current.style.cursor = "";
      }}
      onDoubleClick={onDoubleClick}
      className={cn("absolute inset-0", panning ? "pointer-events-none" : "cursor-crosshair")}
    />
  );

  return { layer, input: surface, cancel };
}

const rectOf = ({ from, to }: Box) => ({
  x: Math.min(from.x, to.x),
  y: Math.min(from.y, to.y),
  width: Math.abs(to.x - from.x),
  height: Math.abs(to.y - from.y),
});

/**
 * Things Space presses on its own when they have focus. A slider's thumb and the tab already open
 * do nothing with it, and a click or a drag leaves focus on them, so they don't count.
 */
const SPACE_TAKERS = "input, textarea, select, [contenteditable='true'], button, a, [role='button']";
const SPACE_IGNORERS = "[role='slider'], [role='tab'][aria-selected='true']";

const takesSpace = (target: EventTarget | null) => {
  const el = target instanceof Element ? target.closest(SPACE_TAKERS) : null;
  return el !== null && !el.matches(SPACE_IGNORERS);
};

/** Holding Space pans while it's down, from any tool (§4.5). */
export function useSpaceHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const down = (event: KeyboardEvent) => {
      if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return;
      if (takesSpace(event.target)) return;
      event.preventDefault();
      // Repeats too: a press that began on a button pans once focus moves off it.
      setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === " ") setHeld(false);
    };
    const release = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [enabled]);
  return held;
}

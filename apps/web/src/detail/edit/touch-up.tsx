import { t } from "@openfield/core";
import { Button, cn, Divider, Slider, Tooltip } from "@openfield/ui";
import { Image as ImageIcon, type LucideIcon, Sparkles, Undo2 } from "lucide-react";
import { type PointerEvent, type ReactNode, useRef } from "react";
import { keepFocus } from "./chrome";
import type { FixBrush, FixLayer } from "./fix-layer";
import type { Point, Rect } from "./mask";
import { BRUSH_SLIDER_STEPS, brushSizeAt, sliderOfSize } from "./session";
import { screenScale, screenToImage } from "./view";

// Touch up (design YYkh7rc2sd, sO1u1sG97W): two brushes on a finished edit, "use the model here"
// and "use the original here", painted into its fix layer. Each stroke previews at once, for free;
// Apply in the panel keeps them. Driven by props alone, so the canvas Edit node's window can use
// the toolbar (its "in window" form) and the surface too.

/** The brush circle's line, in screen px. */
const LINE_PX = 1.5;

const BRUSHES: Record<FixBrush, { icon: LucideIcon; label: "edit.touchUp.model" | "edit.touchUp.original" }> =
  {
    model: { icon: Sparkles, label: "edit.touchUp.model" },
    original: { icon: ImageIcon, label: "edit.touchUp.original" },
  };

/** Image edit / Touch up toolbar / brush: 36 tall, picked in the accent's soft fill. */
function BrushButton({ brush, picked, onPick }: { brush: FixBrush; picked: boolean; onPick: () => void }) {
  const { icon: Icon, label } = BRUSHES[brush];
  return (
    <button
      type="button"
      aria-pressed={picked}
      onMouseDown={keepFocus}
      onClick={onPick}
      className={cn(
        "flex h-36 shrink-0 cursor-pointer items-center justify-center gap-6 rounded-8 px-12 text-small font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        picked ? "bg-accent-soft text-accent" : "text-text-secondary hover:text-text-primary",
      )}
    >
      <Icon size={14} aria-hidden className="shrink-0" />
      {t(label)}
    </button>
  );
}

export interface TouchUpToolbarProps {
  brush: FixBrush;
  onBrush: (brush: FixBrush) => void;
  /** Brush size in the original's pixels. Left out in the window, which has its own. */
  size?: number;
  onSize?: (size: number) => void;
  canUndo: boolean;
  onUndo: () => void;
  /** Done, back to comparing. Left out in the window, whose footer has Cancel and Apply. */
  onDone?: () => void;
  className?: string;
}

/**
 * Image edit / Touch up toolbar: the two brushes | Size | Undo | Done, bottom centre where the
 * result actions sit. In the canvas window (Touch up toolbar / In window) it's the brushes and Undo.
 */
export function TouchUpToolbar({
  brush,
  onBrush,
  size,
  onSize,
  canUndo,
  onUndo,
  onDone,
  className,
}: TouchUpToolbarProps) {
  const sized = size !== undefined && onSize;
  const shown = size !== undefined ? t("edit.options.px", { value: size }) : "";
  return (
    <div
      role="toolbar"
      aria-label={t("edit.touchUp.label")}
      className={cn(
        "flex items-center gap-2 rounded-12 bg-elevated p-4 inset-ring inset-ring-border",
        className,
      )}
    >
      <BrushButton brush="model" picked={brush === "model"} onPick={() => onBrush("model")} />
      <BrushButton brush="original" picked={brush === "original"} onPick={() => onBrush("original")} />
      <Divider orientation="vertical" size={20} />
      {sized ? (
        <>
          {/* Size */}
          <div className="flex items-center gap-8 px-8">
            <span className="text-caption font-medium text-text-secondary">{t("edit.options.size")}</span>
            <Slider
              value={[sliderOfSize(size)]}
              min={0}
              max={BRUSH_SLIDER_STEPS}
              step={1}
              thumbLabel={t("edit.options.size")}
              thumbValueText={shown}
              onValueChange={([next]) => next !== undefined && onSize(brushSizeAt(next, size))}
              className="w-96"
            />
            <span className="w-40 shrink-0 text-mono-12 text-text-primary">{shown}</span>
          </div>
          <Divider orientation="vertical" size={20} />
        </>
      ) : null}
      <Tooltip content={t("edit.tools.undo")} side="top" sideOffset={8}>
        <button
          type="button"
          aria-label={t("edit.tools.undo")}
          aria-disabled={!canUndo || undefined}
          onMouseDown={keepFocus}
          onClick={canUndo ? onUndo : undefined}
          className="flex size-36 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:opacity-40"
        >
          <Undo2 size={18} aria-hidden />
        </button>
      </Tooltip>
      {onDone ? (
        <>
          <Divider orientation="vertical" size={20} />
          <Button size="s" onMouseDown={keepFocus} onClick={onDone}>
            {t("edit.touchUp.done")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

export interface TouchUpSurfaceOptions {
  /** The fix layer to paint, at the original's size. Null while it loads. */
  fixes: FixLayer | null;
  brush: FixBrush;
  /** Brush size in the original's pixels. */
  size: number;
  /** Screen px per image px. */
  zoom: number;
  /** Pan instead of paint: Space held. */
  panning: boolean;
  /** After each part of a stroke and each undo, with what changed. */
  onChange: (rect: Rect | null) => void;
}

export interface TouchUpSurface {
  /** Inside the image's zoomed box: the brush circle. */
  layer: ReactNode;
  /** Over the whole media area: takes the pointer, so a stroke can wander past the edge. */
  input: ReactNode;
}

export function useTouchUpSurface({
  fixes,
  brush,
  size,
  zoom,
  panning,
  onChange,
}: TouchUpSurfaceOptions): TouchUpSurface {
  const svg = useRef<SVGSVGElement>(null);
  const cursor = useRef<SVGCircleElement>(null);
  const input = useRef<HTMLDivElement>(null);
  const pressed = useRef<number | null>(null);
  const width = fixes?.width ?? 1;
  const height = fixes?.height ?? 1;

  const locate = (event: { clientX: number; clientY: number }) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const image = { width, height };
    const toImage = (e: { clientX: number; clientY: number }): Point =>
      screenToImage(rect, image, { x: e.clientX, y: e.clientY });
    const at = toImage(event);
    const inside = at.x >= 0 && at.y >= 0 && at.x < width && at.y < height;
    return { at, inside, toImage, scale: screenScale(rect, image) };
  };

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
    if (event.button !== 0 || pressed.current !== null || !fixes) return;
    const where = locate(event);
    if (!where) return;
    // The media area under this would start a pan.
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressed.current = event.pointerId;
    onChange(fixes.beginStroke(brush, size, where.at));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const where = locate(event);
    if (!where) return;
    moveCursor(where.at);
    if (input.current) input.current.style.cursor = where.inside ? "none" : "crosshair";
    if (pressed.current !== event.pointerId || !fixes) return;
    // Every point since the last frame, so a fast stroke keeps its curve.
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = events.length > 0 ? events.map(where.toImage) : [where.at];
    let rect: Rect | null = null;
    for (const point of points) {
      const next = fixes.strokeTo(point);
      if (next) rect = rect ? unionOf(rect, next) : next;
    }
    onChange(rect);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (pressed.current !== event.pointerId) return;
    pressed.current = null;
    fixes?.endStroke();
  };

  // The circle keeps its line 1.5 screen px wide at any zoom: the layer is drawn in image px.
  const unit = zoom > 0 ? 1 / zoom : 1;
  const layer = (
    <svg
      ref={svg}
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      {/* Brush cursor: the brush's real size, wherever the pointer is. */}
      <circle
        ref={cursor}
        r={size / 2}
        className={cn("fill-none stroke-text-primary", panning && "hidden")}
        style={{ strokeWidth: LINE_PX * unit, visibility: "hidden" }}
      />
    </svg>
  );

  const surface = (
    <div
      ref={input}
      data-touch-up-input
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        moveCursor(null);
        if (input.current) input.current.style.cursor = "";
      }}
      className={cn("absolute inset-0", panning ? "pointer-events-none" : "cursor-crosshair")}
    />
  );

  return { layer, input: surface };
}

const unionOf = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

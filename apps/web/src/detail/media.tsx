import { type AssetListItem, DETAIL_PREVIEW_EDGE } from "@openfield/core";
import { cn } from "@openfield/ui";
import {
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAuthedImage } from "../api/hooks/images";
import { BACKDROP_RUNG, thumbAt } from "./format";

// The image, fit inside the media area and never upscaled past 100% (§4.0), with pointer-anchored
// zoom from 5% to 1600% and panning (§4.5). The thumbnail paints first, the 1440 preview over it,
// and the original only once zoom needs more pixels than the preview has.

/** Space around the image in the media area (design x7y6U: a 704-tall image in 900). */
export const MEDIA_INSET = 98;

/** Space around the image, side by side. */
export interface MediaInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const INSET: MediaInset = { top: MEDIA_INSET, right: MEDIA_INSET, bottom: MEDIA_INSET, left: MEDIA_INSET };
const EDGE_TO_EDGE: MediaInset = { top: 0, right: 0, bottom: 0, left: 0 };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const STEP = 1.5;
/** How much of the image stays on screen however far it's panned. */
const KEEP_VISIBLE = 48;

export interface MediaHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** The chrome's Zoom button: fit ↔ actual size (or twice the fit, for a small image). */
  toggle: () => void;
}

interface MediaProps {
  item: AssetListItem;
  /** Expanded: the image fits the whole viewport, edge to edge. */
  expanded: boolean;
  label: string;
  onZoomedChange: (zoomed: boolean) => void;
  /** Screen px per image px, as it changes: the Edit tab's zoom control and brush. */
  onZoomChange?: (zoom: number) => void;
  /** Space around the image, in place of the panelled or expanded default. */
  inset?: MediaInset;
  /** A drag pans at any zoom, not only once zoomed in: the Edit tab's Pan tool. */
  panAnywhere?: boolean;
  /** Drawn over the image, inside its zoomed and panned box: the Edit tab's mask. */
  layer?: ReactNode;
  /**
   * Unscaled, over the part of the image that's on screen as it's zoomed and panned: labels on its
   * corners (Generating, Before and After). A function is told where the whole image is.
   */
  pinned?: ReactNode | ((frame: PinnedFrame) => ReactNode);
  /** Over the whole media area, above the image: what takes the Edit tab's strokes. */
  children?: ReactNode;
  ref?: Ref<MediaHandle>;
}

/** Where `pinned` sits: the part of the image on screen, and the whole image from its top left. */
export interface PinnedFrame {
  width: number;
  height: number;
  image: { left: number; top: number; width: number; height: number };
}

interface View {
  /** Display size over natural size; null follows the fit. */
  zoom: number | null;
  x: number;
  y: number;
}

const FIT: View = { zoom: null, x: 0, y: 0 };

/** An element's laid-out size, before any transform, as it changes. */
export function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function Media({
  item,
  expanded,
  label,
  onZoomedChange,
  onZoomChange,
  inset = expanded ? EDGE_TO_EDGE : INSET,
  panAnywhere = false,
  layer,
  pinned,
  children,
  ref,
}: MediaProps) {
  const area = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { width: boxW, height: boxH } = useBoxSize(box);
  const [view, setView] = useState<View>(FIT);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const naturalW = item.width;
  const naturalH = item.height;
  const fitZoom = boxW > 0 && boxH > 0 ? Math.min(boxW / naturalW, boxH / naturalH, 1) : 0;
  const zoom = view.zoom ?? fitZoom;
  const scale = fitZoom > 0 ? zoom / fitZoom : 1;
  const zoomed = view.zoom !== null && Math.abs(scale - 1) > 0.001;

  useEffect(() => onZoomedChange(zoomed), [zoomed, onZoomedChange]);
  useEffect(() => {
    if (zoom > 0) onZoomChange?.(zoom);
  }, [zoom, onZoomChange]);

  // Changing layouts (panelled, expanded, the Edit tab's) starts from the fit again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the layout change resets it.
  useEffect(() => setView(FIT), [expanded, inset]);

  const clampOffset = (x: number, y: number, z: number) => {
    const w = naturalW * z;
    const h = naturalH * z;
    const maxX = Math.max(0, (boxW + w) / 2 - KEEP_VISIBLE);
    const maxY = Math.max(0, (boxH + h) / 2 - KEEP_VISIBLE);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };

  /** Zoom to `next`, keeping the point under (px, py) (relative to the box centre) where it is. */
  const zoomTo = (next: number, px = 0, py = 0) => {
    if (fitZoom <= 0) return;
    const floor = Math.min(MIN_ZOOM, fitZoom);
    const target = Math.min(MAX_ZOOM, Math.max(floor, next));
    setView((current) => {
      const from = current.zoom ?? fitZoom;
      const ratio = target / from;
      const offset = clampOffset(px - (px - current.x) * ratio, py - (py - current.y) * ratio, target);
      return Math.abs(target - fitZoom) < 0.0005 ? FIT : { zoom: target, ...offset };
    });
  };

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomTo(zoom * STEP),
    zoomOut: () => zoomTo(zoom / STEP),
    fit: () => setView(FIT),
    toggle: () => (zoomed ? setView(FIT) : zoomTo(fitZoom < 1 ? Math.max(1, fitZoom * 2) : 2)),
  }));

  // Trackpad pinch and ⌘/Ctrl + wheel zoom at the pointer; a plain wheel pans a zoomed image. React's
  // wheel handler is passive, so this one is added by hand to keep the page from scrolling.
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = (event: WheelEvent) => {
    const el = box.current;
    if (!el) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      zoomTo(zoom * Math.exp(-event.deltaY * 0.01), px, py);
    } else if (zoomed || panAnywhere) {
      event.preventDefault();
      setView((current) => ({
        ...current,
        ...clampOffset(current.x - event.deltaX, current.y - event.deltaY, current.zoom ?? fitZoom),
      }));
    }
  };
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, []);

  const onPointerDown = (event: PointerEvent) => {
    if (!(zoomed || panAnywhere) || event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    drag.current = { ...start, x: event.clientX, y: event.clientY };
    setView((current) => ({
      ...current,
      ...clampOffset(current.x + dx, current.y + dy, current.zoom ?? fitZoom),
    }));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const fitW = naturalW * fitZoom;
  const fitH = naturalH * fitZoom;

  // The image on screen, and the part of it inside the box, which is where `pinned` goes.
  const shownW = naturalW * zoom;
  const shownH = naturalH * zoom;
  const imageLeft = (boxW - shownW) / 2 + view.x;
  const imageTop = (boxH - shownH) / 2 + view.y;
  const visibleLeft = Math.max(0, imageLeft);
  const visibleTop = Math.max(0, imageTop);
  const visibleW = Math.min(boxW, imageLeft + shownW) - visibleLeft;
  const visibleH = Math.min(boxH, imageTop + shownH) - visibleTop;
  const frame: PinnedFrame = {
    width: visibleW,
    height: visibleH,
    image: { left: imageLeft - visibleLeft, top: imageTop - visibleTop, width: shownW, height: shownH },
  };

  return (
    <div
      ref={area}
      role="img"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "absolute inset-0 touch-none select-none",
        (zoomed || panAnywhere) && (dragging ? "cursor-grabbing" : "cursor-grab"),
      )}
      style={{ padding: `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px` }}
    >
      <div ref={box} className="relative size-full">
        {fitZoom > 0 ? (
          <div
            className="absolute top-1/2 left-1/2 overflow-hidden rounded-4"
            style={{
              width: fitW,
              height: fitH,
              transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale})`,
            }}
          >
            <ImageLayers item={item} zoom={zoom} />
            {layer}
          </div>
        ) : null}
        {pinned && fitZoom > 0 && visibleW > 0 && visibleH > 0 ? (
          <div
            className="pointer-events-none absolute"
            style={{ left: visibleLeft, top: visibleTop, width: visibleW, height: visibleH }}
          >
            {typeof pinned === "function" ? pinned(frame) : pinned}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** What ImageLayers needs of an image. */
export type LayeredImage = Pick<AssetListItem, "id" | "thumbUrl" | "fileUrl" | "width" | "height">;

/**
 * An image's pixels at `zoom` (screen px per image px): the backdrop's rung first (it's already on
 * its way, so the image paints in one frame), the 1440 preview over it, and the original only once
 * the preview runs out of pixels at this zoom. `stretch` fills a box of another shape edge to edge
 * rather than cropping to it.
 */
export function ImageLayers({
  item,
  zoom,
  stretch = false,
}: {
  item: LayeredImage;
  zoom: number;
  stretch?: boolean;
}) {
  const previewZoom = Math.min(1, DETAIL_PREVIEW_EDGE / Math.max(item.width, item.height));
  const needOriginal = zoom * (window.devicePixelRatio || 1) > previewZoom + 0.001;
  const thumb = useAuthedImage(thumbAt(item, { h: BACKDROP_RUNG }));
  const preview = useAuthedImage(thumbAt(item, "preview"));
  const original = useAuthedImage(needOriginal ? item.fileUrl : null);
  const layers = [thumb, preview, needOriginal ? original : null];
  return layers.map((layer, i) =>
    layer?.status === "ready" ? (
      <img
        // biome-ignore lint/suspicious/noArrayIndexKey: the layers are fixed and ordered.
        key={i}
        src={layer.src}
        alt=""
        draggable={false}
        decoding="async"
        className={cn("absolute inset-0 size-full", stretch ? "object-fill" : "object-cover")}
      />
    ) : null,
  );
}

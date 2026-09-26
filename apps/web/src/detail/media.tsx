import { type AssetListItem, DETAIL_PREVIEW_EDGE } from "@openfield/core";
import { cn } from "@openfield/ui";
import {
  type PointerEvent,
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
  ref?: Ref<MediaHandle>;
}

interface View {
  /** Display size over natural size; null follows the fit. */
  zoom: number | null;
  x: number;
  y: number;
}

const FIT: View = { zoom: null, x: 0, y: 0 };

function useBoxSize(ref: RefObject<HTMLElement | null>) {
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

export function Media({ item, expanded, label, onZoomedChange, ref }: MediaProps) {
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

  // Changing between the panelled and expanded layouts starts from the fit again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the layout change resets it.
  useEffect(() => setView(FIT), [expanded]);

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
    } else if (zoomed) {
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
    if (!zoomed || event.button !== 0) return;
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

  // The original only once the preview runs out of pixels at this zoom.
  const previewZoom = Math.min(1, DETAIL_PREVIEW_EDGE / Math.max(naturalW, naturalH));
  const needOriginal = zoom * (window.devicePixelRatio || 1) > previewZoom + 0.001;

  // The backdrop's rung first: it's already on its way, so the image paints in one frame.
  const thumb = useAuthedImage(thumbAt(item, { h: BACKDROP_RUNG }));
  const preview = useAuthedImage(thumbAt(item, "preview"));
  const original = useAuthedImage(needOriginal ? item.fileUrl : null);
  const layers = [thumb, preview, needOriginal ? original : null];

  const fitW = naturalW * fitZoom;
  const fitH = naturalH * fitZoom;

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
        zoomed && (dragging ? "cursor-grabbing" : "cursor-grab"),
      )}
      style={{ padding: expanded ? 0 : MEDIA_INSET }}
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
            {layers.map((layer, i) =>
              layer?.status === "ready" ? (
                <img
                  // biome-ignore lint/suspicious/noArrayIndexKey: the layers are fixed and ordered.
                  key={i}
                  src={layer.src}
                  alt=""
                  draggable={false}
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

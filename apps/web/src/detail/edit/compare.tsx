import { type AssetListItem, assetFileUrl, t } from "@openfield/core";
import { Button, cn, MediaLabelPill, Segmented, SegmentedItem } from "@openfield/ui";
import { Brush, ChevronsLeftRight } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type PointerEvent, useLayoutEffect, useRef } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import { thumbAt } from "../format";
import { ImageLayers, type LayeredImage, type PinnedFrame, useBoxSize } from "../media";
import { useDifference } from "./use-difference";

// Once an edit has saved new images, the media area compares the one picked with the original
// (design iz4IfLpdHl, OthLvkDvWM): Before and after with a handle to drag across, or Difference,
// which dims what stayed the same and marks what changed in the accent. Image edit / Compare switch
// picks between them at the top, and Edit the mask sits where the toolbar was.
//
// Everything here sits on the image, so it's painted dark in both themes (data-paint), as the
// design draws it: its tokens are the dark theme's.

export type CompareMode = "split" | "difference";

/** Where the handle starts, as the design has it: 270 into a 510 wide image. */
export const SPLIT_START = 270 / 510;

/** Arrow keys move the handle this much of the image's width, ten times as much with Shift. */
const SPLIT_STEP = 0.01;

/** Toolbar-like buttons keep focus on the view, so its keys keep working after a click. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** Image edit / Compare switch: a Segmented / 2 on the overlay, over the media area, top centre. */
export function CompareSwitch({
  mode,
  onModeChange,
}: {
  mode: CompareMode;
  onModeChange: (mode: CompareMode) => void;
}) {
  return (
    <Segmented
      data-paint="dark"
      aria-label={t("edit.compare.label")}
      value={mode}
      onValueChange={(next) => onModeChange(next as CompareMode)}
      className="absolute top-12 left-1/2 w-fit -translate-x-1/2 bg-overlay inset-ring inset-ring-border backdrop-blur-chip"
    >
      <SegmentedItem value="split" className="flex-none px-12">
        {t("edit.compare.split")}
      </SegmentedItem>
      <SegmentedItem value="difference" className="flex-none px-12">
        {t("edit.compare.difference")}
      </SegmentedItem>
    </Segmented>
  );
}

/**
 * A new image as ImageLayers draws one, from its id alone (thumbAt builds the URLs from it). It has
 * the original's size when the rest was kept, and about its shape otherwise, so the original's size
 * stands in for working out when to load the file.
 */
function resultImage(assetId: string, original: AssetListItem): LayeredImage {
  return {
    id: assetId,
    thumbUrl: "",
    fileUrl: assetFileUrl(assetId),
    width: original.width,
    height: original.height,
  };
}

/**
 * After: the new image over the original, inside the image's zoomed box, cut away left of the
 * handle so the original shows there. A model that came back at a slightly other shape (its nearest
 * ratio) is stretched to the box, as Difference and the server's composite read it, so both views
 * line up with the original.
 */
export function AfterLayer({
  item,
  resultId,
  split,
  zoom,
}: {
  item: AssetListItem;
  resultId: string;
  split: number;
  zoom: number;
}) {
  return (
    <div data-compare-after className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}>
      <ImageLayers item={resultImage(resultId, item)} zoom={zoom} stretch />
    </div>
  );
}

/**
 * Image edit / Compare handle: a 2px line the image's height with a 32 round knob in the middle,
 * dragged across (or moved with the arrow keys) to show more of either image. It sits on the part of
 * the image on screen and goes when the split is off it.
 */
function CompareHandle({
  frame,
  split,
  onSplitChange,
}: {
  frame: PinnedFrame;
  split: number;
  onSplitChange: (split: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; split: number } | null>(null);
  const x = frame.image.left + split * frame.image.width;
  if (x < 0 || x > frame.width) return null;

  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The handle's own drag: the image under it mustn't pan.
    event.stopPropagation();
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, split };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    onSplitChange(clamp(start.split + (event.clientX - start.x) / frame.image.width));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SPLIT_STEP * 10 : SPLIT_STEP;
    const next =
      event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? split - step
        : event.key === "ArrowRight" || event.key === "ArrowUp"
          ? split + step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : null;
    if (next === null) return;
    // Ahead of the view's own arrows, which would step to another image.
    event.preventDefault();
    event.stopPropagation();
    onSplitChange(clamp(next));
  };

  const percent = Math.round(split * 100);
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t("edit.compare.handle")}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="pointer-events-auto absolute top-0 flex h-full w-32 -translate-x-1/2 cursor-ew-resize touch-none flex-col items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{ left: x }}
    >
      <span aria-hidden className="w-2 flex-1 bg-text-primary" />
      <span
        aria-hidden
        className="flex size-32 shrink-0 items-center justify-center rounded-full bg-overlay inset-ring inset-ring-border-strong backdrop-blur-chip"
      >
        <ChevronsLeftRight size={16} className="text-text-primary" />
      </span>
      <span aria-hidden className="w-2 flex-1 bg-text-primary" />
    </div>
  );
}

/** Over the image in Before and after: the handle, then the Before and After labels 10 in. */
export function SplitPins({
  frame,
  split,
  onSplitChange,
}: {
  frame: PinnedFrame;
  split: number;
  onSplitChange: (split: number) => void;
}) {
  return (
    <div data-paint="dark" className="absolute inset-0">
      <CompareHandle frame={frame} split={split} onSplitChange={onSplitChange} />
      <MediaLabelPill className="absolute top-10 left-10">{t("edit.compare.before")}</MediaLabelPill>
      <MediaLabelPill className="absolute top-10 right-10">{t("edit.compare.after")}</MediaLabelPill>
    </div>
  );
}

/**
 * Difference, inside the image's zoomed box over the original: "Same as the original" dims all of
 * it with the canvas tone at 82%, and "Changed" marks each pixel by how much it moved, in the accent
 * at 85% with the design's 7px blur. The change is worked out off the page (use-difference.ts) from
 * both previews, at the size the image is shown.
 */
export function DifferenceLayer({ item, resultId }: { item: AssetListItem; resultId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useBoxSize(box);
  const before = useAuthedImage(thumbAt(item, "preview"));
  const after = useAuthedImage(thumbAt(resultImage(resultId, item), "preview"));
  const dpr = window.devicePixelRatio || 1;
  const mask = useDifference(
    before.status === "ready" ? before.src : null,
    after.status === "ready" ? after.src : null,
    size.width > 0 && size.height > 0 ? { width: size.width * dpr, height: size.height * dpr } : null,
  );

  // The mask is white with the change as its alpha: keep the alpha, take the accent. The canvas is
  // text-accent, so its own colour is the token, as the dark theme has it.
  useLayoutEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context || !mask) return;
    el.width = mask.width;
    el.height = mask.height;
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = getComputedStyle(el).color;
    context.fillRect(0, 0, el.width, el.height);
    context.globalCompositeOperation = "source-over";
  }, [mask]);

  return (
    <div ref={box} data-paint="dark" className="absolute inset-0">
      <div className="absolute inset-0 bg-canvas opacity-82" />
      <canvas
        ref={canvas}
        data-difference
        data-ready={mask ? "" : undefined}
        className={cn("absolute inset-0 size-full text-accent opacity-85 blur-[7px]", !mask && "invisible")}
      />
    </div>
  );
}

/** One key of the legend: an 8px swatch and its 12/500 label. */
function LegendKey({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-6">
      <span aria-hidden className={cn("size-8 shrink-0 rounded-full", swatch)} />
      <span className="text-caption font-medium text-text-primary">{label}</span>
    </span>
  );
}

/** Image edit / Difference legend: under the image, 14 below it, centred. */
export function DifferenceLegend() {
  return (
    <div
      data-paint="dark"
      className="absolute top-[calc(100%+14px)] left-1/2 flex h-28 -translate-x-1/2 items-center gap-14 whitespace-nowrap rounded-full bg-overlay px-12 inset-ring inset-ring-border backdrop-blur-chip"
    >
      <LegendKey swatch="bg-accent" label={t("edit.compare.changed")} />
      <LegendKey swatch="bg-canvas inset-ring inset-ring-border-strong" label={t("edit.compare.same")} />
    </div>
  );
}

/** Edit the mask: a Button / Secondary / M where the toolbar was, back to painting the original. */
export function EditMaskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="secondary"
      icon={Brush}
      onMouseDown={keepFocus}
      onClick={onClick}
      className="absolute bottom-18 left-1/2 -translate-x-1/2"
    >
      {t("edit.compare.editMask")}
    </Button>
  );
}

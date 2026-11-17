import type { AssetListItem, LayerOpParams, StackLayer } from "@openfield/core";
import { Layers2 } from "lucide-react";
import { type Ref, useImperativeHandle, useRef } from "react";
import { useAuthedImage } from "../../api/hooks/images";
import type { ImageMediaHandle } from "../edit/edit-media";
import { thumbAt } from "../format";
import { ImageLayers, Media, type MediaHandle, type PinnedFrame } from "../media";
import { boxPercent } from "./stack";

// The image area on the Layers tab, and for an image that is one layer of a split.
//
// On the Layers tab (design 6V0TsqNS3g) the stack is put together from its own images, so hiding or
// reordering a layer shows at once, and the selected layer gets its bounds and a label over the
// image. While a split runs, a band of light sweeps down the image (design xYNaPyLK2h).
//
// A layer on its own (design lyJVqwC6sG) sits where it belongs on its stack's canvas.

interface CommonProps {
  item: AssetListItem;
  expanded: boolean;
  label: string;
  onZoomedChange: (zoomed: boolean) => void;
  ref?: Ref<ImageMediaHandle>;
}

/** The view's zoom keys reach Media the same way on every tab; there's never anything to cancel. */
function useHandle(ref: Ref<ImageMediaHandle> | undefined) {
  const media = useRef<MediaHandle>(null);
  useImperativeHandle(ref, () => ({
    zoomIn: () => media.current?.zoomIn(),
    zoomOut: () => media.current?.zoomOut(),
    fit: () => media.current?.fit(),
    toggle: () => media.current?.toggle(),
    cancel: () => false,
  }));
  return media;
}

/** One image of a stack, stretched over its box on the canvas (a layer's file can be a pixel off). */
function Placed({
  asset,
  box,
  canvas,
}: {
  asset: Pick<AssetListItem, "id" | "thumbUrl">;
  box: StackLayer["box"];
  canvas: { width: number; height: number };
}) {
  const image = useAuthedImage(thumbAt(asset, "preview"));
  const at = boxPercent(box, canvas);
  if (image.status !== "ready") return null;
  return (
    <img
      src={image.src}
      alt=""
      draggable={false}
      decoding="async"
      className="absolute object-fill"
      style={{ left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%` }}
    />
  );
}

export interface StackMediaProps extends CommonProps {
  /** The stack top first, base last, or null before there is one. */
  rows: readonly StackLayer[] | null;
  canvas: { width: number; height: number } | null;
  hidden: ReadonlySet<string>;
  selected: StackLayer | null;
  separating: boolean;
}

export function StackMedia({
  item,
  expanded,
  label,
  onZoomedChange,
  rows,
  canvas,
  hidden,
  selected,
  separating,
  ref,
}: StackMediaProps) {
  const media = useHandle(ref);
  const pixels =
    rows && canvas
      ? [...rows]
          .reverse()
          .filter((row) => !hidden.has(row.asset.id))
          .map((row) => <Placed key={row.asset.id} asset={row.asset} box={row.box} canvas={canvas} />)
      : undefined;
  return (
    <Media
      ref={media}
      item={item}
      expanded={expanded}
      label={label}
      onZoomedChange={onZoomedChange}
      pixels={pixels}
      layer={separating ? <ScanBand /> : null}
      pinned={
        selected && canvas && !hidden.has(selected.asset.id)
          ? (frame) => <SelectedBounds frame={frame} layer={selected} canvas={canvas} />
          : null
      }
    />
  );
}

/** Layers / Separating: Scan band (accent 10%, 150 of 680 tall) led by its Scan line (2px, 60%). */
function ScanBand() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="layers-scan absolute inset-x-0 top-0 h-[22.06%] bg-accent/10">
        <div className="absolute inset-x-0 bottom-0 h-2 bg-accent/60" />
      </div>
    </div>
  );
}

/**
 * Layers / Done: Layer bounds (accent 2px, 6% fill, radius 4) round the selected layer, with its
 * Layer label (24 tall, radius 6, the accent) 6 above. Unscaled, so the line stays 2px at any zoom.
 */
function SelectedBounds({
  frame,
  layer,
  canvas,
}: {
  frame: PinnedFrame;
  layer: StackLayer;
  canvas: { width: number; height: number };
}) {
  const at = boxPercent(layer.box, canvas);
  const { image } = frame;
  const left = image.left + (at.left / 100) * image.width;
  const top = image.top + (at.top / 100) * image.height;
  const width = (at.width / 100) * image.width;
  const height = (at.height / 100) * image.height;
  return (
    <>
      <div
        data-testid="layer-bounds"
        className="absolute rounded-4 bg-accent/6 inset-ring-2 inset-ring-accent"
        style={{ left, top, width, height }}
      />
      <div
        data-testid="layer-label"
        className="absolute flex h-24 items-center gap-6 rounded-6 bg-accent px-8"
        style={{ left, top: top - 30 }}
      >
        <Layers2 size={12} aria-hidden className="shrink-0 text-accent-fg" />
        <span className="whitespace-nowrap text-caption font-medium text-accent-fg">{layer.name ?? ""}</span>
      </div>
    </>
  );
}

export interface LayerMediaProps extends CommonProps {
  layer: LayerOpParams;
}

/** Detail · Layer image: the stack's canvas (#1B1D21), with this layer at its box. */
export function LayerMedia({ item, expanded, label, onZoomedChange, layer, ref }: LayerMediaProps) {
  const media = useHandle(ref);
  const { canvas, box } = layer;
  // The base covers its canvas; the frame then is the image itself.
  const placed = box ?? ([0, 0, canvas.width, canvas.height] as const);
  const shown = { ...item, width: canvas.width, height: canvas.height };
  return (
    <Media
      ref={media}
      item={shown}
      expanded={expanded}
      label={label}
      onZoomedChange={onZoomedChange}
      pixels={
        box ? (
          <div className="absolute inset-0 rounded-4 bg-[#1b1d21]">
            <Placed asset={item} box={[...placed]} canvas={canvas} />
          </div>
        ) : (
          <ImageLayers item={item} zoom={1} stretch />
        )
      }
    />
  );
}

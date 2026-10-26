import { pickThumbSize, type ThumbSize, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { ImageOff } from "lucide-react";
import { useRef } from "react";
import { useAuthedImage } from "../../../api/hooks/images";
import { useAssetMissing, usePaneZoom } from "../../store/context";

// A library image at the size it's drawn: the smallest thumbnail rung that covers the box in device
// pixels, so its zoom on the pane and the screen's density both count (§7.10). /files needs the
// session header, so it loads through useAuthedImage like the feed.

const screenDensity = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

export const thumbUrl = (assetId: string, size: ThumbSize) =>
  `/files/thumb/${assetId}?h=${size.h}${size.dpr === 2 ? "&dpr=2" : ""}`;

/** The one place canvas builds a thumbnail URL: nodes, index cards and the version history. */
export function thumbPath(assetId: string, height: number, zoom = 1): string {
  return thumbUrl(assetId, pickThumbSize(height * zoom * screenDensity()));
}

/**
 * thumbPath for an image on the pane (`pane`) or in the chrome. On the pane it follows the zoom the
 * view settled at, and keeps the file it shows while that stays sharp and not much too big
 * (pickThumbSize), so a pan or a small zoom never swaps images.
 */
export function useThumbPath(assetId: string | null, height: number, pane: boolean): string | null {
  const zoom = usePaneZoom(pane);
  const shown = useRef<ThumbSize | null>(null);
  if (!assetId) return null;
  // The same inputs give the same size, so this stays pure across repeated renders.
  shown.current = pickThumbSize(height * zoom * screenDensity(), shown.current);
  return thumbUrl(assetId, shown.current);
}

export function AssetImage({
  assetId,
  height,
  className,
  alt = "",
  pane = false,
}: {
  assetId: string;
  /** How tall it's drawn, in pane pixels. Picks the thumbnail size. */
  height: number;
  className?: string;
  alt?: string;
  /** Drawn on the pane, inside a node: the zoom counts too. */
  pane?: boolean;
}) {
  const missing = useAssetMissing(assetId);
  const path = useThumbPath(missing ? null : assetId, height, pane);
  const image = useAuthedImage(path, { image: assetId });
  if (missing || image.status === "error") return <MissingImage height={height} className={className} />;
  return (
    <span className={cn("block overflow-hidden bg-surface", className)}>
      {image.status === "ready" ? (
        <img
          src={image.src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
        />
      ) : null}
    </span>
  );
}

/**
 * An image the canvas names that isn't in this library (§7.8): a canvas from another computer, or
 * an image deleted since. The node keeps its place; runs leave it out.
 */
function MissingImage({ height, className }: { height: number; className?: string }) {
  const label = t("canvas.nodes.images.missing");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex flex-col items-center justify-center gap-6 overflow-hidden bg-surface text-text-tertiary",
        className,
      )}
    >
      <ImageOff size={height < 60 ? 14 : 18} aria-hidden />
      {height >= 100 ? <span className="px-8 text-center text-caption">{label}</span> : null}
    </span>
  );
}

/** A preview frame from tmp/ while a job streams (job.partial). Replaced by the real image. */
export function PartialImage({ path, className }: { path: string; className?: string }) {
  const image = useAuthedImage(path);
  return image.status === "ready" ? (
    <img src={image.src} alt="" draggable={false} className={cn("size-full object-cover", className)} />
  ) : null;
}

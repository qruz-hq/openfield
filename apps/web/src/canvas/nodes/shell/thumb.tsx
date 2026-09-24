import { resolveThumbRung, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { ImageOff } from "lucide-react";
import { useAuthedImage } from "../../../api/hooks/images";
import { useAssetMissing } from "../../store/context";

// A library image at the size it's drawn: the smallest thumbnail rung at least as tall as the box,
// doubled on high-density screens (§7.10). /files needs the session header, so it loads through
// useAuthedImage like the feed.

/** The one place canvas builds a thumbnail URL: nodes, index cards and the version history. */
export function thumbPath(assetId: string, height: number): string {
  const params = new URLSearchParams({ h: String(resolveThumbRung(height)) });
  if (typeof window !== "undefined" && window.devicePixelRatio > 1) params.set("dpr", "2");
  return `/files/thumb/${assetId}?${params}`;
}

export function AssetImage({
  assetId,
  height,
  className,
  alt = "",
}: {
  assetId: string;
  /** How tall it's drawn, in pane pixels. Picks the thumbnail size. */
  height: number;
  className?: string;
  alt?: string;
}) {
  const missing = useAssetMissing(assetId);
  const image = useAuthedImage(missing ? null : thumbPath(assetId, height));
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

import { assetThumbUrl } from "@openfield/core";
import { cn } from "@openfield/ui";
import { useAuthedImage } from "../../api/hooks/images";

/**
 * The mask over the image it was painted on: the image under the overlay fill, the painted area in
 * the accent at 90%, softened by a 2px blur. The mask's own alpha is 0 where it was painted, so the
 * accent shows through it inverted: a solid layer excluding the mask. It's painted dark in both
 * themes, as everything over an image is, so the accent stays light over the dark fill. Without a
 * mask it's the image under the fill. The detail view's Edited from (54) and the canvas Edit node's
 * settings (40) size it.
 */
export function MaskThumb({
  imageId,
  maskUrl,
  className,
}: {
  imageId: string | null;
  /** The mask's file (an asset's fileUrl, which marks one in the Trash). */
  maskUrl?: string | null;
  className?: string;
}) {
  const image = useAuthedImage(imageId ? assetThumbUrl(imageId, { h: 200 }) : null);
  const painted = useAuthedImage(maskUrl ?? null);
  const shape =
    painted.status === "ready"
      ? {
          // Older WebKit's names first; where a browser takes both, the standard ones come last and win.
          WebkitMaskImage: `linear-gradient(#000, #000), url("${painted.src}")`,
          WebkitMaskComposite: "xor",
          WebkitMaskSize: "cover",
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          maskImage: `linear-gradient(#000, #000), url("${painted.src}")`,
          maskComposite: "exclude",
          // The same crop as the image's object-cover.
          maskSize: "cover",
          maskPosition: "center",
          maskRepeat: "no-repeat",
        }
      : undefined;
  return (
    <div
      aria-hidden
      data-paint="dark"
      className={cn("relative shrink-0 overflow-hidden rounded-8 bg-elevated-2", className)}
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="size-full object-cover" />
      ) : null}
      <span className="absolute inset-0 bg-overlay" />
      {shape ? (
        <span data-mask-thumb className="absolute inset-0 opacity-90 blur-[2px]">
          <span className="absolute inset-0 bg-accent" style={shape} />
        </span>
      ) : null}
      <span className="pointer-events-none absolute inset-0 rounded-8 inset-ring inset-ring-border" />
    </div>
  );
}

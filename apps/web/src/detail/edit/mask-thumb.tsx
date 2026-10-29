import { assetThumbUrl, luminanceToAlpha } from "@openfield/core";
import { cn } from "@openfield/ui";
import { useEffect, useState } from "react";
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
  wired = false,
  className,
}: {
  imageId: string | null;
  /** The mask's file (an asset's fileUrl, which marks one in the Trash), or a thumbnail of it. */
  maskUrl?: string | null;
  /**
   * An image wired into a Mask input rather than a saved mask: read as the server reads it, by
   * its alpha where it has some, else by brightness (white changes).
   */
  wired?: boolean;
  className?: string;
}) {
  const image = useAuthedImage(imageId ? assetThumbUrl(imageId, { h: 200 }) : null);
  const painted = useAuthedImage(maskUrl ?? null);
  const loaded = painted.status === "ready" ? painted.src : null;
  const converted = useAlphaMask(wired ? loaded : null);
  const src = wired ? converted : loaded;
  const shape = src
    ? {
        // Older WebKit's names first; where a browser takes both, the standard ones come last and win.
        WebkitMaskImage: `linear-gradient(#000, #000), url("${src}")`,
        WebkitMaskComposite: "xor",
        WebkitMaskSize: "cover",
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        maskImage: `linear-gradient(#000, #000), url("${src}")`,
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

/**
 * A wired-in image as a saved mask is (transparent where it changes): its own alpha where it has
 * any, else alpha from its brightness (luminanceToAlpha), as the server's alphaOf decides.
 */
function useAlphaMask(src: string | null): string | null {
  const [out, setOut] = useState<string | null>(null);
  useEffect(() => {
    setOut(null);
    if (!src) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (!g || !canvas.width || !canvas.height) return;
      g.drawImage(img, 0, 0);
      const pixels = g.getImageData(0, 0, canvas.width, canvas.height);
      const data = pixels.data;
      let opaque = true;
      for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
      if (!opaque) return setOut(src);
      const alpha = luminanceToAlpha(data, 4);
      for (let p = 0; p < alpha.length; p++) {
        data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = 0;
        data[p * 4 + 3] = alpha[p]!;
      }
      g.putImageData(pixels, 0, 0);
      setOut(canvas.toDataURL());
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return out;
}

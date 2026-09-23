import { Scan } from "lucide-react";
import type { SVGProps } from "react";
import { cn } from "../lib/cn";

export interface AspectGlyphProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** "W:H" such as "3:4" or "16:9", or "auto". */
  ratio: string;
}

const BOX = 12;
const STROKE = 1.5;

/** Aspect glyph: the ratio drawn inside a 12px box, centered in 16. "auto" is the scan icon. */
export function AspectGlyph({ ratio, className, ...props }: AspectGlyphProps) {
  const [w, h] = ratio.split(":").map(Number);
  if (ratio === "auto" || !w || !h) {
    return (
      <Scan size={16} aria-hidden className={cn("shrink-0 text-text-secondary", className)} {...props} />
    );
  }
  const width = w >= h ? BOX : (BOX * w) / h;
  const height = h >= w ? BOX : (BOX * h) / w;
  // design.pen strokes sit inside the shape, so pull the path in by half the stroke.
  const inset = STROKE / 2;
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      aria-hidden
      className={cn("shrink-0 text-text-secondary", className)}
      {...props}
    >
      <rect
        x={(16 - width) / 2 + inset}
        y={(16 - height) / 2 + inset}
        width={width - STROKE}
        height={height - STROKE}
        rx={2 - inset}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
      />
    </svg>
  );
}

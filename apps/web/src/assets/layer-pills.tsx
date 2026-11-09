import { formatNumber, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { Layers, Layers2 } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";

// Pill / Tile / Layers (design eD5Y6V9gwF) and Pill / Tile / Layer (9Coal0X7pn): the Duration pill's
// box (F1pmM0), dark in both themes because they sit on the image.
const pill =
  "inline-flex h-22 shrink-0 items-center gap-4 rounded-full bg-overlay px-8 inset-ring inset-ring-overlay-line backdrop-blur-chip";

/**
 * On an image that was split into layers: how many it has. A click opens its Layers tab. The card
 * under it opens on click too, so this click stays its own.
 */
export function LayersBadge({
  count,
  onOpen,
  tabIndex,
  className,
}: {
  count: number;
  onOpen: () => void;
  /** -1 inside the library grid, which takes the keys for every card. */
  tabIndex?: number;
  className?: string;
}) {
  const stop = (event: MouseEvent | PointerEvent) => event.stopPropagation();
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={t("layerPills.open", { count })}
      onPointerDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(pill, "pointer-events-auto cursor-pointer", className)}
    >
      <Layers size={10} aria-hidden className="shrink-0 text-overlay-fg" />
      <span className="text-mono-11 text-overlay-fg">{formatNumber(count)}</span>
    </button>
  );
}

/** On a layer itself, wherever it shows on its own (search, folders), so it reads as a part. */
export function LayerPill({ className }: { className?: string }) {
  return (
    <span className={cn(pill, "pointer-events-none", className)}>
      <Layers2 size={10} aria-hidden className="shrink-0 text-overlay-fg" />
      <span className="text-micro font-medium text-overlay-fg">{t("layerPills.layer")}</span>
    </span>
  );
}

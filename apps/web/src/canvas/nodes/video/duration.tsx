import { Play } from "lucide-react";
import { useAssetDetail } from "../../../api/hooks/library";

// Pill / Tile / Duration (design t4wzZ, F1pmM0), reused on the Video node's card: the same overlay
// pill the feed shows, bottom-right on the media.

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;

/** The shown video's length, once known. null while it's still loading or has none. */
export function useAssetDuration(assetId: string | null): number | null {
  const detail = useAssetDetail(assetId);
  const ms = detail.data?.asset.durationMs;
  return typeof ms === "number" ? ms / 1000 : null;
}

export function DurationPill({ seconds }: { seconds: number }) {
  return (
    <span className="pointer-events-none absolute right-10 bottom-10 inline-flex h-22 items-center gap-4 rounded-full bg-overlay px-8 inset-ring inset-ring-overlay-line backdrop-blur-chip">
      <Play size={10} aria-hidden className="shrink-0 fill-current text-overlay-fg" />
      <span className="text-mono-11 text-overlay-fg">{clock(seconds)}</span>
    </span>
  );
}

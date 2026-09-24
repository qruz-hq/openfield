import { t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { AssetImage } from "./thumb";

// A node's images (§7.5 result rendering): one fills the preview, two to four sit in a grid with
// 2 px gaps, more scroll in a two-row strip with a ×N chip. Fan-out and list strategies label each
// image ("Image 2", the prompt line) so a grid of runs stays readable (M4-17).

export interface ResultGridProps {
  assetIds: readonly string[];
  /** Caption for the image at an index, or null for none. */
  labelOf?: (index: number) => string | null;
  /** Height of the whole area, for picking thumbnail sizes. */
  height: number;
  /** Inputs changed: images dim to 60% (§7.5 stale). */
  dim?: boolean;
  className?: string;
}

function Cell({ assetId, label, height }: { assetId: string; label: string | null; height: number }) {
  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <AssetImage assetId={assetId} height={height} className="absolute inset-0" alt={label ?? ""} />
      {/* Top left, clear of the state band and chips along the bottom. */}
      {label ? (
        <span className="absolute top-6 left-6 max-w-[calc(100%-12px)] truncate rounded-6 bg-overlay px-6 py-2 text-micro font-medium text-overlay-fg backdrop-blur-chip">
          {label}
        </span>
      ) : null}
    </div>
  );
}

export function ResultGrid({ assetIds, labelOf, height, dim = false, className }: ResultGridProps) {
  const label = (i: number) => labelOf?.(i) ?? null;
  const n = assetIds.length;
  const body =
    n <= 1 ? (
      assetIds[0] ? (
        <Cell assetId={assetIds[0]} label={label(0)} height={height} />
      ) : null
    ) : n <= 4 ? (
      <div className="flex size-full flex-col gap-2">
        {[assetIds.slice(0, 2), assetIds.slice(2, 4)]
          .filter((row) => row.length)
          .map((row, r) => (
            <div key={row[0]} className="flex min-h-0 flex-1 gap-2">
              {row.map((id, c) => (
                <Cell key={id} assetId={id} label={label(r * 2 + c)} height={height / 2} />
              ))}
            </div>
          ))}
      </div>
    ) : (
      <div className="nowheel grid size-full auto-cols-[calc((100%-2px)/2)] grid-flow-col grid-rows-2 gap-2 overflow-x-auto [scrollbar-width:none]">
        {assetIds.map((id, i) => (
          <Cell key={id} assetId={id} label={label(i)} height={height / 2} />
        ))}
      </div>
    );
  return (
    <div className={cn("relative flex size-full transition-opacity", dim && "opacity-60", className)}>
      {body}
      {n > 4 ? (
        <span className="absolute top-8 right-8 rounded-6 bg-overlay px-6 py-2 text-mono-11 font-medium text-overlay-fg backdrop-blur-chip">
          ×{n}
        </span>
      ) : null}
    </div>
  );
}

/** "Image 2": the caption for a fanned-out run's images, by which input they came from. */
export const sourceLabel = (source: number) => t("canvas.nodes.variations.source", { index: source + 1 });

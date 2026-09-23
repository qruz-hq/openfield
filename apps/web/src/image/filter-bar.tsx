import { MAX_FEED_ZOOM, t } from "@openfield/core";
import { FilterPill, ZoomSlider } from "@openfield/ui";

// Feed / Filter bar: filters on the left, grid size on the right. 42 tall.

export function FilterBar({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return (
    <div className="flex h-42 w-full shrink-0 items-center justify-between px-16">
      <div className="flex items-center gap-8">
        <FilterPill active>{t("feed.filters.all")}</FilterPill>
      </div>
      <ZoomSlider
        thumbLabel={t("feed.zoom.label")}
        min={0}
        max={MAX_FEED_ZOOM}
        step={1}
        value={[zoom]}
        onValueChange={([next]) => next !== undefined && onZoom(next)}
      />
    </div>
  );
}

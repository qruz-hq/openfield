import { type ModelListItem, THUMB_RUNGS, t } from "@openfield/core";
import { Button } from "@openfield/ui";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FeedItem } from "../image/feed-items";
import { solveRows } from "../image/rows";
import { useReveal } from "../lib/reveal";
import { VideoAssetTile, VideoJobTile } from "./tiles";

// Feed rows: the same justified layout as the Image feed (image/feed.tsx, image/rows.ts), with
// video tiles in place of image ones. Every video's own ratio, like the design's justified grid.

export interface VideoFeedProps {
  items: readonly FeedItem[];
  zoom: number;
  models: readonly ModelListItem[];
  scrollRoot: RefObject<HTMLElement | null>;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: () => void;
}

const ratioOf = (item: FeedItem) =>
  item.kind === "asset" ? item.asset.width / item.asset.height : item.job.width / item.job.height;

function useWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function VideoFeed({
  items,
  zoom,
  models,
  scrollRoot,
  hasMore,
  loadingMore,
  loadMoreFailed,
  onLoadMore,
}: VideoFeedProps) {
  const rung = THUMB_RUNGS[zoom] ?? THUMB_RUNGS[3];
  const container = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const width = useWidth(container);
  const rows = useMemo(() => solveRows(items, ratioOf, Math.floor(width), rung), [items, width, rung]);
  const revealing = useReveal((s) => s.jobSetId);

  useEffect(() => {
    if (!revealing || !rows.length) return;
    const tile = container.current?.querySelector<HTMLElement>(`[data-job-set="${CSS.escape(revealing)}"]`);
    if (!tile) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tile.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    if (!tile.hasAttribute("tabindex")) tile.setAttribute("tabindex", "-1");
    tile.focus({ preventScroll: true });
    useReveal.getState().done();
  }, [revealing, rows]);

  useEffect(() => {
    if (!revealing) return;
    const timer = setTimeout(() => useReveal.getState().done(), 10_000);
    return () => clearTimeout(timer);
  }, [revealing]);

  const modelName = (providerId: string | null, modelId: string | null) =>
    models.find((m) => m.providerId === providerId && m.modelId === modelId)?.displayName;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loadMoreFailed) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && !loadingMore && onLoadMore(),
      { root: scrollRoot.current, rootMargin: "1200px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMoreFailed, onLoadMore, scrollRoot]);

  return (
    <section aria-label={t("feed.label")} className="w-full pb-240">
      <div ref={container} className="flex w-full flex-col gap-2">
        {rows.map((row) => (
          <ul key={row.tiles[0]!.item.key} className="flex w-full gap-2" style={{ height: row.height }}>
            {row.tiles.map(({ item, width: w }) => {
              const style = { width: w, height: row.height };
              return item.kind === "asset" ? (
                <VideoAssetTile
                  key={item.key}
                  asset={item.asset}
                  rung={rung}
                  model={modelName(item.asset.providerId, item.asset.modelId)}
                  style={style}
                />
              ) : (
                <VideoJobTile
                  key={item.key}
                  jobSet={item.jobSet}
                  job={item.job}
                  jobs={item.jobs}
                  batch={item.batch}
                  model={models.find((m) => m.key === item.jobSet.model)}
                  style={style}
                />
              );
            })}
          </ul>
        ))}
      </div>
      {loadMoreFailed ? (
        <div className="flex h-40 w-full items-center gap-8 px-16">
          <span className="text-small text-text-secondary">{t("feed.loadMoreFailed")}</span>
          <Button variant="ghost" size="s" onClick={onLoadMore}>
            {t("actions.tryAgain")}
          </Button>
        </div>
      ) : null}
      <div ref={sentinel} aria-hidden className="h-px w-full" />
    </section>
  );
}

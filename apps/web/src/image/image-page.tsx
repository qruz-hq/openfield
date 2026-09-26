import { type AssetListItem, DEFAULT_FEED_ZOOM, type LibraryQuery } from "@openfield/core";
import { Banner } from "@openfield/ui";
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import { useAssets } from "../api/hooks/assets";
import { useJobSets } from "../api/hooks/job-sets";
import { useProviders } from "../api/hooks/keys";
import { useModels } from "../api/hooks/models";
import { useSettings, useUpdateSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { DetailView } from "../detail";
import { useDismissed, useLive } from "../lib/live";
import { Composer } from "./composer/composer";
import { Feed } from "./feed";
import { buildFeed } from "./feed-items";
import { FilterBar } from "./filter-bar";
import { FirstImage, FirstRun } from "./first-run";

// Image workspace: filter bar and feed scroll under the nav; the composer floats above.
// Favorites join the filter bar with the tile's favorite action (M1-11), not before (§0.15).

/** The feed is every image, newest first: All images, as the server lists it. */
const FEED_QUERY: LibraryQuery = { view: "all" };

export function ImagePage() {
  const scroll = useRef<HTMLDivElement>(null);
  const connected = useLive((s) => s.connected);
  const dismissed = useDismissed((s) => s.jobs);
  const models = useModels();
  const providers = useProviders();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const assets = useAssets("all");
  const jobSets = useJobSets({ poll: !connected });
  const zoom = settings.data?.feedZoom ?? DEFAULT_FEED_ZOOM;

  const items = useMemo(
    () =>
      buildFeed({
        assets: assets.data?.pages.flatMap((page) => page.items) ?? [],
        jobSets: jobSets.data ?? [],
        dismissed: new Set(dismissed),
        includeJobs: true,
        hasMoreAssets: assets.hasNextPage,
      }),
    [assets.data, jobSets.data, dismissed, assets.hasNextPage],
  );

  // The detail view steps through the feed's images in the order the feed shows them (§4.0).
  const images = useMemo(
    () => items.flatMap((item): AssetListItem[] => (item.kind === "asset" ? [item.asset] : [])),
    [items],
  );

  const { fetchNextPage } = assets;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  const loaded = models.isSuccess && assets.isSuccess && (jobSets.isSuccess || jobSets.isError);
  const anyReady = models.data?.some((m) => m.ready) ?? false;
  const empty = loaded && items.length === 0;

  let body: ReactNode;
  if (models.isError || (assets.isError && !assets.data)) {
    body = (
      <div className="p-16">
        <Banner variant="error" message={errorMessage(models.error ?? assets.error)} />
      </div>
    );
  } else if (!loaded) {
    body = null;
  } else if (empty) {
    body = anyReady ? <FirstImage /> : <FirstRun providers={providers.data} />;
  } else {
    body = (
      <>
        <FilterBar
          zoom={zoom}
          onZoom={(feedZoom) => feedZoom !== zoom && updateSettings.mutate({ feedZoom })}
        />
        <Feed
          items={items}
          zoom={zoom}
          models={models.data ?? []}
          scrollRoot={scroll}
          hasMore={assets.hasNextPage}
          loadingMore={assets.isFetchingNextPage}
          loadMoreFailed={assets.isFetchNextPageError}
          onLoadMore={loadMore}
        />
      </>
    );
  }

  return (
    <>
      <div ref={scroll} className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
        {body}
      </div>
      {/* Until the page knows, Generate waits like it does on first run. */}
      <Composer firstRun={!loaded || (empty && !anyReady)} />
      <DetailView
        items={images}
        query={FEED_QUERY}
        hasMore={assets.hasNextPage}
        loadingMore={assets.isFetchingNextPage}
        onLoadMore={loadMore}
        loading={!assets.isSuccess}
      />
    </>
  );
}

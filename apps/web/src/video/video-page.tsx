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
import { buildFeed } from "../image/feed-items";
import { FilterBar } from "../image/filter-bar";
import { useDismissed, useLive } from "../lib/live";
import { VideoComposer } from "./composer/composer";
import { VideoFeed } from "./feed";
import { FirstVideo, FirstVideoRun } from "./first-run";

// Video workspace (design FYOTg): the same shell as the Image page (image/image-page.tsx), its
// own composer and feed, and only video runs and assets — the Image page's own feed never sees
// them, and this one never sees images (§0.16).

const FEED_QUERY: LibraryQuery = { view: "all", modality: "video" };

export function VideoPage() {
  const scroll = useRef<HTMLDivElement>(null);
  const connected = useLive((s) => s.connected);
  const dismissed = useDismissed((s) => s.jobs);
  const models = useModels("video");
  const providers = useProviders();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const assets = useAssets("all", { modality: "video" });
  const jobSets = useJobSets({ poll: !connected, modality: "video" });
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

  const videos = useMemo(
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
    body = anyReady ? <FirstVideo /> : <FirstVideoRun providers={providers.data} />;
  } else {
    body = (
      <>
        <FilterBar
          zoom={zoom}
          onZoom={(feedZoom) => feedZoom !== zoom && updateSettings.mutate({ feedZoom })}
        />
        <VideoFeed
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
      <VideoComposer firstRun={!loaded || (empty && !anyReady)} />
      <DetailView
        items={videos}
        query={FEED_QUERY}
        hasMore={assets.hasNextPage}
        loadingMore={assets.isFetchingNextPage}
        onLoadMore={loadMore}
        loading={!assets.isSuccess}
      />
    </>
  );
}

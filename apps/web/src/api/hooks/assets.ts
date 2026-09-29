import { ASSET_PAGE_SIZE, type AssetListItem, type AssetsListResponse } from "@openfield/core";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

export type AssetFilter = "all" | "favourites";
export type AssetModalityFilter = "image" | "video";
export type AssetPages = InfiniteData<AssetsListResponse, string | null>;

/**
 * The feed's images (or videos), newest first, 50 a page (§2.3). `q` searches them (the canvas
 * library picker); a search is cached under its own key, beside the feed's. `modality` narrows to
 * one kind, as the Image and Video pages and the image-only pickers all need (§0.16); left out,
 * the server answers with both.
 */
export function useAssets(
  filter: AssetFilter,
  opts: { q?: string; enabled?: boolean; modality?: AssetModalityFilter } = {},
) {
  const q = opts.q?.trim() || undefined;
  const { modality } = opts;
  return useInfiniteQuery({
    queryKey: q
      ? ([...queryKeys.assets(filter, modality), "q", q] as const)
      : queryKeys.assets(filter, modality),
    enabled: opts.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      call(
        api.api.assets.$get(
          {
            query: {
              limit: String(ASSET_PAGE_SIZE),
              ...(pageParam ? { cursor: pageParam } : {}),
              ...(filter === "favourites" ? { favourite: "1" as const } : {}),
              ...(modality ? { modality } : {}),
              ...(q ? { q } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * Put a new asset at the top of every loaded, unfiltered "all" feed whose modality it matches (the
 * Image page's, the Video page's, and the library's own, which has none and takes every kind).
 */
export function prependAsset(asset: AssetListItem) {
  // No page or picker asks for audio yet, so this cache never carries an "audio" key.
  if (asset.modality !== "image" && asset.modality !== "video") return;
  for (const modality of [undefined, asset.modality] as const) {
    queryClient.setQueryData<AssetPages>(queryKeys.assets("all", modality), (data) => {
      if (!data?.pages.length) return data;
      if (data.pages.some((page) => page.items.some((item) => item.id === asset.id))) return data;
      const [first, ...rest] = data.pages;
      return { ...data, pages: [{ ...first!, items: [asset, ...first!.items] }, ...rest] };
    });
  }
}

/** Apply a change to an image wherever it's cached. */
export function patchAsset(asset: AssetListItem) {
  queryClient.setQueriesData<AssetPages>({ queryKey: queryKeys.allAssets }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (item.id === asset.id ? asset : item)),
          })),
        }
      : data,
  );
}

export function removeAssets(ids: readonly string[]) {
  const gone = new Set(ids);
  queryClient.setQueriesData<AssetPages>({ queryKey: queryKeys.allAssets }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => !gone.has(item.id)),
          })),
        }
      : data,
  );
}

/** Change some images wherever they're cached, in the feed and every library view. */
export function updateCachedAssets(ids: readonly string[], update: (item: AssetListItem) => AssetListItem) {
  const wanted = new Set(ids);
  queryClient.setQueriesData<AssetPages>({ queryKey: queryKeys.allAssets }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => (wanted.has(item.id) ? update(item) : item)),
          })),
        }
      : data,
  );
}

/** The cached copies of these images, first one found per id: what an optimistic change replaced. */
export function cachedAssets(ids: readonly string[]): Map<string, AssetListItem> {
  const wanted = new Set(ids);
  const found = new Map<string, AssetListItem>();
  for (const [, data] of queryClient.getQueriesData<AssetPages>({ queryKey: queryKeys.allAssets })) {
    for (const page of data?.pages ?? []) {
      for (const item of page.items) if (wanted.has(item.id) && !found.has(item.id)) found.set(item.id, item);
    }
  }
  return found;
}

export type AssetCacheSnapshot = [readonly unknown[], AssetPages | undefined][];

/** Every cached image list as it is now, to put back if an optimistic change fails. */
export function snapshotAssetCaches(): AssetCacheSnapshot {
  return queryClient.getQueriesData<AssetPages>({ queryKey: queryKeys.allAssets });
}

export function restoreAssetCaches(snapshot: AssetCacheSnapshot) {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}

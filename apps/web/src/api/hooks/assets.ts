import { ASSET_PAGE_SIZE, type AssetListItem, type AssetsListResponse } from "@openfield/core";
import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

export type AssetFilter = "all" | "favourites";
export type AssetPages = InfiniteData<AssetsListResponse, string | null>;

/**
 * The feed's images, newest first, 50 a page (§2.3). `q` searches them (the canvas library picker);
 * a search is cached under its own key, beside the feed's.
 */
export function useAssets(filter: AssetFilter, opts: { q?: string; enabled?: boolean } = {}) {
  const q = opts.q?.trim() || undefined;
  return useInfiniteQuery({
    queryKey: q ? ([...queryKeys.assets(filter), "q", q] as const) : queryKeys.assets(filter),
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
              ...(q ? { q } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Put a new image at the top of the unfiltered feed, once. */
export function prependAsset(asset: AssetListItem) {
  queryClient.setQueryData<AssetPages>(queryKeys.assets("all"), (data) => {
    if (!data?.pages.length) return data;
    if (data.pages.some((page) => page.items.some((item) => item.id === asset.id))) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first!, items: [asset, ...first!.items] }, ...rest] };
  });
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

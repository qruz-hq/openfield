import {
  ASSET_PAGE_SIZE,
  type AssetBulkResponse,
  type AssetDetailResponse,
  type AssetListItem,
  type AssetMembershipsResponse,
  type AssetNeighboursResponse,
  type AssetsListResponse,
  BULK_MAX_IDS,
  type BulkAction,
  type EmptyTrashResponse,
  type LibraryListParams,
  type LibraryQuery,
  type LibrarySummary,
  libraryListParams,
  type SseEvent,
} from "@openfield/core";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { notifyError } from "../../lib/notify";
import { api, call, queryClient, queryKeys } from "../client";
import { errorMessage, rawFetch, toApiError } from "../raw";
import {
  type AssetPages,
  cachedAssets,
  restoreAssetCaches,
  snapshotAssetCaches,
  updateCachedAssets,
} from "./assets";

// The Assets library's data (§2.8, §4.0): each view's pages on the shared cursor, the sidebar
// counts and filter choices, the detail view's data, and the bulk actions with their optimistic
// cache updates. Folders and filing live in folders.ts.
//
// Routes this file expects (§8.3):
//   GET    /api/assets?cursor&limit&folder&favourite=1&trash=1&q&model&provider&from  → AssetsListResponse
//   GET    /api/assets/:id                                                     → AssetDetailResponse
//   GET    /api/assets/:id/neighbours?<the listing's filters>                  → AssetNeighboursResponse
//   POST   /api/assets/bulk {ids, action, folderId?}                            → AssetBulkResponse (download: a zip)
//   POST   /api/assets/memberships {ids}                                        → AssetMembershipsResponse
//   GET    /api/library/summary                                                 → LibrarySummary
//   POST   /api/maintenance/empty-trash {}                                      → EmptyTrashResponse

/**
 * Library listings sit under "assets", so the feed's cache helpers (prependAsset, patchAsset,
 * removeAssets) reach them too. The third part is the query sent to the server, which TanStack
 * matches partially: libraryKeys.list({ folder: id }) finds every listing of that folder.
 */
export const libraryKeys = {
  lists: ["assets", "library"] as const,
  list: (params: LibraryListParams) => ["assets", "library", params] as const,
  summary: ["library", "summary"] as const,
  detail: (id: string) => ["asset", id] as const,
  details: ["asset"] as const,
  neighbours: (id: string, params: LibraryListParams) => ["asset", id, "neighbours", params] as const,
  memberships: (key: string) => ["library", "memberships", key] as const,
  allMemberships: ["library", "memberships"] as const,
  /** The flat folder list (folders.ts). Here so both files use the one key. */
  folders: ["folders"] as const,
};

/** JSON over the session-authenticated fetch, for routes the typed client doesn't know yet. */
export async function requestJson<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await rawFetch(path, {
    method,
    signal,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

const withQuery = (path: string, params: object) => {
  const search = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ).toString();
  return search ? `${path}?${search}` : path;
};

// Listings

/**
 * One library view, 50 a page, newest first (newest deletion first in the Trash). The first page
 * carries the header's total; libraryTotal reads it.
 */
export function useLibrary(query: LibraryQuery, opts: { enabled?: boolean } = {}) {
  const params = libraryListParams(query);
  return useInfiniteQuery({
    queryKey: libraryKeys.list(params),
    enabled: opts.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchLibraryPage(params, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function fetchLibraryPage(
  params: LibraryListParams,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<AssetsListResponse> {
  return call(
    api.api.assets.$get(
      { query: { limit: String(ASSET_PAGE_SIZE), ...params, ...(cursor ? { cursor } : {}) } },
      { init: { signal } },
    ),
  );
}

export const libraryItems = (data: AssetPages | undefined): AssetListItem[] =>
  data?.pages.flatMap((page) => page.items) ?? [];

export const libraryTotal = (data: AssetPages | undefined): number | undefined => data?.pages[0]?.total;

/** The images either side of one in a loaded list, for the detail view's arrows. */
export function neighboursIn(items: readonly AssetListItem[], id: string) {
  const index = items.findIndex((item) => item.id === id);
  return {
    index,
    previous: index > 0 ? items[index - 1]! : null,
    next: index >= 0 && index < items.length - 1 ? items[index + 1]! : null,
  };
}

// Sidebar counts and filter choices

export function useLibrarySummary() {
  return useQuery({
    queryKey: libraryKeys.summary,
    queryFn: ({ signal }) => requestJson<LibrarySummary>("GET", "/api/library/summary", undefined, signal),
  });
}

function patchSummary(update: (counts: LibrarySummary["counts"]) => Partial<LibrarySummary["counts"]>) {
  queryClient.setQueryData<LibrarySummary>(libraryKeys.summary, (data) =>
    data ? { ...data, counts: clampCounts({ ...data.counts, ...update(data.counts) }) } : data,
  );
}

const clampCounts = (counts: LibrarySummary["counts"]): LibrarySummary["counts"] => ({
  all: Math.max(0, counts.all),
  favourites: Math.max(0, counts.favourites),
  trash: Math.max(0, counts.trash),
});

// Detail view

/** Everything the Info panel shows. Also answers for an image in the Trash. */
export function useAssetDetail(id: string | null) {
  return useQuery({
    queryKey: libraryKeys.detail(id ?? ""),
    enabled: id !== null,
    queryFn: ({ signal }) => call(api.api.assets[":id"].$get({ param: { id: id! } }, { init: { signal } })),
  });
}

/**
 * The images either side of `id` in a view, from the server. The detail view needs this only when
 * the image isn't in a loaded page, as after a reload with ?asset=.
 */
export function useAssetNeighbours(id: string | null, query: LibraryQuery, opts: { enabled?: boolean } = {}) {
  const params = libraryListParams(query);
  return useQuery({
    queryKey: libraryKeys.neighbours(id ?? "", params),
    enabled: id !== null && (opts.enabled ?? true),
    queryFn: ({ signal }) =>
      requestJson<AssetNeighboursResponse>(
        "GET",
        withQuery(`/api/assets/${encodeURIComponent(id!)}/neighbours`, params),
        undefined,
        signal,
      ),
  });
}

// The Add to folder picker

export type Membership = "on" | "mixed" | "off";

/**
 * Which folders the selection is in. The key is a short hash of the sorted ids, so thousands of
 * selected images don't make a key of thousands of ids.
 */
export function useFolderMemberships(ids: readonly string[], opts: { enabled?: boolean } = {}) {
  const sorted = [...new Set(ids)].sort();
  return useQuery({
    queryKey: libraryKeys.memberships(`${sorted.length}:${sorted[0]}:${sorted.at(-1)}:${hashIds(sorted)}`),
    enabled: sorted.length > 0 && (opts.enabled ?? true),
    queryFn: async ({ signal }) => {
      const counts = new Map<string, number>();
      for (const part of batches(sorted)) {
        const res = await requestJson<AssetMembershipsResponse>(
          "POST",
          "/api/assets/memberships",
          { ids: part },
          signal,
        );
        for (const { folderId, count } of res.folders)
          counts.set(folderId, (counts.get(folderId) ?? 0) + count);
      }
      return { total: sorted.length, counts };
    },
    select: withStates,
  });
}

function withStates(data: { total: number; counts: Map<string, number> }) {
  return {
    ...data,
    stateOf: (folderId: string): Membership => {
      const count = data.counts.get(folderId) ?? 0;
      return count === 0 ? "off" : count >= data.total ? "on" : "mixed";
    },
  };
}

/** FNV-1a, enough to tell selections apart in a cache key. */
function hashIds(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2c; // a separator, so ["ab","c"] and ["a","bc"] differ
  }
  return (hash >>> 0).toString(36);
}

export const invalidateMemberships = () =>
  queryClient.invalidateQueries({ queryKey: libraryKeys.allMemberships });

// Bulk actions. Each call is one request and one transaction; past BULK_MAX_IDS it's split.

function batches(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += BULK_MAX_IDS) out.push(ids.slice(i, i + BULK_MAX_IDS));
  return out;
}

/** POST /api/assets/bulk. `changed` is what the call really did, for Undo. */
export async function bulk(
  action: Exclude<BulkAction, "download">,
  ids: readonly string[],
  folderId?: string,
): Promise<AssetBulkResponse> {
  const result: AssetBulkResponse = { affected: 0, changed: [] };
  for (const part of batches([...new Set(ids)])) {
    const res = await requestJson<AssetBulkResponse>("POST", "/api/assets/bulk", {
      ids: part,
      action,
      ...(folderId && { folderId }),
    });
    result.affected += res.affected;
    result.changed.push(...res.changed);
  }
  return result;
}

const invalidateLists = () => queryClient.invalidateQueries({ queryKey: queryKeys.allAssets });
const invalidateSummary = () => queryClient.invalidateQueries({ queryKey: libraryKeys.summary });
const invalidateFolders = () => queryClient.invalidateQueries({ queryKey: libraryKeys.folders });
const trashLists = () => ({ queryKey: libraryKeys.list({ trash: "1" }) });

function patchDetails(ids: readonly string[], isFavourite: boolean) {
  for (const id of ids) {
    queryClient.setQueryData<AssetDetailResponse>(libraryKeys.detail(id), (data) =>
      data ? { ...data, isFavourite, asset: { ...data.asset, isFavourite } } : data,
    );
  }
}

/**
 * Favourite or unfavourite, straight away on every card and the detail view. In Favorites, an
 * image that's unfavourited stays in place until the view is opened again (§2.8), so that list is
 * only marked stale.
 */
export function useSetFavourite() {
  return useMutation({
    mutationFn: ({ ids, on }: { ids: readonly string[]; on: boolean }) =>
      bulk(on ? "favourite" : "unfavourite", ids),
    onMutate: ({ ids, on }) => {
      const before = cachedAssets(ids);
      updateCachedAssets(ids, (item) => ({ ...item, isFavourite: on }));
      patchDetails(ids, on);
      return { before };
    },
    onError: (error, { ids, on }, context) => {
      // Back to what each card showed; an image no list had loaded goes back to the other state.
      updateCachedAssets(ids, (item) => ({
        ...item,
        isFavourite: context?.before.get(item.id)?.isFavourite ?? !on,
      }));
      patchDetails(ids, !on);
      notifyError(errorMessage(error));
    },
    onSuccess: ({ changed }, { on }) => {
      patchSummary((c) => ({ favourites: c.favourites + (on ? changed.length : -changed.length) }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: libraryKeys.list({ favourite: "1" }),
        refetchType: "none",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assets("favourites"), refetchType: "none" });
      void invalidateSummary();
    },
  });
}

/**
 * Delete: to the Trash. The images leave every list at once and keep their folders and favourite,
 * so Undo (useRestoreAssets with `changed`) puts them back where they were (§0.7).
 */
export function useTrashAssets() {
  return useMutation({
    mutationFn: ({ ids }: { ids: readonly string[] }) => bulk("delete", ids),
    onMutate: ({ ids }) => {
      const snapshot = snapshotAssetCaches();
      const known = cachedAssets(ids);
      const favourites = [...known.values()].filter((item) => item.isFavourite).length;
      removeFromLists(queryKeys.allAssets, ids);
      patchSummary((c) => ({
        all: c.all - ids.length,
        favourites: c.favourites - favourites,
        trash: c.trash + ids.length,
      }));
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      if (context) restoreAssetCaches(context.snapshot);
      notifyError(errorMessage(error));
    },
    onSettled: (_data, _error, { ids }) => {
      void queryClient.invalidateQueries(trashLists());
      for (const id of ids) void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
      void invalidateSummary();
      void invalidateFolders();
      void invalidateMemberships();
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

/** Restore from the Trash: back in All images, in every folder they were in, and in Favorites. */
export function useRestoreAssets() {
  return useMutation({
    mutationFn: ({ ids }: { ids: readonly string[] }) => bulk("restore", ids),
    onMutate: ({ ids }) => {
      const snapshot = snapshotAssetCaches();
      removeFromLists(trashLists().queryKey, ids);
      patchSummary((c) => ({ trash: c.trash - ids.length, all: c.all + ids.length }));
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      if (context) restoreAssetCaches(context.snapshot);
      notifyError(errorMessage(error));
    },
    onSettled: (_data, _error, { ids }) => {
      void invalidateLists();
      for (const id of ids) void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
      void invalidateSummary();
      void invalidateFolders();
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

/** Delete for good, from the Trash. Asks first in the UI; there's no Undo. */
export function usePurgeAssets() {
  return useMutation({
    mutationFn: ({ ids }: { ids: readonly string[] }) => bulk("purge", ids),
    onMutate: ({ ids }) => {
      const snapshot = snapshotAssetCaches();
      removeFromLists(trashLists().queryKey, ids);
      patchSummary((c) => ({ trash: c.trash - ids.length }));
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      if (context) restoreAssetCaches(context.snapshot);
      notifyError(errorMessage(error));
    },
    onSuccess: ({ changed }) => {
      for (const id of changed) queryClient.removeQueries({ queryKey: libraryKeys.detail(id) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries(trashLists());
      void invalidateSummary();
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

/** Empty trash: every image in the Trash, deleted for good. */
export function useEmptyTrash() {
  return useMutation({
    mutationFn: () => requestJson<EmptyTrashResponse>("POST", "/api/maintenance/empty-trash", {}),
    onMutate: () => {
      const snapshot = snapshotAssetCaches();
      queryClient.setQueriesData<AssetPages>(trashLists(), (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page, i) => ({ ...page, items: [], ...(i === 0 && { total: 0 }) })),
            }
          : data,
      );
      patchSummary(() => ({ trash: 0 }));
      return { snapshot };
    },
    onError: (error, _vars, context) => {
      if (context) restoreAssetCaches(context.snapshot);
      notifyError(errorMessage(error));
    },
    onSettled: () => {
      void queryClient.invalidateQueries(trashLists());
      void invalidateSummary();
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

/** Takes images out of the lists under one key, adjusting each first page's total. */
export function removeFromLists(queryKey: readonly unknown[], ids: readonly string[]) {
  const gone = new Set(ids);
  queryClient.setQueriesData<AssetPages>({ queryKey }, (data) => {
    if (!data) return data;
    let removed = 0;
    const pages = data.pages.map((page) => {
      const items = page.items.filter((item) => !gone.has(item.id));
      removed += page.items.length - items.length;
      return { ...page, items };
    });
    return {
      ...data,
      pages: pages.map((page, i) =>
        i === 0 && page.total !== undefined ? { ...page, total: Math.max(0, page.total - removed) } : page,
      ),
    };
  });
}

/**
 * Download: the originals as a zip, saved under the name the server gives it
 * (openfield-<date>-<count>.zip). Past BULK_MAX_IDS images it comes as several zips.
 */
export async function downloadZip(ids: readonly string[]): Promise<void> {
  for (const part of batches([...new Set(ids)])) {
    const res = await rawFetch("/api/assets/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: part, action: "download" }),
    });
    if (!res.ok) throw await toApiError(res);
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") ?? "");
    saveBlob(await res.blob(), named?.[1] ? decodeURIComponent(named[1]) : `openfield-${part.length}.zip`);
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has the file once the click is handled; the URL can go on the next task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// The event stream

/**
 * Keeps library caches in step with the stream. Wire it once, with subscribeEvents(applyLibraryEvent)
 * from events.ts; the feed's own handlers already patch and remove images in every list.
 */
export function applyLibraryEvent(event: SseEvent) {
  switch (event.event) {
    case "job.output":
      // A new image: in All images (unfiltered it's simply the newest) and in the counts.
      prependToLists(libraryKeys.list({}), event.data.asset);
      void invalidateSummary();
      return;
    case "asset.updated":
      queryClient.setQueryData<AssetDetailResponse>(libraryKeys.detail(event.data.asset.id), (data) =>
        data
          ? {
              ...data,
              isFavourite: event.data.asset.isFavourite,
              asset: { ...data.asset, ...event.data.asset },
            }
          : data,
      );
      void invalidateSummary();
      return;
    case "asset.deleted":
      // Soft deletes land in the Trash; hard ones leave it. Either way counts and folders move.
      void queryClient.invalidateQueries(trashLists());
      for (const id of event.data.assetIds) {
        if (event.data.hard) queryClient.removeQueries({ queryKey: libraryKeys.detail(id) });
        else void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
      }
      void invalidateSummary();
      void invalidateFolders();
      return;
    case "folder.updated":
      void invalidateFolders();
      if (event.data.deleted) {
        queryClient.removeQueries({ queryKey: libraryKeys.list({ folder: event.data.folderId }) });
        // The Folders row of any open detail view may name it.
        void queryClient.invalidateQueries({ queryKey: libraryKeys.details });
      } else {
        void queryClient.invalidateQueries({ queryKey: libraryKeys.list({ folder: event.data.folderId }) });
      }
      void invalidateMemberships();
      return;
    default:
      return;
  }
}

function prependToLists(queryKey: readonly unknown[], asset: AssetListItem) {
  queryClient.setQueriesData<AssetPages>({ queryKey, exact: true }, (data) => {
    if (!data?.pages.length) return data;
    if (data.pages.some((page) => page.items.some((item) => item.id === asset.id))) return data;
    const [first, ...rest] = data.pages;
    const total = first!.total === undefined ? undefined : first!.total + 1;
    return {
      ...data,
      pages: [{ ...first!, items: [asset, ...first!.items], ...(total !== undefined && { total }) }, ...rest],
    };
  });
}

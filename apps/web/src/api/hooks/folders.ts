import {
  buildFolderTree,
  type Folder,
  type FolderDeleteResponse,
  folderDescendants,
  moveTarget,
  t,
} from "@openfield/core";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { notifyError } from "../../lib/notify";
import { queryClient } from "../client";
import { ApiError, errorMessage } from "../raw";
import { restoreAssetCaches, snapshotAssetCaches } from "./assets";
import { bulk, invalidateMemberships, libraryKeys, removeFromLists, requestJson } from "./library";

// Folders (§0.7, §2.8): a tree of labels with no depth limit, counts of what's directly inside,
// and many-to-many filing. Every change shows at once and rolls back if the server says no.
//
// Routes this file expects (§8.3):
//   GET    /api/folders                               → Folder[]
//   POST   /api/folders {name, parentId?}             → Folder (404 for an unknown parent)
//   PATCH  /api/folders/:id {name?, parentId?}        → Folder (409 conflict: inside itself)
//   DELETE /api/folders/:id                           → {ok, deletedIds}
//   POST   /api/assets/bulk {ids, action: "addFolder" | "removeFolder", folderId} → {affected, changed}

export const folderKeys = { all: libraryKeys.folders };

export const foldersQuery = queryOptions({
  queryKey: folderKeys.all,
  queryFn: ({ signal }) => requestJson<Folder[]>("GET", "/api/folders", undefined, signal),
});

/** Every folder, flat, as the server sends it. */
export const useFolders = () => useQuery(foldersQuery);

/** The tree the sidebar, the picker and Move to draw. Rebuilt only when the list changes. */
export const useFolderTree = () => useQuery({ ...foldersQuery, select: buildFolderTree });

// A folder shown before the server has answered. It can't be opened, filed into or moved yet.
const PENDING = "pending:";
export const isPendingFolder = (id: string) => id.startsWith(PENDING);

const cachedFolders = () => queryClient.getQueryData<Folder[]>(folderKeys.all);
const invalidateFolders = () => queryClient.invalidateQueries({ queryKey: folderKeys.all });

function patchFolders(update: (list: Folder[]) => Folder[]) {
  queryClient.setQueryData<Folder[]>(folderKeys.all, (list) => (list ? update(list) : list));
}

function patchFolder(id: string, patch: Partial<Folder>) {
  patchFolders((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

/** Moves a folder's count by `delta`, never below zero. */
function bumpCount(id: string, delta: number) {
  if (delta === 0) return;
  patchFolders((list) => list.map((f) => (f.id === id ? { ...f, count: Math.max(0, f.count + delta) } : f)));
}

/** New folder, at the top level or inside `parentId`. Resolves to the server's folder. */
export function useCreateFolder() {
  return useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId?: string | null }) =>
      requestJson<Folder>("POST", "/api/folders", { name, ...(parentId && { parentId }) }),
    onMutate: async ({ name, parentId }) => {
      await queryClient.cancelQueries({ queryKey: folderKeys.all });
      const pendingId = `${PENDING}${crypto.randomUUID()}`;
      const at = new Date().toISOString();
      patchFolders((list) => [
        ...list,
        {
          id: pendingId,
          name: name.trim(),
          color: null,
          parentId: parentId ?? null,
          sortOrder: 0,
          count: 0,
          createdAt: at,
          updatedAt: at,
        },
      ]);
      return { pendingId };
    },
    onSuccess: (folder, _vars, { pendingId }) =>
      patchFolders((list) => list.map((f) => (f.id === pendingId ? folder : f))),
    onError: (error, _vars, context) => {
      if (context) patchFolders((list) => list.filter((f) => f.id !== context.pendingId));
      notifyError(errorMessage(error));
    },
    onSettled: () => void invalidateFolders(),
  });
}

export function useRenameFolder() {
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      requestJson<Folder>("PATCH", `/api/folders/${encodeURIComponent(id)}`, { name }),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: folderKeys.all });
      const previous = cachedFolders()?.find((f) => f.id === id)?.name;
      patchFolder(id, { name: name.trim() });
      return { previous };
    },
    onError: (error, { id }, context) => {
      if (context?.previous !== undefined) patchFolder(id, { name: context.previous });
      notifyError(errorMessage(error));
    },
    onSettled: () => void invalidateFolders(),
  });
}

/** What the server answers for a move into the folder itself, said without asking it. */
const insideItself = () =>
  new ApiError(
    409,
    "conflict",
    "A folder can't go inside itself",
    false,
    "parentId",
    t("assets.folder.insideItself"),
  );

/**
 * Move to the top level (parentId null) or into another folder. A move into the folder itself or
 * one of its subfolders is refused here and never sent (§2.8); a move to where it already is does
 * nothing. The server checks again and answers 409 conflict.
 */
export function useMoveFolder() {
  return useMutation({
    mutationFn: async ({ id, parentId }: { id: string; parentId: string | null }): Promise<Folder | null> => {
      await queryClient.cancelQueries({ queryKey: folderKeys.all });
      const list = cachedFolders();
      const before = list?.find((f) => f.id === id);
      if (list) {
        const target = moveTarget(buildFolderTree(list), id, parentId);
        if (target === "inside") throw insideItself();
        if (target === "current") return null;
      }
      // Shown at once; the check above ran on the tree as it was, before this change.
      patchFolder(id, { parentId });
      try {
        return await requestJson<Folder>("PATCH", `/api/folders/${encodeURIComponent(id)}`, { parentId });
      } catch (error) {
        if (before) patchFolder(id, { parentId: before.parentId });
        throw error;
      }
    },
    onError: (error) => notifyError(errorMessage(error)),
    onSettled: () => void invalidateFolders(),
  });
}

/**
 * Delete a folder and every folder inside it. The images stay in the library and in their other
 * folders (§0.7). Resolves to the deleted ids, so an open folder among them can close.
 */
export function useDeleteFolder() {
  return useMutation({
    mutationFn: (id: string) =>
      requestJson<FolderDeleteResponse>("DELETE", `/api/folders/${encodeURIComponent(id)}`),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: folderKeys.all });
      const list = cachedFolders() ?? [];
      const node = buildFolderTree(list).byId.get(id);
      const gone = new Set([id, ...(node ? folderDescendants(node).map((n) => n.folder.id) : [])]);
      const removed = list.filter((f) => gone.has(f.id));
      patchFolders((current) => current.filter((f) => !gone.has(f.id)));
      return { removed };
    },
    onError: (error, _id, context) => {
      if (context) {
        patchFolders((current) => [
          ...current,
          ...context.removed.filter((f) => !current.some((c) => c.id === f.id)),
        ]);
      }
      notifyError(errorMessage(error));
    },
    onSuccess: ({ deletedIds }) => {
      for (const id of deletedIds) queryClient.removeQueries({ queryKey: libraryKeys.list({ folder: id }) });
      // Any detail view's Folders row may have named one of them.
      void queryClient.invalidateQueries({ queryKey: libraryKeys.details });
      void invalidateMemberships();
    },
    onSettled: () => void invalidateFolders(),
  });
}

// Filing

/**
 * Add to folder: from the picker, the bars, the menus and drag and drop. One request however many
 * images; the ones already there are skipped, and `changed` lists what this call added, which is
 * what Undo takes out again (useRemoveFromFolder with those ids).
 */
export function useAddToFolder() {
  return useMutation({
    mutationFn: ({ ids, folderId }: { ids: readonly string[]; folderId: string }) =>
      bulk("addFolder", ids, folderId),
    onSuccess: ({ changed }, { folderId }) => {
      bumpCount(folderId, changed.length);
      void queryClient.invalidateQueries({ queryKey: libraryKeys.list({ folder: folderId }) });
      for (const id of changed) void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    },
    onError: (error) => notifyError(errorMessage(error)),
    onSettled: () => {
      void invalidateMemberships();
      void invalidateFolders();
    },
  });
}

/**
 * Remove from folder: out of this folder only, never the others (§0.7). The images leave the open
 * folder's grid and its count drops at once (AC-2.5.2).
 */
export function useRemoveFromFolder() {
  return useMutation({
    mutationFn: ({ ids, folderId }: { ids: readonly string[]; folderId: string }) =>
      bulk("removeFolder", ids, folderId),
    onMutate: ({ ids, folderId }) => {
      const snapshot = snapshotAssetCaches();
      const known = shownIn(folderId, ids);
      removeFromLists(libraryKeys.list({ folder: folderId }), ids);
      bumpCount(folderId, -known);
      return { snapshot, known };
    },
    onSuccess: ({ changed }, { folderId }, { known }) => {
      // The grid only knew about the images it had loaded; the server knows them all.
      bumpCount(folderId, known - changed.length);
      for (const id of changed) void queryClient.invalidateQueries({ queryKey: libraryKeys.detail(id) });
    },
    onError: (error, { folderId }, context) => {
      if (context) {
        restoreAssetCaches(context.snapshot);
        bumpCount(folderId, context.known);
      }
      notifyError(errorMessage(error));
    },
    onSettled: () => {
      void invalidateMemberships();
      void invalidateFolders();
    },
  });
}

/** How many of these images a loaded listing of the folder shows: members we know about. */
function shownIn(folderId: string, ids: readonly string[]): number {
  const wanted = new Set(ids);
  const seen = new Set<string>();
  for (const [, data] of queryClient.getQueriesData<{ pages: { items: { id: string }[] }[] }>({
    queryKey: libraryKeys.list({ folder: folderId }),
  })) {
    for (const page of data?.pages ?? [])
      for (const item of page.items) if (wanted.has(item.id)) seen.add(item.id);
  }
  return seen.size;
}

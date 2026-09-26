import {
  type FolderTree,
  folderDescendants,
  folderPath,
  type LibraryQuery,
  libraryHref,
  t,
} from "@openfield/core";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { create } from "zustand";
import {
  isPendingFolder,
  useCreateFolder,
  useDeleteFolder,
  useMoveFolder,
  useRenameFolder,
} from "../api/hooks/folders";
import { confirm } from "./confirm";
import { useLibraryPrefs } from "./prefs";
import { searchOf } from "./route";

// Folder operations with their words (§2.8): new, rename, move, delete, and opening one. The
// sidebar, the header, folder cards, menus and drag and drop all go through here.

/** The tree row in the Editing state: a new folder being named, or a rename. */
export type FolderEdit = { mode: "new"; parentId: string | null } | { mode: "rename"; folderId: string };

export const useFolderEdit = create<{ edit: FolderEdit | null }>()(() => ({ edit: null }));

export const startNewFolder = (parentId: string | null) => {
  if (parentId) useLibraryPrefs.getState().expand([parentId]);
  useFolderEdit.setState({ edit: { mode: "new", parentId } });
};

export const startRename = (folderId: string) => {
  if (isPendingFolder(folderId)) return;
  useFolderEdit.setState({ edit: { mode: "rename", folderId } });
};

export const stopEditing = () => useFolderEdit.setState({ edit: null });

export function useFolderActions(
  tree: FolderTree | undefined,
  openFolderId: string | undefined,
  query: LibraryQuery,
) {
  const navigate = useNavigate();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const moveFolder = useMoveFolder();
  const deleteFolder = useDeleteFolder();

  /**
   * Opens a folder and expands the tree down to it and one level into it (§2.8, design s5XLm).
   * Words and filters come along, as they do to All images and Favorites.
   */
  const open = useCallback(
    (folderId: string) => {
      if (isPendingFolder(folderId)) return;
      if (tree) {
        const path = folderPath(tree, folderId);
        useLibraryPrefs.getState().expand(path.map((node) => node.folder.id));
      }
      if (folderId !== openFolderId) navigate(libraryHref({ view: "folder", folderId, ...searchOf(query) }));
    },
    [navigate, tree, openFolderId, query],
  );

  /** Saves the row being edited. An empty name cancels, as Esc does. */
  const commit = useCallback(
    (edit: FolderEdit, name: string) => {
      stopEditing();
      const trimmed = name.trim();
      if (!trimmed) return;
      if (edit.mode === "new") {
        createFolder.mutate({ name: trimmed, parentId: edit.parentId });
        return;
      }
      const current = tree?.byId.get(edit.folderId)?.folder.name;
      if (current !== trimmed) renameFolder.mutate({ id: edit.folderId, name: trimmed });
    },
    [createFolder, renameFolder, tree],
  );

  const move = useCallback(
    (folderId: string, parentId: string | null) => {
      if (parentId) useLibraryPrefs.getState().expand([parentId]);
      moveFolder.mutate({ id: folderId, parentId });
    },
    [moveFolder],
  );

  /**
   * Delete folder asks first and says what happens to the folders inside it. If the open folder
   * goes, the view moves to the nearest folder that stays, or to All images.
   */
  const remove = useCallback(
    (folderId: string) => {
      const node = tree?.byId.get(folderId);
      if (!node || isPendingFolder(folderId)) return;
      const inside = folderDescendants(node).length;
      confirm({
        title: t("assets.folder.deleteDialog.title", { folder: node.folder.name }),
        body:
          inside > 0
            ? t("assets.folder.deleteDialog.bodyNested", { count: inside })
            : t("assets.folder.deleteDialog.body"),
        confirmLabel: t("assets.folder.deleteDialog.confirm"),
        onConfirm: () => {
          if (openFolderId && tree) {
            const openPath = folderPath(tree, openFolderId);
            if (openPath.some((n) => n.folder.id === folderId)) {
              const parent = node.parent?.folder.id;
              navigate(parent ? `/assets/folder/${parent}` : "/assets", { replace: true });
            }
          }
          deleteFolder.mutate(folderId);
        },
      });
    },
    [tree, openFolderId, navigate, deleteFolder],
  );

  return useMemo(() => ({ open, commit, move, remove }), [open, commit, move, remove]);
}

export type FolderActions = ReturnType<typeof useFolderActions>;

import { type AssetListItem, type Folder, t } from "@openfield/core";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { useAddToFolder, useRemoveFromFolder } from "../api/hooks/folders";
import { useRecreateJobSet } from "../api/hooks/job-sets";
import {
  downloadZip,
  useEmptyTrash,
  usePurgeAssets,
  useRestoreAssets,
  useSetFavourite,
  useTrashAssets,
} from "../api/hooks/library";
import { useSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { downloadOriginal } from "../detail/actions";
import { useReuse } from "../image/composer/use-reuse";
import { notify, notifyError } from "../lib/notify";
import { confirm } from "./confirm";
import { useSelection } from "./selection";

// Every library action with its words: the confirmations, the toasts and their Undo (§2.5, §2.8).
// Cards, menus, the selection bar, drag and drop and the keyboard all call these, so the same
// action reads the same everywhere.

const UNDO_MS = 8000;

export function useLibraryActions() {
  const navigate = useNavigate();
  const settings = useSettings();
  const setFavourite = useSetFavourite();
  const trashAssets = useTrashAssets();
  const restoreAssets = useRestoreAssets();
  const purgeAssets = usePurgeAssets();
  const emptyTrashMutation = useEmptyTrash();
  const addToFolderMutation = useAddToFolder();
  const removeFromFolderMutation = useRemoveFromFolder();
  const recreateJobSet = useRecreateJobSet();
  const reuseRun = useReuse();
  const retention = settings.data?.trashRetentionDays ?? null;

  const favourite = useCallback(
    (ids: readonly string[], on: boolean) => {
      if (ids.length) setFavourite.mutate({ ids, on });
    },
    [setFavourite],
  );

  const restore = useCallback(
    (ids: readonly string[], opts: { quiet?: boolean } = {}) => {
      if (!ids.length) return;
      // Restored images leave the Trash, so they leave its selection too.
      useSelection.getState().drop(ids);
      restoreAssets.mutate(
        { ids },
        {
          onSuccess: ({ changed }) => {
            if (!opts.quiet)
              notify(t("assets.toast.restored", { count: changed.length }), { tone: "success" });
          },
        },
      );
    },
    [restoreAssets],
  );

  /** Delete: asks first, then to the Trash with an Undo toast. */
  const trash = useCallback(
    (ids: readonly string[], onDone?: () => void) => {
      if (!ids.length) return;
      const count = ids.length;
      confirm({
        title: t("feed.delete.title", { count }),
        body:
          retention === null
            ? t("feed.delete.body", { count })
            : t("feed.delete.bodyDays", { count, days: retention }),
        confirmLabel: t("feed.delete.confirm"),
        onConfirm: () => {
          useSelection.getState().drop(ids);
          onDone?.();
          trashAssets.mutate(
            { ids },
            {
              onSuccess: ({ changed }) =>
                notify(t("feed.delete.done", { count: changed.length }), {
                  duration: UNDO_MS,
                  action: { label: t("actions.undo"), onClick: () => restore(changed, { quiet: true }) },
                }),
            },
          );
        },
      });
    },
    [retention, trashAssets, restore],
  );

  /** Delete for good, from the Trash. Asks first; there's no Undo. */
  const purge = useCallback(
    (ids: readonly string[], onDone?: () => void) => {
      if (!ids.length) return;
      const count = ids.length;
      confirm({
        title: t("assets.dialogs.deleteForGood.title", { count }),
        body: t("assets.dialogs.deleteForGood.body", { count }),
        confirmLabel: t("assets.dialogs.deleteForGood.confirm"),
        onConfirm: () => {
          useSelection.getState().drop(ids);
          onDone?.();
          purgeAssets.mutate(
            { ids },
            {
              onSuccess: ({ changed }) =>
                notify(t("assets.toast.deletedForGood", { count: changed.length }), { tone: "success" }),
            },
          );
        },
      });
    },
    [purgeAssets],
  );

  const emptyTrash = useCallback(
    (count: number) => {
      confirm({
        title: t("assets.dialogs.emptyTrash.title"),
        body: t("assets.dialogs.emptyTrash.body", { count }),
        confirmLabel: t("assets.dialogs.emptyTrash.confirm"),
        onConfirm: () => {
          useSelection.getState().clear();
          emptyTrashMutation.mutate(undefined, {
            onSuccess: () => notify(t("assets.toast.trashEmptied"), { tone: "success" }),
          });
        },
      });
    },
    [emptyTrashMutation],
  );

  /** Files images into a folder, keeping their other folders, with an Undo that takes out only what this added. */
  const addToFolder = useCallback(
    (ids: readonly string[], folder: Pick<Folder, "id" | "name">, opts: { toast?: boolean } = {}) => {
      if (!ids.length) return;
      addToFolderMutation.mutate(
        { ids, folderId: folder.id },
        {
          onSuccess: ({ changed }) => {
            if (opts.toast === false) return;
            if (changed.length === 0) {
              notify(t("assets.toast.alreadyIn", { count: ids.length, folder: folder.name }));
              return;
            }
            notify(t("assets.toast.added", { count: changed.length, folder: folder.name }), {
              duration: UNDO_MS,
              action: {
                label: t("actions.undo"),
                onClick: () => removeFromFolderMutation.mutate({ ids: changed, folderId: folder.id }),
              },
            });
          },
        },
      );
    },
    [addToFolderMutation, removeFromFolderMutation],
  );

  /** Takes images out of this one folder; they stay in the library and in their other folders. */
  const removeFromFolder = useCallback(
    (ids: readonly string[], folder: Pick<Folder, "id" | "name">, opts: { toast?: boolean } = {}) => {
      if (!ids.length) return;
      removeFromFolderMutation.mutate(
        { ids, folderId: folder.id },
        {
          onSuccess: ({ changed }) => {
            if (opts.toast === false || changed.length === 0) return;
            notify(t("assets.toast.removed", { count: changed.length, folder: folder.name }), {
              duration: UNDO_MS,
              action: {
                label: t("actions.undo"),
                onClick: () => addToFolderMutation.mutate({ ids: changed, folderId: folder.id }),
              },
            });
          },
        },
      );
    },
    [addToFolderMutation, removeFromFolderMutation],
  );

  /** One image downloads as its original file; several as a zip. */
  const download = useCallback(async (items: readonly AssetListItem[]) => {
    if (!items.length) return;
    try {
      if (items.length === 1) await downloadOriginal(items[0]!);
      else {
        notify(t("assets.toast.preparingDownload", { count: items.length }));
        await downloadZip(items.map((item) => item.id));
      }
    } catch (error) {
      notifyError(errorMessage(error));
    }
  }, []);

  const copyPrompt = useCallback(async (item: AssetListItem) => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      notify(t("toast.copied"), { tone: "success" });
    } catch (error) {
      notifyError(errorMessage(error));
    }
  }, []);

  /** Reuse (§0.1): the prompt and model go into the composer on the Image page. Nothing runs. */
  const reuse = useCallback(
    (item: AssetListItem) => {
      navigate("/image");
      const model = item.providerId && item.modelId ? `${item.providerId}:${item.modelId}` : "";
      // After the Image page mounts, so the composer is there to take focus.
      requestAnimationFrame(() => reuseRun({ prompt: item.prompt, model }));
    },
    [navigate, reuseRun],
  );

  /** Recreate replays the run that made it; the new images land in the feed and All images. */
  const recreate = useCallback(
    (item: AssetListItem) => {
      if (!item.jobSetId) return;
      recreateJobSet.mutate(item.jobSetId, {
        onSuccess: (set) =>
          notify(t("assets.toast.recreating", { count: set.jobs.length }), {
            action: { label: t("actions.show"), onClick: () => navigate("/image") },
          }),
        onError: (error) => notifyError(errorMessage(error)),
      });
    },
    [recreateJobSet, navigate],
  );

  return useMemo(
    () => ({
      favourite,
      trash,
      restore,
      purge,
      emptyTrash,
      addToFolder,
      removeFromFolder,
      download,
      copyPrompt,
      reuse,
      recreate,
    }),
    [
      favourite,
      trash,
      restore,
      purge,
      emptyTrash,
      addToFolder,
      removeFromFolder,
      download,
      copyPrompt,
      reuse,
      recreate,
    ],
  );
}

export type LibraryActions = ReturnType<typeof useLibraryActions>;

import { type AssetListItem, libraryHref, moveTarget, t } from "@openfield/core";
import { Button, EmptyStateInline, Spinner } from "@openfield/ui";
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { AssetPages } from "../api/hooks/assets";
import { isPendingFolder } from "../api/hooks/folders";
import { libraryItems, libraryTotal, useLibrary, useLibrarySummary } from "../api/hooks/library";
import { useSettings } from "../api/hooks/settings";
import { errorMessage } from "../api/raw";
import { DetailView, useDetail, useOpenDetail } from "../detail";
import { notify } from "../lib/notify";
import { useLibraryActions } from "./actions";
import { ConfirmHost } from "./confirm";
import { DragLayer, type DragRules, useDragStore } from "./drag";
import { LibraryEmpty } from "./empty";
import { FilterRow } from "./filters";
import { startNewFolder, useFolderActions } from "./folder-actions";
import { FolderMenuHost } from "./folder-menu";
import { LibraryGrid, type LoadMoreResult } from "./grid";
import { LibraryHeader } from "./header";
import { COLUMNS_BY_ZOOM } from "./layout";
import { useLibraryPrefs } from "./prefs";
import { isFiltered, useLibraryRoute } from "./route";
import { useSelection } from "./selection";
import { SelectionBar } from "./selection-bar";
import { focusLibrarySearch, LibrarySidebar } from "./sidebar";
import { useLibraryTree } from "./tree";

// /assets, /assets/favourites, /assets/trash and /assets/folder/:id (§2.8, design Q1RlD, s5XLm,
// axD2H, nvzy5): the sidebar, then the view's header, its filters and the grid. Clicking an image
// opens the detail view over it.

export function AssetsPage() {
  const route = useLibraryRoute();
  const { view, folderId, query } = route;
  const tree = useLibraryTree();
  const summary = useLibrarySummary();
  const settings = useSettings();
  const library = useLibrary(query);
  // useLibrary's pages carry the cursor as their param, which its inferred type loses.
  const pages = library.data as AssetPages | undefined;
  const items = useMemo(() => libraryItems(pages), [pages]);
  const total = libraryTotal(pages);
  const actions = useLibraryActions();
  const folderActions = useFolderActions(tree.data, folderId, query);
  const { assetId } = useDetail();
  const openDetail = useOpenDetail();
  const zoom = useLibraryPrefs((s) => s.zoom);
  const setZoom = useLibraryPrefs((s) => s.setZoom);
  const [filtersWanted, setFiltersWanted] = useState(false);

  const folderNode = folderId ? tree.data?.byId.get(folderId) : undefined;
  const folder = useMemo(
    () => (folderNode ? { id: folderNode.folder.id, name: folderNode.folder.name } : undefined),
    [folderNode],
  );
  const filtered = isFiltered(query);
  // The filter row opens with the Filter button, and by itself while anything is searched (§2.8).
  const filtersOpen = view !== "trash" && (filtersWanted || filtered);
  const viewKey = view === "folder" ? `folder:${folderId}` : view;

  // Moving to another view clears the selection; search, filters and zoom keep it (§2.5).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the view changes, nothing else.
  useEffect(() => {
    useSelection.getState().clear();
  }, [viewKey]);

  // The bar and the ghost keep copies of selected images: keep them in step with the lists.
  useEffect(() => {
    useSelection.getState().refresh(items);
  }, [items]);

  useUnknownFolder(view === "folder" ? folderId : undefined, tree);

  // Drag and drop: what may land where (§2.8).
  useEffect(() => {
    const byId = tree.data?.byId;
    const rules: DragRules = {
      judge: (payload, target) => {
        if (payload.kind === "images") {
          return target.type === "folder" && !isPendingFolder(target.id) ? "allowed" : "none";
        }
        const parentId = target.type === "top" ? null : target.id;
        if (parentId && payload.subtree.has(parentId)) return "blocked";
        if (!tree.data || (parentId && !byId?.has(parentId))) return "none";
        return moveTarget(tree.data, payload.folderId, parentId) === "allowed" ? "allowed" : "none";
      },
      drop: (payload, target) => {
        if (payload.kind === "images") {
          if (target.type === "folder")
            actions.addToFolder(payload.ids, { id: target.id, name: target.name });
          return;
        }
        folderActions.move(payload.folderId, target.type === "top" ? null : target.id);
      },
      expand: (id) => useLibraryPrefs.getState().expand([id]),
    };
    useDragStore.setState({ rules });
    return () => useDragStore.setState({ rules: null });
  }, [tree.data, actions, folderActions]);

  const counts = summary.data?.counts;
  const count = filtered
    ? total
    : view === "all"
      ? counts?.all
      : view === "favourites"
        ? counts?.favourites
        : view === "trash"
          ? counts?.trash
          : folderNode?.folder.count;
  const retention = settings.data?.trashRetentionDays ?? null;

  const loadMore = useCallback(async (): Promise<LoadMoreResult> => {
    // Joins a page already on its way rather than starting it again.
    const result = await library.fetchNextPage({ cancelRefetch: false });
    return { items: libraryItems(result.data as AssetPages | undefined), hasMore: result.hasNextPage };
  }, [library.fetchNextPage]);

  const title =
    view === "trash"
      ? t("assets.views.trash")
      : view === "favourites"
        ? t("assets.views.favorites")
        : view === "folder"
          ? (folder?.name ?? "")
          : t("assets.views.all");

  usePageKeys({ view, folderId, items, zoom, setZoom, detailOpen: assetId !== null });

  const subfolders = view === "folder" && !query.q && folderNode ? folderNode.children : [];

  return (
    <div className="flex min-h-0 flex-1">
      <LibrarySidebar route={route} tree={tree.data} actions={folderActions} />
      <section aria-label={title} className="relative ml-px flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col px-25">
          <LibraryHeader
            query={query}
            tree={tree.data}
            count={count}
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersWanted(!filtersOpen)}
            zoom={zoom}
            onZoom={setZoom}
            trashNote={
              retention === null
                ? t("assets.header.trashNote")
                : t("assets.header.trashNoteDays", { days: retention })
            }
            onEmptyTrash={() => actions.emptyTrash(counts?.trash ?? total ?? 0)}
            onOpenFolder={folderActions.open}
          />
          {filtersOpen ? <FilterRow route={route} tree={tree.data} summary={summary.data} /> : null}
        </div>
        {library.isPending ? (
          <div className="flex flex-1 items-center justify-center pb-104 text-text-tertiary">
            <Spinner size={18} label={t("app.loading")} />
          </div>
        ) : library.isError && items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center pb-104">
            <EmptyStateInline
              icon={CircleAlert}
              title={errorMessage(library.error)}
              actions={
                <Button variant="ghost" size="s" onClick={() => void library.refetch()}>
                  {t("actions.tryAgain")}
                </Button>
              }
            />
          </div>
        ) : (
          <LibraryGrid
            // A new view or a new search starts at the top.
            key={libraryHref(query)}
            label={title}
            items={items}
            subfolders={subfolders}
            total={total}
            hasMore={library.hasNextPage}
            loadingMore={library.isFetchingNextPage}
            loadMore={loadMore}
            zoom={zoom}
            trash={view === "trash"}
            folder={folder}
            actions={actions}
            activeId={assetId}
            onOpen={openDetail}
            onOpenFolder={folderActions.open}
            empty={<LibraryEmpty route={route} folderName={folder?.name} />}
          />
        )}
        <SelectionBar view={view} folder={folder} actions={actions} />
      </section>
      <FolderMenuHost tree={tree.data} actions={folderActions} />
      <ConfirmHost />
      <DragLayer />
      <DetailView
        items={items}
        query={query}
        hasMore={library.hasNextPage}
        loadingMore={library.isFetchingNextPage}
        onLoadMore={() => void loadMore()}
        loading={library.isPending}
      />
    </div>
  );
}

/**
 * An unknown or deleted folder in the address bar lands on All images with a note (§2.1). The tree
 * is fetched once more first, in case the folder is newer than the list.
 */
function useUnknownFolder(folderId: string | undefined, tree: ReturnType<typeof useLibraryTree>) {
  const navigate = useNavigate();
  const checked = useRef<string | null>(null);
  const known = folderId ? tree.data?.byId.has(folderId) : true;
  const { isFetching, refetch } = tree;
  const ready = tree.data !== undefined;

  useEffect(() => {
    if (!folderId || !ready || known || isFetching) return;
    if (checked.current !== folderId) {
      checked.current = folderId;
      void refetch();
      return;
    }
    notify(t("assets.folder.gone"));
    navigate("/assets", { replace: true });
  }, [folderId, ready, known, isFetching, refetch, navigate]);
}

/**
 * The library's keys outside the grid (§2.6): ⌘/Ctrl+F searches, ⌘/Ctrl+Shift+N makes a folder,
 * ⌘/Ctrl+A selects what's shown, Esc clears the selection, 1 to 5 and − / = set the zoom.
 */
function usePageKeys({
  view,
  folderId,
  items,
  zoom,
  setZoom,
  detailOpen,
}: {
  view: string;
  folderId: string | undefined;
  items: readonly AssetListItem[];
  zoom: number;
  setZoom: (zoom: number) => void;
  detailOpen: boolean;
}) {
  const latest = useRef({ view, folderId, items, zoom, setZoom, detailOpen });
  latest.current = { view, folderId, items, zoom, setZoom, detailOpen };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current;
      // A dialog, a menu or the detail view handled it, or owns the keys while it's open.
      if (event.defaultPrevented || now.detailOpen) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && !event.shiftKey && key === "f") {
        event.preventDefault();
        focusLibrarySearch();
        return;
      }
      if (mod && event.shiftKey && key === "n") {
        event.preventDefault();
        startNewFolder(now.view === "folder" ? (now.folderId ?? null) : null);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable='true']")) return;
      if (event.key === "Escape") {
        if (useSelection.getState().ids.size === 0) return;
        event.preventDefault();
        useSelection.getState().clear();
        return;
      }
      if (mod && key === "a") {
        event.preventDefault();
        useSelection.getState().set(now.items, true, now.items.at(-1)?.id ?? null);
        return;
      }
      if (mod || event.altKey) return;
      const max = COLUMNS_BY_ZOOM.length - 1;
      if (/^[1-5]$/.test(event.key)) {
        event.preventDefault();
        now.setZoom(Math.min(max, Number(event.key) - 1));
      } else if (event.key === "-") {
        event.preventDefault();
        now.setZoom(Math.max(0, now.zoom - 1));
      } else if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        now.setZoom(Math.min(max, now.zoom + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

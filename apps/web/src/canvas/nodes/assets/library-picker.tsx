import type { AssetDetailResponse, AssetListItem } from "@openfield/core";
import { t } from "@openfield/core";
import {
  Button,
  cn,
  IconButton,
  Modal,
  ModalClose,
  ModalSurface,
  ModalTitle,
  SearchInput,
} from "@openfield/ui";
import { useQueries } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, call } from "../../../api/client";
import type { AssetPages } from "../../../api/hooks/assets";
import { libraryItems, libraryKeys, useLibrary, useLibrarySummary } from "../../../api/hooks/library";
import { useLibraryTree } from "../../../assets/tree";
import { AssetImage } from "../shell/thumb";
import { FAVOURITES_PLACE, movePick, type Place, placeQuery, togglePick } from "./picker-order";
import { OrderBadge, PickerPicked } from "./picker-picked";
import { PickerPlaces } from "./picker-places";

// The library picker for the Assets node (§7.5, design q31cb): Favorites, All images and the
// folder tree on the left; that place's library, searchable, in the middle; the pick, in order,
// on the right. Picking again starts from what the node already has, so Change keeps what you keep.

export interface LibraryPickerProps {
  open: boolean;
  initial: readonly string[];
  onOpenChange: (open: boolean) => void;
  onPick: (assetIds: string[]) => void;
}

/** Places, other than a folder, one lookup handles by name. */
function placeTitle(place: Place, folderName: string | undefined): string {
  if (place.kind === "favourites") return t("canvas.nodes.picker.places.favorites");
  if (place.kind === "all") return t("canvas.nodes.picker.places.allImages");
  return folderName ?? "";
}

/**
 * Every picked asset's prompt, for the Picked panel's second line: from whatever place the grid has
 * already shown it in, or - a pick the node already had, that the grid hasn't shown yet - its own
 * fetch. `GET /api/assets` has no "these exact ids" query, so each of those is its own request.
 */
function useAssetsByIds(ids: readonly string[]): ReadonlyMap<string, Pick<AssetListItem, "prompt">> {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: libraryKeys.detail(id),
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        call(api.api.assets[":id"].$get({ param: { id } }, { init: { signal } })),
      staleTime: 60_000,
    })),
  });
  return useMemo(() => {
    const map = new Map<string, Pick<AssetListItem, "prompt">>();
    results.forEach((result, i) => {
      const data = result.data as AssetDetailResponse | undefined;
      if (data) map.set(ids[i]!, { prompt: data.asset.prompt });
    });
    return map;
  }, [results, ids]);
}

export function LibraryPicker({ open, initial, onOpenChange, onPick }: LibraryPickerProps) {
  const [place, setPlace] = useState<Place>(FAVOURITES_PLACE);
  const [picked, setPicked] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  // Opening starts fresh: Favorites, no search, what the node already has (current behaviour).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only `open`'s edge matters here.
  useEffect(() => {
    if (!open) return;
    setPlace(FAVOURITES_PLACE);
    setSearch("");
    setQuery("");
    setPicked([...initial]);
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const summary = useLibrarySummary();
  const tree = useLibraryTree();
  // The Assets node only ever holds images (§0.16): videos aren't offered here.
  const library = useLibrary({ ...placeQuery(place, query), modality: "image" }, { enabled: open });
  const items = libraryItems(library.data as AssetPages | undefined);
  const pickedAssets = useAssetsByIds(open ? picked : []);

  const folderName = place.kind === "folder" ? tree.data?.byId.get(place.folderId)?.folder.name : undefined;
  const toggle = (asset: AssetListItem) => setPicked((ids) => togglePick(ids, asset.id));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalSurface
        aria-describedby={undefined}
        className="h-720 max-h-[calc(100vh-48px)] w-1120 max-w-[calc(100vw-32px)]"
      >
        <div className="flex h-64 w-full shrink-0 items-center justify-between border-b border-border py-18 pr-20 pl-24">
          <ModalTitle>{t("canvas.nodes.picker.title")}</ModalTitle>
          <ModalClose asChild>
            <IconButton icon={X} label={t("actions.close")} />
          </ModalClose>
        </div>
        <div className="flex min-h-0 w-full flex-1">
          <PickerPlaces
            place={place}
            onPlace={setPlace}
            favouritesCount={summary.data?.counts.favourites ?? 0}
            allCount={summary.data?.counts.all ?? 0}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-14 p-20">
            <div className="flex w-full shrink-0 items-center gap-12">
              <span className="text-body-strong text-text-primary">{placeTitle(place, folderName)}</span>
              <SearchInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("canvas.nodes.picker.search")}
                aria-label={t("canvas.nodes.picker.search")}
                className="flex-1"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {library.isError ? (
                <p className="py-24 text-center text-small text-text-secondary">
                  {t("canvas.nodes.picker.loadFailed")}
                </p>
              ) : items.length === 0 && !library.isPending ? (
                <p className="py-24 text-center text-small text-text-secondary">
                  {query
                    ? t("canvas.nodes.picker.noMatches", { query })
                    : place.kind === "favourites"
                      ? t("canvas.nodes.picker.places.favoritesEmpty")
                      : t("canvas.nodes.picker.empty")}
                </p>
              ) : (
                <ul className="grid grid-cols-4 gap-8">
                  {items.map((asset) => {
                    const order = picked.indexOf(asset.id);
                    const selected = order >= 0;
                    return (
                      <li key={asset.id}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={asset.prompt.trim() || t("canvas.nodes.picker.select")}
                          onClick={() => toggle(asset)}
                          className={cn(
                            "relative block h-132 w-full cursor-pointer overflow-hidden rounded-10 inset-ring inset-ring-border",
                            selected && "inset-ring-2 inset-ring-accent",
                          )}
                        >
                          <AssetImage assetId={asset.id} height={132} className="absolute inset-0" />
                          {selected ? <OrderBadge index={order} /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {library.hasNextPage ? (
                <div className="flex justify-center py-12">
                  <Button
                    variant="secondary"
                    size="s"
                    loading={library.isFetchingNextPage}
                    onClick={() => void library.fetchNextPage()}
                  >
                    {t("canvas.nodes.picker.loadMore")}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          <PickerPicked
            ids={picked}
            assets={pickedAssets}
            onRemove={(id) => setPicked((ids) => ids.filter((x) => x !== id))}
            onMove={(id, to) => setPicked((ids) => movePick(ids, id, to))}
            onClear={() => setPicked([])}
          />
        </div>
        <div className="flex h-68 w-full shrink-0 items-center justify-end gap-8 border-t border-border py-14 pr-20 pl-24">
          <Button variant="ghost" size="m" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="m"
            disabled={picked.length === 0}
            onClick={() => {
              onPick(picked);
              onOpenChange(false);
            }}
          >
            {t("canvas.nodes.picker.add", { count: picked.length })}
          </Button>
        </div>
      </ModalSurface>
    </Modal>
  );
}

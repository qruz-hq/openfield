import { type AssetListItem, t } from "@openfield/core";
import { Button, CheckBadge, cn, Modal, ModalContent, ModalFooter, SearchInput } from "@openfield/ui";
import { useEffect, useState } from "react";
import { useAssets } from "../../../api/hooks/assets";
import { AssetImage } from "../shell/thumb";

// The library picker for the Assets node (§7.5): the library, newest first, searchable, picked in
// order. Picking again starts from what the node already has, so Change keeps what you keep.

export interface LibraryPickerProps {
  open: boolean;
  initial: readonly string[];
  onOpenChange: (open: boolean) => void;
  onPick: (assetIds: string[]) => void;
}

export function LibraryPicker({ open, initial, onOpenChange, onPick }: LibraryPickerProps) {
  const [picked, setPicked] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const library = useAssets("all", { q: query, enabled: open });

  useEffect(() => {
    if (open) setPicked([...initial]);
  }, [open, initial]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const items: AssetListItem[] = library.data?.pages.flatMap((p) => p.items) ?? [];
  const toggle = (id: string) =>
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        title={t("canvas.nodes.picker.title")}
        closeLabel={t("actions.close")}
        aria-describedby={undefined}
        className="w-720 max-w-[calc(100vw-32px)]"
      >
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("canvas.nodes.picker.search")}
          aria-label={t("canvas.nodes.picker.search")}
        />
        <div className="h-420 overflow-y-auto">
          {library.isError ? (
            <p className="py-24 text-center text-small text-text-secondary">
              {t("canvas.nodes.picker.loadFailed")}
            </p>
          ) : items.length === 0 && !library.isPending ? (
            <p className="py-24 text-center text-small text-text-secondary">
              {query ? t("canvas.nodes.picker.noMatches", { query }) : t("canvas.nodes.picker.empty")}
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
                      onClick={() => toggle(asset.id)}
                      className={cn(
                        "relative block aspect-square w-full cursor-pointer overflow-hidden rounded-10 inset-ring inset-ring-border",
                        selected && "inset-ring-2 inset-ring-accent",
                      )}
                    >
                      <AssetImage assetId={asset.id} height={200} className="absolute inset-0" />
                      {selected ? (
                        <span className="absolute top-6 left-6">
                          <CheckBadge />
                        </span>
                      ) : null}
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
        <ModalFooter>
          <Button variant="ghost" size="s" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="s"
            disabled={picked.length === 0}
            onClick={() => {
              onPick(picked);
              onOpenChange(false);
            }}
          >
            {t("canvas.nodes.picker.add", { count: picked.length })}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

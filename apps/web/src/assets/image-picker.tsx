import { type AssetListItem, assetThumbUrl, t } from "@openfield/core";
import {
  Button,
  CheckBadge,
  cn,
  Modal,
  ModalClose,
  ModalContent,
  ModalFooter,
  SearchInput,
  Spinner,
} from "@openfield/ui";
import { useEffect, useState } from "react";
import { useAssets } from "../api/hooks/assets";
import { useAuthedImage } from "../api/hooks/images";

// "Choose from library" for the page composers: a video's start or end frame (one image, picked
// on click) and the image composer's references (several, then Add). Images only (§0.16). Not the
// canvas Assets picker (library-picker.tsx): that one reads the canvas store for missing-asset
// ghosts, which these plain pages don't have.

export interface ImagePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** How many can be picked. 1 picks on click and closes; more lets the person tick, then Add. */
  max?: number;
  onPick: (assetIds: string[]) => void;
}

export function ImagePicker({ open, onOpenChange, title, max = 1, onPick }: ImagePickerProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const library = useAssets("all", { q: query, enabled: open, modality: "image" });
  const multiple = max > 1;

  useEffect(() => {
    if (open) return;
    setSearch("");
    setPicked([]);
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const items: AssetListItem[] = library.data?.pages.flatMap((p) => p.items) ?? [];

  const choose = (assetId: string) => {
    if (!multiple) {
      onPick([assetId]);
      onOpenChange(false);
      return;
    }
    setPicked((now) =>
      now.includes(assetId) ? now.filter((id) => id !== assetId) : now.length < max ? [...now, assetId] : now,
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        title={title}
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
                const on = picked.includes(asset.id);
                return (
                  <li key={asset.id}>
                    <ImageOption
                      asset={asset}
                      selected={multiple ? on : undefined}
                      disabled={multiple && !on && picked.length >= max}
                      onPick={() => choose(asset.id)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {library.isPending ? (
            <div className="flex justify-center py-24">
              <Spinner size={18} label={t("app.loading")} className="text-text-tertiary" />
            </div>
          ) : null}
          {library.hasNextPage ? (
            <div className="flex justify-center py-12">
              <button
                type="button"
                onClick={() => void library.fetchNextPage()}
                className="cursor-pointer text-small text-text-secondary hover:text-text-primary"
              >
                {t("canvas.nodes.picker.loadMore")}
              </button>
            </div>
          ) : null}
        </div>
        {multiple ? (
          <ModalFooter>
            <ModalClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </ModalClose>
            <Button
              variant="primary"
              disabled={!picked.length}
              onClick={() => {
                onPick(picked);
                onOpenChange(false);
              }}
            >
              {t("assets.imagePicker.add", { count: picked.length })}
            </Button>
          </ModalFooter>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function ImageOption({
  asset,
  selected,
  disabled = false,
  onPick,
}: {
  asset: AssetListItem;
  /** Undefined when picking one: there is nothing to tick. */
  selected?: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  const image = useAuthedImage(asset.thumbUrl || assetThumbUrl(asset.id, { h: 200 }));
  return (
    <button
      type="button"
      aria-label={asset.prompt.trim() || t("canvas.nodes.picker.select")}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "relative block aspect-square w-full cursor-pointer overflow-hidden rounded-10 bg-elevated-2 inset-ring transition-shadow disabled:cursor-default disabled:opacity-40",
        selected
          ? "inset-ring-2 inset-ring-accent"
          : "inset-ring-border enabled:hover:inset-ring-border-strong",
      )}
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : null}
      {selected ? <CheckBadge aria-hidden className="absolute top-8 right-8" /> : null}
    </button>
  );
}

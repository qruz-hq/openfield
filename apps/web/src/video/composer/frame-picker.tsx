import { type AssetListItem, assetThumbUrl, t } from "@openfield/core";
import { Modal, ModalContent, SearchInput, Spinner } from "@openfield/ui";
import { useEffect, useState } from "react";
import { useAssets } from "../../api/hooks/assets";
import { useAuthedImage } from "../../api/hooks/images";

// The start/end frame's "Choose from library" dialog: single pick, images only (§0.16). Not the
// canvas Assets picker (library-picker.tsx): that one reads the canvas store for missing-asset
// ghosts, which this plain page doesn't have.

export interface FramePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (assetId: string) => void;
}

export function FramePicker({ open, onOpenChange, onPick }: FramePickerProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const library = useAssets("all", { q: query, enabled: open, modality: "image" });

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const items: AssetListItem[] = library.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        title={t("video.frames.pickerTitle")}
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
              {items.map((asset) => (
                <li key={asset.id}>
                  <FrameOption
                    asset={asset}
                    onPick={() => {
                      onPick(asset.id);
                      onOpenChange(false);
                    }}
                  />
                </li>
              ))}
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
      </ModalContent>
    </Modal>
  );
}

function FrameOption({ asset, onPick }: { asset: AssetListItem; onPick: () => void }) {
  const image = useAuthedImage(asset.thumbUrl || assetThumbUrl(asset.id, { h: 200 }));
  return (
    <button
      type="button"
      aria-label={asset.prompt.trim() || t("canvas.nodes.picker.select")}
      onClick={onPick}
      className="relative block aspect-square w-full cursor-pointer overflow-hidden rounded-10 bg-elevated-2 inset-ring inset-ring-border transition-shadow hover:inset-ring-border-strong"
    >
      {image.status === "ready" ? (
        <img src={image.src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
      ) : null}
    </button>
  );
}

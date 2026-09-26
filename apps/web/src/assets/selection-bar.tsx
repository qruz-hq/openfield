import { type LibraryView, t } from "@openfield/core";
import { Button, Divider, IconButton, Surface } from "@openfield/ui";
import { Download, FolderInput, FolderMinus, Heart, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { LibraryActions } from "./actions";
import { AddToFolderPopover } from "./add-to-folder";
import { useSelection } from "./selection";
import "./assets.css";

// Surface / Selection bar, / In folder and / Trash (design tpb2H, TXVFO, errFg): the count, what
// can be done to the selection in this view, and Clear. 16 above the bottom of the grid (§2.5).

export function SelectionBar({
  view,
  folder,
  actions,
}: {
  view: LibraryView;
  folder: { id: string; name: string } | undefined;
  actions: LibraryActions;
}) {
  const ids = useSelection((s) => s.ids);
  const kept = useSelection((s) => s.items);
  const clear = useSelection((s) => s.clear);
  const [filing, setFiling] = useState(false);
  const shown = ids.size > 0;

  // Lifts the toasts above the bar while it's up (assets.css).
  useEffect(() => {
    if (!shown) return;
    document.documentElement.dataset.libraryBar = "";
    return () => {
      delete document.documentElement.dataset.libraryBar;
    };
  }, [shown]);

  if (!shown) return null;

  const list = [...ids];
  const items = list.map((id) => kept.get(id)).filter((item) => item !== undefined);
  const allFavourite = items.length > 0 && items.every((item) => item.isFavourite);

  return (
    <Surface
      variant="floating-bar"
      role="toolbar"
      aria-label={t("assets.selection.label")}
      className="absolute bottom-16 left-1/2 z-20 w-max max-w-[calc(100%-32px)] -translate-x-1/2 transition-[opacity,translate] duration-160 ease-out starting:translate-y-8 starting:opacity-0"
    >
      <span className="shrink-0 text-body-strong whitespace-nowrap text-text-primary" aria-live="polite">
        {t("assets.selection.count", { count: ids.size })}
      </span>
      <Divider orientation="vertical" />
      {view === "trash" ? (
        <div className="flex items-center gap-8">
          <Button variant="secondary" size="m" icon={RotateCcw} onClick={() => actions.restore(list)}>
            {t("assets.selection.restore")}
          </Button>
          <Button variant="danger-ghost" size="m" onClick={() => actions.purge(list)}>
            {t("assets.selection.deleteForGood")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-8">
          <Button variant="secondary" size="m" icon={Download} onClick={() => void actions.download(items)}>
            {t("assets.selection.download")}
          </Button>
          <AddToFolderPopover ids={list} open={filing} onOpenChange={setFiling} side="top" sideOffset={16}>
            <Button variant="secondary" size="m" icon={FolderInput}>
              {t("assets.selection.addToFolder")}
            </Button>
          </AddToFolderPopover>
          {view === "folder" && folder ? (
            <Button
              variant="secondary"
              size="m"
              icon={FolderMinus}
              onClick={() => {
                useSelection.getState().drop(list);
                actions.removeFromFolder(list, folder);
              }}
            >
              {t("assets.selection.removeFromFolder")}
            </Button>
          ) : null}
          <IconButton
            variant="secondary"
            size={40}
            icon={Heart}
            label={allFavourite ? t("assets.selection.unfavorite") : t("assets.selection.favorite")}
            aria-pressed={allFavourite}
            className={allFavourite ? "text-accent [&>svg]:fill-current" : undefined}
            onClick={() => actions.favourite(list, !allFavourite)}
          />
          <IconButton
            variant="secondary"
            size={40}
            icon={Trash2}
            tone="danger"
            label={t("assets.selection.delete")}
            onClick={() => actions.trash(list)}
          />
        </div>
      )}
      <Divider orientation="vertical" />
      <IconButton size={40} icon={X} label={t("assets.selection.clear")} onClick={clear} />
    </Surface>
  );
}

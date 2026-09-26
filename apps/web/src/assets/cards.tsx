import { type AssetListItem, type FolderNode, formatDate, formatNumber, t } from "@openfield/core";
import {
  Button,
  Checkbox,
  cn,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  ModelCaption,
} from "@openfield/ui";
import {
  Copy,
  Download,
  Ellipsis,
  Folder,
  FolderInput,
  FolderMinus,
  FolderX,
  Heart,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type MouseEvent, memo, type PointerEvent, useCallback, useState } from "react";
import { useAuthedImage } from "../api/hooks/images";
import { detailTarget } from "../detail/use-detail";
import { logoFor } from "../lib/provider";
import type { LibraryActions } from "./actions";
import { type DragPayload, useDragSource, useDropState, useIsDragged } from "./drag";
import { openFolderMenu, useFolderMenuOpen } from "./folder-menu";
import { thumbPath } from "./media";
import { subtreeOf } from "./sidebar";

// The grid's pieces (design rnsTH, dVwPY, ULgBc, N2Bods, AjRdL family, FEaIC, hJ9bs): image cards,
// folder cards, date headers and the Folders section title.

export interface ImageCardProps {
  item: AssetListItem;
  size: number;
  rung: number;
  selected: boolean;
  /** The grid's one tab stop. */
  tabStop: boolean;
  trash: boolean;
  /** The open folder, so the menu can offer Remove from folder. */
  folder: { id: string; name: string } | undefined;
  modelName: string | undefined;
  actions: LibraryActions;
  /** A click on the card: opens it, or selects with ⌘/Ctrl or Shift. */
  onActivate: (item: AssetListItem, event: { toggle: boolean; range: boolean }) => void;
  /** The checkbox: toggles, or selects a range with Shift. */
  onCheck: (item: AssetListItem, range: boolean) => void;
  onFocusCard: (id: string) => void;
  /** Opens the Add to folder picker beside this card. */
  onFile: (id: string) => void;
  /** The ⋯ menu is open. The grid owns this so Shift+F10 can open it from the keyboard. */
  menuOpen: boolean;
  onMenu: (id: string | null) => void;
  dragPayload: (item: AssetListItem) => DragPayload | null;
}

/** Library / Card / {Idle, Hover, Selected} and / Trash / Hover. */
export const ImageCard = memo(function ImageCard({
  item,
  size,
  rung,
  selected,
  tabStop,
  trash,
  folder,
  modelName,
  actions,
  onActivate,
  onCheck,
  onFocusCard,
  onFile,
  menuOpen,
  onMenu,
  dragPayload,
}: ImageCardProps) {
  const image = useAuthedImage(thumbPath(item, rung));
  const dragged = useIsDragged(item.id);
  const dragStart = useDragSource(
    useCallback(() => (trash ? null : dragPayload(item)), [trash, dragPayload, item]),
  );
  const label = t("feed.tile.label", {
    prompt: item.prompt.trim() ? truncate(item.prompt, 80) : t("feed.tile.noPrompt"),
    model: modelName ?? item.modelId ?? "",
    date: formatDate(item.createdAt),
  });
  const logo = logoFor(item.providerId ?? undefined);

  const stop = (event: MouseEvent | PointerEvent) => event.stopPropagation();
  // Hover chrome also shows for keyboard focus and while the card's menu is open.
  const chrome = cn(
    "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
    menuOpen && "opacity-100",
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the grid takes the keys for every card (Enter opens).
    // biome-ignore lint/a11y/useSemanticElements: cells of a virtual grid are placed absolutely, which table cells can't be.
    <div
      role="gridcell"
      aria-selected={selected}
      aria-label={label}
      tabIndex={tabStop ? 0 : -1}
      {...detailTarget(item.id)}
      onClick={(event) => onActivate(item, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey })}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusCard(item.id);
      }}
      onPointerDown={dragStart}
      className={cn(
        "group relative shrink-0 cursor-pointer select-none overflow-hidden rounded-12 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        selected ? "bg-accent-soft inset-ring-2 inset-ring-accent-line" : "bg-elevated",
        dragged && "opacity-40",
      )}
      style={{ width: size, height: size }}
    >
      <div className={cn("absolute overflow-hidden", selected ? "inset-6 rounded-8" : "inset-0")}>
        {image.status === "ready" ? (
          <img src={image.src} alt="" draggable={false} decoding="async" className="size-full object-cover" />
        ) : null}
        <div aria-hidden className={cn("absolute inset-0 bg-scrim", chrome)} />
      </div>
      {/* A 1px edge above the image, so pale images stay bounded. */}
      {selected ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-12 inset-ring inset-ring-border"
        />
      )}
      <Checkbox
        onImage={!selected}
        checked={selected}
        tabIndex={-1}
        aria-label={t("assets.card.select")}
        onPointerDown={stop}
        onClick={(event) => {
          // The grid owns selection, so the box never toggles itself.
          event.preventDefault();
          event.stopPropagation();
          onCheck(item, event.shiftKey);
        }}
        className="absolute top-12 left-12"
      />
      {trash ? (
        <div className={cn("absolute right-12 bottom-12 left-12 flex items-center gap-6", chrome)}>
          <Button
            variant="overlay"
            size="s"
            icon={RotateCcw}
            tabIndex={-1}
            className="min-w-0 flex-1"
            onPointerDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              actions.restore([item.id]);
            }}
          >
            {t("assets.card.restore")}
          </Button>
          <IconButton
            variant="overlay"
            size={32}
            icon={Trash2}
            tone="danger"
            tabIndex={-1}
            label={t("assets.card.deleteForGood")}
            onPointerDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              actions.purge([item.id]);
            }}
          />
        </div>
      ) : (
        <>
          <div className={cn("absolute top-12 right-12 flex gap-4", chrome)}>
            <IconButton
              variant="overlay"
              size={32}
              icon={Heart}
              tabIndex={-1}
              label={item.isFavourite ? t("assets.card.unfavorite") : t("assets.card.favorite")}
              aria-pressed={item.isFavourite}
              className={cn(item.isFavourite && "text-accent [&>svg]:fill-current")}
              onPointerDown={stop}
              onClick={(event) => {
                event.stopPropagation();
                actions.favourite([item.id], !item.isFavourite);
              }}
            />
            <IconButton
              variant="overlay"
              size={32}
              icon={Download}
              tabIndex={-1}
              label={t("assets.card.download")}
              onPointerDown={stop}
              onClick={(event) => {
                event.stopPropagation();
                void actions.download([item]);
              }}
            />
            <CardMenu
              item={item}
              folder={folder}
              actions={actions}
              open={menuOpen}
              onOpenChange={(open) => onMenu(open ? item.id : null)}
              onFile={() => onFile(item.id)}
            />
          </div>
          {modelName ? (
            <div
              className={cn("pointer-events-none absolute bottom-12 left-12 max-w-[calc(100%-24px)]", chrome)}
            >
              {logo ? (
                <ModelCaption provider={logo} name={modelName} layout="stacked" onImage />
              ) : (
                <span className="text-micro font-medium text-overlay-fg">{modelName}</span>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
});

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** The card's ⋯ menu (design IMvIQ): the actions for this one image. */
function CardMenu({
  item,
  folder,
  actions,
  open,
  onOpenChange,
  onFile,
}: {
  item: AssetListItem;
  folder: { id: string; name: string } | undefined;
  actions: LibraryActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFile: () => void;
}) {
  // The picker opens once the menu has closed and handed focus back, or it would close at once.
  const [filing, setFiling] = useState(false);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <IconButton
          variant="overlay"
          size={32}
          icon={Ellipsis}
          tabIndex={-1}
          label={t("assets.card.more")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      </MenuTrigger>
      <MenuContent
        align="end"
        // The menu is portaled, but React still bubbles its events to the card: keep them here.
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!filing) return;
          event.preventDefault();
          setFiling(false);
          onFile();
        }}
      >
        {item.jobSetId ? (
          <MenuItem icon={RefreshCw} onSelect={() => actions.recreate(item)}>
            {t("feed.tile.menu.recreate")}
          </MenuItem>
        ) : null}
        <MenuItem icon={PencilLine} onSelect={() => actions.reuse(item)}>
          {t("feed.tile.menu.reuse")}
        </MenuItem>
        <MenuItem icon={Copy} onSelect={() => void actions.copyPrompt(item)}>
          {t("feed.tile.menu.copyPrompt")}
        </MenuItem>
        <MenuItem icon={FolderInput} onSelect={() => setFiling(true)}>
          {t("feed.tile.menu.addToFolder")}
        </MenuItem>
        {folder ? (
          <MenuItem icon={FolderMinus} onSelect={() => actions.removeFromFolder([item.id], folder)}>
            {t("assets.card.removeFromFolder")}
          </MenuItem>
        ) : null}
        <MenuItem icon={Download} onSelect={() => void actions.download([item])}>
          {t("assets.card.download")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => actions.trash([item.id])}>
          {t("feed.tile.menu.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Library / Folder card / {Idle, Hover, Drop target, Can't drop} (design AjRdL). */
export const FolderCard = memo(function FolderCard({
  node,
  width,
  onOpen,
}: {
  node: FolderNode;
  width: number;
  onOpen: (id: string) => void;
}) {
  const id = node.folder.id;
  // A card has no Disabled look (design AjRdL): inside a dragged folder it stays idle until hovered.
  const dropState = useDropState(id);
  const drop = dropState === "disabled" ? null : dropState;
  const menuOpen = useFolderMenuOpen(id);
  const dragStart = useDragSource(
    useCallback(
      () => ({ kind: "folder" as const, folderId: id, name: node.folder.name, subtree: subtreeOf(node) }),
      [id, node],
    ),
  );
  const Icon = drop === "drop" ? FolderInput : drop === "cant" ? FolderX : Folder;
  const meta =
    node.childCount > 0
      ? t("assets.folder.metaWithFolders", { images: node.folder.count, folders: node.childCount })
      : t("assets.folder.meta", { images: node.folder.count });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and right-click only; the button inside is the control.
    <div
      data-drop-folder={id}
      data-drop-name={node.folder.name}
      onPointerDown={dragStart}
      onContextMenu={(event) => {
        event.preventDefault();
        openFolderMenu(
          id,
          { x: event.clientX, y: event.clientY },
          event.currentTarget.querySelector("button"),
        );
      }}
      className={cn(
        "group relative h-64 shrink-0 rounded-12 inset-ring transition-colors",
        drop === "drop"
          ? "bg-accent-soft inset-ring-accent"
          : drop === "cant"
            ? "bg-elevated inset-ring-danger-line"
            : cn(
                "bg-elevated inset-ring-border hover:bg-elevated-2 hover:inset-ring-border-strong",
                menuOpen && "bg-elevated-2 inset-ring-border-strong",
              ),
      )}
      style={{ width }}
    >
      {/* It covers the card, so it has to start a drag too. */}
      <button
        type="button"
        data-drag-handle
        onClick={() => onOpen(id)}
        className="flex size-full cursor-pointer items-center gap-12 rounded-12 px-14 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Icon
          size={20}
          aria-hidden
          className={cn(
            "shrink-0",
            drop === "drop" ? "text-accent" : drop === "cant" ? "text-danger" : "text-text-secondary",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-3">
          <span
            className={cn(
              "truncate text-small font-medium text-text-primary",
              !drop && "group-hover:max-w-92",
              menuOpen && "max-w-92",
            )}
          >
            {node.folder.name}
          </span>
          <MonoNumbers text={meta} className="gap-4 text-micro text-text-tertiary" />
        </span>
      </button>
      {drop ? null : (
        <IconButton
          size={24}
          icon={Ellipsis}
          label={t("assets.sidebar.more", { folder: node.folder.name })}
          data-no-drag
          className={cn(
            "absolute top-4 right-4 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            menuOpen && "opacity-100",
          )}
          onClick={(event) => openFolderMenu(id, event.currentTarget)}
        />
      )}
    </div>
  );
});

/**
 * "8 images · 2 folders" with the numbers in mono and each word its own piece, as the design lays
 * the meta line out (count, word, dot, count, word).
 */
function MonoNumbers({ text, className }: { text: string; className?: string }) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <span className={cn("flex min-w-0 items-center whitespace-nowrap", className)}>
      {words.map((word, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the words are positional and never reorder.
        <span key={index} className={/^[\d.,  ]+$/.test(word) ? "text-mono-11" : undefined}>
          {word}
        </span>
      ))}
    </span>
  );
}

/** Library / Section title (design hJ9bs): "Folders" and how many. */
export function SectionTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-40 w-full items-center gap-10">
      <h2 className="text-group-title text-text-primary">{label}</h2>
      <span className="text-mono-12 text-text-tertiary">{formatNumber(count)}</span>
    </div>
  );
}

/** Library / Date header / {Off, Mixed, On} (design FEaIC, WSX7k, RaE1E). */
export function DateHeader({
  label,
  state,
  onToggle,
  disabled = false,
}: {
  label: string;
  state: boolean | "indeterminate";
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-40 w-full items-center justify-between">
      <div className="flex items-center gap-10">
        <Checkbox
          checked={state}
          disabled={disabled}
          aria-label={t("assets.groups.select", { group: label })}
          onClick={(event) => {
            event.preventDefault();
            onToggle();
          }}
        />
        <h2 className="text-group-title text-text-primary">{label}</h2>
      </div>
    </div>
  );
}

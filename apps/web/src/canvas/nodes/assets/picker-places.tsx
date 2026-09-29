import { type FolderNode, formatNumber, t, visibleFolders } from "@openfield/core";
import { cn } from "@openfield/ui";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { treeIndent } from "../../../assets/layout";
import { useLibraryPrefs } from "../../../assets/prefs";
import { useLibraryTree } from "../../../assets/tree";
import { ALL_PLACE, FAVOURITES_PLACE, type Place, samePlace } from "./picker-order";

// Places (design q31cb ZFqrY): Favorites first and picked by default, then All images, then the
// folder tree - the same tree and row styling the Assets sidebar uses (tree.ts, sidebar.tsx), just
// without its drag, rename and context menu (this picker only browses).

export function PickerPlaces({
  place,
  onPlace,
  favouritesCount,
  allCount,
}: {
  place: Place;
  onPlace: (place: Place) => void;
  favouritesCount: number;
  allCount: number;
}) {
  const tree = useLibraryTree();
  const sidebarExpanded = useLibraryPrefs((s) => s.expanded);
  const [expanded, setExpanded] = useState(() => new Set(sidebarExpanded));
  const toggleOpen = (id: string) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rows = tree.data ? visibleFolders(tree.data, (id) => expanded.has(id)) : [];

  return (
    <nav
      aria-label={t("canvas.nodes.picker.places.folders")}
      className="flex h-full w-240 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-surface p-12"
    >
      <NavRow
        icon={Heart}
        label={t("canvas.nodes.picker.places.favorites")}
        count={favouritesCount}
        active={samePlace(place, FAVOURITES_PLACE)}
        onClick={() => onPlace(FAVOURITES_PLACE)}
      />
      <NavRow
        icon={ImageIcon}
        label={t("canvas.nodes.picker.places.allImages")}
        count={allCount}
        active={samePlace(place, ALL_PLACE)}
        onClick={() => onPlace(ALL_PLACE)}
      />
      {rows.length ? (
        <div className="flex flex-col gap-2 pt-14">
          <span className="px-10 pb-4 text-caption font-medium text-text-tertiary">
            {t("canvas.nodes.picker.places.folders")}
          </span>
          {rows.map((node) => (
            <FolderTreeRow
              key={node.folder.id}
              node={node}
              open={expanded.has(node.folder.id)}
              active={place.kind === "folder" && place.folderId === node.folder.id}
              onOpen={() => onPlace({ kind: "folder", folderId: node.folder.id })}
              onToggle={() => toggleOpen(node.folder.id)}
            />
          ))}
        </div>
      ) : null}
    </nav>
  );
}

/** Row / Nav / {Idle, Active}: Favorites and All images, plain rows with no disclosure or indent. */
function NavRow({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-34 w-full shrink-0 cursor-pointer items-center gap-10 rounded-10 px-10 text-left outline-none transition-colors focus-visible:inset-ring-2 focus-visible:inset-ring-accent",
        active ? "bg-accent-soft" : "hover:bg-elevated",
      )}
    >
      <Icon size={16} aria-hidden className={cn("shrink-0", active ? "text-accent" : "text-text-tertiary")} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-body",
          active ? "font-medium text-accent" : "text-text-secondary",
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-mono-12 text-text-tertiary">{formatNumber(count)}</span>
    </button>
  );
}

/** Library / Tree row / Idle (design ifcYq): the sidebar's own row, minus what this picker doesn't need. */
function FolderTreeRow({
  node,
  open,
  active,
  onOpen,
  onToggle,
}: {
  node: FolderNode;
  open: boolean;
  active: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const hasChildren = node.children.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  const FolderIcon = open && hasChildren ? FolderOpen : Folder;
  return (
    // Two buttons, not one nested in the other: the chevron toggles, the rest opens the place, and
    // a keyboard reaches both (the sidebar's own row leans on a click a screen reader can't reach).
    <div
      className={cn(
        "flex h-34 w-full shrink-0 items-center gap-4 rounded-10 pr-10 pl-4 transition-colors",
        active ? "bg-accent-soft" : "hover:bg-elevated",
      )}
      style={{ paddingLeft: treeIndent(node.depth) }}
    >
      <button
        type="button"
        disabled={!hasChildren}
        aria-expanded={hasChildren ? open : undefined}
        aria-label={
          hasChildren
            ? t(open ? "canvas.nodes.picker.places.collapse" : "canvas.nodes.picker.places.expand", {
                folder: node.folder.name,
              })
            : undefined
        }
        onClick={onToggle}
        className="flex size-16 shrink-0 cursor-pointer items-center justify-center outline-none disabled:cursor-default"
      >
        {hasChildren ? <Chevron size={14} className="text-text-tertiary" /> : null}
      </button>
      <button
        type="button"
        aria-pressed={active}
        title={node.folder.name}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-8 text-left outline-none"
      >
        <FolderIcon
          size={16}
          aria-hidden
          className={cn("shrink-0", active ? "text-accent" : "text-text-tertiary")}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-body",
            active ? "font-medium text-accent" : "text-text-secondary",
          )}
        >
          {node.folder.name}
        </span>
        <span className="shrink-0 text-mono-12 text-text-tertiary">{formatNumber(node.folder.count)}</span>
      </button>
    </div>
  );
}

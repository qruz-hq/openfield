import {
  FOLDER_NAME_MAX,
  type FolderNode,
  type FolderTree,
  matchFolders,
  t,
  visibleFolders,
} from "@openfield/core";
import { Button, Checkbox, cn, Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@openfield/ui";
import { ChevronDown, ChevronRight, FolderPlus, Search } from "lucide-react";
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { isPendingFolder, useCreateFolder } from "../api/hooks/folders";
import { type Membership, useFolderMemberships } from "../api/hooks/library";
import { useLibraryActions } from "./actions";
import { treeIndent } from "./layout";
import { useLibraryPrefs } from "./prefs";
import { useLibraryTree } from "./tree";

// Popover / Add to folder (design RI4UA, C85UO): the folder tree with a checkbox per folder that
// shows whether the images are in it: on (all), mixed (some), off (none). A click files or unfiles
// them at once and keeps their other folders; the picker stays open for more picks (§2.8).
//
// The detail view uses this too: <AddToFolderPopover ids={[asset.id]} …><IconButton …/></…>.

export interface AddToFolderPopoverProps {
  /** The images to file. */
  ids: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it, or with `anchorOnly`, just what it lines up with. */
  children: ReactElement;
  /** The child only positions the picker and doesn't toggle it (a menu opened it, say). */
  anchorOnly?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Where focus goes when it closes, for a picker with no trigger (`anchorOnly`). */
  returnFocus?: () => HTMLElement | null;
}

export function AddToFolderPopover({
  ids,
  open,
  onOpenChange,
  children,
  anchorOnly = false,
  side = "top",
  align = "start",
  sideOffset = 8,
  returnFocus,
}: AddToFolderPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchorOnly ? (
        <PopoverAnchor asChild>{children}</PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        aria-label={t("assets.picker.label")}
        // Above the toaster (sonner's z-index): opened from the selection bar, the picker grows
        // into the spot where the last drop's "Added to…" toast still sits.
        className="z-[1000000000] w-288 gap-0 p-0"
        onCloseAutoFocus={
          returnFocus
            ? (event) => {
                event.preventDefault();
                returnFocus()?.focus({ preventScroll: true });
              }
            : undefined
        }
      >
        {open ? <AddToFolderPanel ids={ids} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The picker's inside, for a surface that brings its own popover. */
export function AddToFolderPanel({ ids }: { ids: readonly string[] }) {
  const tree = useLibraryTree();
  const memberships = useFolderMemberships(ids);
  const actions = useLibraryActions();
  const createFolder = useCreateFolder();
  const sidebarExpanded = useLibraryPrefs((s) => s.expanded);
  const [expanded, setExpanded] = useState(() => new Set(sidebarExpanded));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [overrides, setOverrides] = useState(() => new Map<string, { state: Membership; at: number }>());
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => (tree.data ? pickRows(tree.data, query, expanded) : []),
    [tree.data, query, expanded],
  );

  // A click shows at once; the server's answer replaces it when it comes back.
  const stateOf = (id: string): Membership => {
    const override = overrides.get(id);
    if (override && override.at > memberships.dataUpdatedAt) return override.state;
    return memberships.data?.stateOf(id) ?? "off";
  };

  const toggle = (node: FolderNode) => {
    if (isPendingFolder(node.folder.id) || ids.length === 0) return;
    const on = stateOf(node.folder.id) === "on";
    setOverrides((map) => new Map(map).set(node.folder.id, { state: on ? "off" : "on", at: Date.now() }));
    if (on) actions.removeFromFolder(ids, node.folder, { toast: false });
    else actions.addToFolder(ids, node.folder, { toast: false });
  };

  const setOpen = (id: string, open: boolean) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const activeIndex = rows.findIndex((node) => node.folder.id === active);

  useEffect(() => {
    if (!active) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const node = rows[activeIndex];
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!rows.length) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = activeIndex < 0 ? (step > 0 ? 0 : rows.length - 1) : activeIndex + step;
        setActive(rows[Math.max(0, Math.min(rows.length - 1, next))]!.folder.id);
        return;
      }
      case "Enter":
        if (!node) return;
        event.preventDefault();
        toggle(node);
        return;
      case "ArrowRight":
        if (!node || query || node.children.length === 0) return;
        event.preventDefault();
        if (!expanded.has(node.folder.id)) setOpen(node.folder.id, true);
        else setActive(node.children[0]!.folder.id);
        return;
      case "ArrowLeft":
        if (!node || query) return;
        if (expanded.has(node.folder.id) && node.children.length) {
          event.preventDefault();
          setOpen(node.folder.id, false);
        } else if (node.parent) {
          event.preventDefault();
          setActive(node.parent.folder.id);
        }
        return;
    }
  };

  const hasFolders = (tree.data?.byId.size ?? 0) > 0;

  return (
    <>
      <div className="flex h-44 w-full shrink-0 items-center gap-10 px-14">
        <Search size={14} aria-hidden className="shrink-0 text-text-tertiary" />
        <input
          type="search"
          // biome-ignore lint/a11y/noAutofocus: the picker opens to find a folder, so typing goes there.
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={t("assets.picker.find")}
          aria-label={t("assets.picker.find")}
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
      </div>
      <div className="h-px w-full shrink-0 bg-border" />
      <div
        ref={list}
        id={listId}
        role="tree"
        aria-label={t("assets.picker.label")}
        aria-multiselectable
        className="flex max-h-360 w-full flex-col gap-2 overflow-y-auto p-6"
      >
        {rows.length === 0 ? (
          <p className="flex h-32 items-center px-10 text-small text-text-tertiary">
            {hasFolders ? t("assets.picker.noMatches", { query: query.trim() }) : t("assets.picker.none")}
          </p>
        ) : (
          rows.map((node) => (
            <PickRow
              key={node.folder.id}
              id={`${listId}-${node.folder.id}`}
              node={node}
              state={stateOf(node.folder.id)}
              open={query ? true : expanded.has(node.folder.id)}
              active={node.folder.id === active}
              searching={Boolean(query)}
              onToggle={() => {
                setActive(node.folder.id);
                toggle(node);
              }}
              onDisclose={() => setOpen(node.folder.id, !expanded.has(node.folder.id))}
            />
          ))
        )}
      </div>
      <div className="h-px w-full shrink-0 bg-border" />
      <NewFolderFooter
        busy={createFolder.isPending}
        onCreate={(name) =>
          createFolder.mutate(
            { name },
            { onSuccess: (folder) => actions.addToFolder(ids, folder, { toast: false }) },
          )
        }
      />
    </>
  );
}

/** Rows in tree order: only open folders' children, or while finding, the matches and their ancestors. */
function pickRows(tree: FolderTree, query: string, expanded: ReadonlySet<string>): FolderNode[] {
  const shown = matchFolders(tree, query);
  if (!shown) return visibleFolders(tree, (id) => expanded.has(id));
  return visibleFolders(tree).filter((node) => shown.has(node.folder.id));
}

/** Row / Folder pick / {Off, On, Mixed, Hover} (design O8PR5N). */
function PickRow({
  id,
  node,
  state,
  open,
  active,
  searching,
  onToggle,
  onDisclose,
}: {
  id: string;
  node: FolderNode;
  state: Membership;
  open: boolean;
  active: boolean;
  searching: boolean;
  onToggle: () => void;
  onDisclose: () => void;
}) {
  const pending = isPendingFolder(node.folder.id);
  const hasChildren = node.children.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field above drives the keyboard (aria-activedescendant).
    <div
      id={id}
      role="treeitem"
      data-folder-id={node.folder.id}
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? open : undefined}
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      aria-disabled={pending || undefined}
      tabIndex={-1}
      onClick={onToggle}
      className={cn(
        "flex h-32 w-full shrink-0 cursor-pointer select-none items-center gap-8 rounded-8 pr-8 transition-colors hover:bg-elevated-2",
        active && "bg-elevated-2",
        pending && "cursor-default opacity-40",
      )}
      style={{ paddingLeft: treeIndent(node.depth) }}
    >
      <span className="flex shrink-0 items-center gap-6">
        {/* The slot stays for a folder with no subfolders, so names line up. */}
        <span
          aria-hidden
          className="flex size-16 items-center justify-center"
          onClick={(event) => {
            if (!hasChildren || searching) return;
            event.stopPropagation();
            onDisclose();
          }}
        >
          {hasChildren ? <Chevron size={14} className="text-text-tertiary" /> : null}
        </span>
        <Checkbox
          checked={state === "mixed" ? "indeterminate" : state === "on"}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-small text-text-primary">{node.folder.name}</span>
    </div>
  );
}

/** The footer: New folder, then an inline name field with Add (design C85UO). */
function NewFolderFooter({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setName("");
    setEditing(false);
  };

  return (
    <div className="flex w-full shrink-0 flex-col p-6">
      {editing ? (
        <div className="flex h-40 w-full items-center gap-8 pr-4 pl-10">
          <FolderPlus size={16} aria-hidden className="shrink-0 text-text-secondary" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because New folder was chosen.
            autoFocus
            value={name}
            maxLength={FOLDER_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                // Esc leaves the field, not the picker.
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
                setName("");
              }
            }}
            aria-label={t("assets.folder.name")}
            className="h-30 min-w-0 flex-1 rounded-8 bg-surface px-10 text-small text-text-primary outline-none inset-ring inset-ring-accent-line focus-visible:outline-none"
          />
          <Button size="s" disabled={!name.trim()} loading={busy} onClick={submit}>
            {t("assets.picker.add")}
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex h-32 w-full cursor-pointer items-center gap-10 rounded-8 px-10 text-left text-small text-text-primary outline-none transition-colors hover:bg-elevated-2 focus-visible:bg-elevated-2"
        >
          <FolderPlus size={16} aria-hidden className="shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">{t("assets.picker.newFolder")}</span>
        </button>
      )}
    </div>
  );
}

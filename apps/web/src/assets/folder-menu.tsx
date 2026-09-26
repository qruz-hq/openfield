import {
  type FolderNode,
  type FolderTree,
  folderDescendants,
  moveTarget,
  t,
  visibleFolders,
} from "@openfield/core";
import {
  cn,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@openfield/ui";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  FolderRoot,
  PencilLine,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { isPendingFolder } from "../api/hooks/folders";
import { type FolderActions, startNewFolder, startRename } from "./folder-actions";
import { treeIndent } from "./layout";
import { useLibraryPrefs } from "./prefs";

// Menu / Folder and its Move to submenu (design Z1srGa, VWUi0, dyFft). One menu for the whole
// page: a tree row's ⋯, a right-click on a row or card, and the header's ⋯ all open it at a point.

interface MenuRequest {
  folderId: string;
  x: number;
  y: number;
  /** Where focus goes when the menu closes without starting something else. */
  returnFocus: HTMLElement | null;
  /** Tells a new request from the last one, so the menu reopens at the new point. */
  key: number;
}

const useFolderMenu = create<{ request: MenuRequest | null }>()(() => ({ request: null }));
let requests = 0;

/**
 * Opens the folder menu below an element (a ⋯ button), or at the pointer for a right-click.
 * Focus goes back to `returnFocus`, or to the element, when it closes.
 */
export function openFolderMenu(
  folderId: string,
  at: HTMLElement | { x: number; y: number },
  returnFocus?: HTMLElement | null,
) {
  if (isPendingFolder(folderId)) return;
  const point =
    at instanceof HTMLElement
      ? { x: at.getBoundingClientRect().left, y: at.getBoundingClientRect().bottom }
      : at;
  useFolderMenu.setState({
    request: {
      folderId,
      ...point,
      returnFocus: returnFocus ?? (at instanceof HTMLElement ? at : null),
      key: ++requests,
    },
  });
}

/** Whether the menu is open for this folder, so its row can keep showing ⋯. */
export const useFolderMenuOpen = (folderId: string) => useFolderMenu((s) => s.request?.folderId === folderId);

export function FolderMenuHost({ tree, actions }: { tree: FolderTree | undefined; actions: FolderActions }) {
  const request = useFolderMenu((s) => s.request);
  const node = request ? tree?.byId.get(request.folderId) : undefined;
  // New subfolder, Rename and Delete folder start once the menu has closed and let go of focus:
  // started earlier, the menu's focus trap pulls focus out of the name field and the edit ends.
  const next = useRef<(() => void) | null>(null);
  if (!request || !node) return null;

  const close = () => useFolderMenu.setState({ request: null });
  const afterClose = (run: () => void) => () => {
    next.current = run;
  };

  return (
    <Menu key={request.key} open onOpenChange={(open) => (open ? undefined : close())}>
      <MenuTrigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: request.x, top: request.y }}
        />
      </MenuTrigger>
      <MenuContent
        sideOffset={4}
        align="start"
        collisionPadding={8}
        aria-label={t("assets.folder.menu")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const run = next.current;
          next.current = null;
          // Focus goes back first, so a dialog the action opens hands it back there too.
          request.returnFocus?.focus({ preventScroll: true });
          run?.();
        }}
      >
        <MenuItem icon={FolderPlus} onSelect={afterClose(() => startNewFolder(node.folder.id))}>
          {t("assets.folder.newSubfolder")}
        </MenuItem>
        <MenuItem icon={PencilLine} onSelect={afterClose(() => startRename(node.folder.id))}>
          {t("assets.folder.rename")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger icon={FolderInput}>{t("assets.folder.moveTo")}</MenuSubTrigger>
          <MenuSubContent collisionPadding={8} className="w-248">
            <MoveToList
              tree={tree!}
              node={node}
              onMove={(parentId) => actions.move(node.folder.id, parentId)}
            />
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={afterClose(() => actions.remove(node.folder.id))}>
          {t("assets.folder.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * Menu / Move to: Top level, then the tree. The current parent has a check and choosing it does
 * nothing; the folder and everything inside it are Disabled rows, so the menu can't offer a move
 * the server would refuse (§2.8).
 */
function MoveToList({
  tree,
  node,
  onMove,
}: {
  tree: FolderTree;
  node: FolderNode;
  onMove: (parentId: string | null) => void;
}) {
  const sidebarExpanded = useLibraryPrefs((s) => s.expanded);
  const [expanded, setExpanded] = useState(() => new Set(sidebarExpanded));
  const rows = useMemo(() => visibleFolders(tree, (id) => expanded.has(id)), [tree, expanded]);
  const inside = useMemo(
    () => new Set([node.folder.id, ...folderDescendants(node).map((n) => n.folder.id)]),
    [node],
  );
  const currentParent = node.parent?.folder.id ?? null;

  const toggle = (id: string, open = !expanded.has(id)) =>
    setExpanded((set) => {
      const next = new Set(set);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <MenuLabel>{t("assets.folder.moveHeading", { folder: node.folder.name })}</MenuLabel>
      <MenuItem
        icon={FolderRoot}
        // The check is drawn, so the current parent is named for screen readers this way.
        aria-current={currentParent === null ? "true" : undefined}
        onSelect={() => (currentParent === null ? undefined : onMove(null))}
        className="gap-10"
      >
        <span className="flex w-full items-center gap-8">
          <span className="min-w-0 flex-1 truncate">{t("assets.folder.topLevel")}</span>
          {currentParent === null ? <Check size={16} aria-hidden className="shrink-0 text-accent" /> : null}
        </span>
      </MenuItem>
      <MenuSeparator />
      <div className="flex max-h-360 flex-col overflow-y-auto">
        {rows.map((row) => {
          const id = row.folder.id;
          const disabled = inside.has(id) || isPendingFolder(id);
          const current = moveTarget(tree, node.folder.id, id) === "current";
          const hasChildren = row.children.length > 0;
          const open = expanded.has(id);
          const Chevron = open ? ChevronDown : ChevronRight;
          const onKeyDown = (event: KeyboardEvent) => {
            if (!hasChildren) return;
            // → opens a folder in place; ← closes it, and only then closes the submenu.
            if (event.key === "ArrowRight" && !open) {
              event.preventDefault();
              toggle(id, true);
            } else if (event.key === "ArrowLeft" && open) {
              event.preventDefault();
              event.stopPropagation();
              toggle(id, false);
            }
          };
          return (
            <MenuItem
              key={id}
              disabled={disabled}
              aria-current={current ? "true" : undefined}
              aria-expanded={hasChildren ? open : undefined}
              onKeyDown={onKeyDown}
              onSelect={() => (current ? undefined : onMove(id))}
              className="shrink-0 gap-8 pr-10"
              style={{ paddingLeft: treeIndent(row.depth) }}
            >
              {/* Row / Move target / {Default, Hover, Current, Disabled} (design rdkZ3). */}
              <span className="flex w-full items-center gap-8">
                <span className="flex shrink-0 items-center gap-4">
                  <span
                    aria-hidden
                    className="flex size-16 items-center justify-center"
                    onClick={(event) => {
                      if (!hasChildren) return;
                      // Opening a folder here mustn't pick it.
                      event.preventDefault();
                      event.stopPropagation();
                      toggle(id);
                    }}
                  >
                    {hasChildren ? <Chevron size={14} className="text-text-tertiary" /> : null}
                  </span>
                  <Folder
                    size={16}
                    aria-hidden
                    className={cn("shrink-0", disabled ? "text-text-tertiary" : "text-text-secondary")}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{row.folder.name}</span>
                {current ? <Check size={16} aria-hidden className="shrink-0 text-accent" /> : null}
              </span>
            </MenuItem>
          );
        })}
      </div>
    </>
  );
}

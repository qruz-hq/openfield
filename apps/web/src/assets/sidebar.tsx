import {
  FOLDER_NAME_MAX,
  type FolderNode,
  type FolderTree,
  folderPath,
  formatNumber,
  libraryHref,
  t,
  visibleFolders,
} from "@openfield/core";
import { Button, cn, IconButton, NavRow, Tooltip } from "@openfield/ui";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderX,
  Heart,
  Image,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { isPendingFolder } from "../api/hooks/folders";
import { useLibrarySummary } from "../api/hooks/library";
import { useDragSource, useDragStore, useDropState } from "./drag";
import {
  type FolderActions,
  type FolderEdit,
  startNewFolder,
  startRename,
  stopEditing,
  useFolderEdit,
} from "./folder-actions";
import { openFolderMenu, useFolderMenuOpen } from "./folder-menu";
import { treeIndent } from "./layout";
import { useLibraryPrefs } from "./prefs";
import { type LibraryRoute, searchOf } from "./route";

// Library / Sidebar / Tree (design R0kf8n): search, the three views with their counts, then the
// folder tree. 255 wide with a hairline on its right edge.

export const LIBRARY_SEARCH_ID = "library-search";
const SEARCH_DEBOUNCE_MS = 200;

export function LibrarySidebar({
  route,
  tree,
  actions,
}: {
  route: LibraryRoute;
  tree: FolderTree | undefined;
  actions: FolderActions;
}) {
  const summary = useLibrarySummary();
  const counts = summary.data?.counts;
  const { view, query } = route;
  const words = searchOf(query);

  return (
    <div className="relative flex w-255 shrink-0">
      <aside
        data-library-sidebar
        data-drag-scroll
        aria-label={t("assets.sidebar.label")}
        className="flex min-h-0 w-full flex-col gap-12 overflow-y-auto bg-surface p-16"
      >
        <LibrarySearch route={route} />
        <nav aria-label={t("assets.sidebar.label")} className="flex w-full flex-col gap-2">
          <NavRow
            asChild
            icon={Image}
            label={t("assets.views.all")}
            count={counts ? formatNumber(counts.all) : undefined}
            active={view === "all"}
          >
            <Link to={libraryHref({ view: "all", ...words })} />
          </NavRow>
          <NavRow
            asChild
            icon={Heart}
            label={t("assets.views.favorites")}
            count={counts ? formatNumber(counts.favourites) : undefined}
            active={view === "favourites"}
          >
            <Link to={libraryHref({ view: "favourites", ...words })} />
          </NavRow>
          <NavRow
            asChild
            icon={Trash2}
            label={t("assets.views.trash")}
            count={counts ? formatNumber(counts.trash) : undefined}
            active={view === "trash"}
          >
            <Link to="/assets/trash" />
          </NavRow>
        </nav>
        <FolderSection route={route} tree={tree} actions={actions} />
      </aside>
      <div aria-hidden className="pointer-events-none absolute top-0 right-0 h-full w-px bg-border" />
    </div>
  );
}

/** Focuses the sidebar search, for ⌘/Ctrl+F. */
export function focusLibrarySearch() {
  const input = document.getElementById(LIBRARY_SEARCH_ID) as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

/**
 * Input / Search and / Filled (design KvyOP, mBBNw). Typing searches the view after a short pause;
 * from the Trash, which has no search, it searches All images (§2.8).
 */
function LibrarySearch({ route }: { route: LibraryRoute }) {
  const { query } = route;
  const urlWords = query.q ?? "";
  const [text, setText] = useState(urlWords);
  const latest = useRef(route);
  latest.current = route;
  const sent = useRef(urlWords);

  // The URL changed from somewhere else (Clear search, a link): the field follows.
  useEffect(() => {
    if (urlWords === sent.current) return;
    sent.current = urlWords;
    setText(urlWords);
  }, [urlWords]);

  const send = useCallback((words: string) => {
    const { view: current, query: at, go: navigate } = latest.current;
    sent.current = words;
    if (current === "trash") {
      if (words) navigate({ view: "all", q: words });
      return;
    }
    navigate({ ...at, q: words || undefined }, { replace: true });
  }, []);

  useEffect(() => {
    const words = text.trim();
    if (words === sent.current) return;
    const timer = setTimeout(() => send(words), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, send]);

  const clear = () => {
    setText("");
    send("");
  };
  const filled = text.length > 0;

  return (
    <search
      className={cn(
        "flex h-32 w-full shrink-0 items-center gap-8 rounded-8 bg-elevated inset-ring transition-shadow has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        filled ? "pr-4 pl-10 inset-ring-border-strong" : "px-10 inset-ring-border",
      )}
    >
      <Search
        size={14}
        aria-hidden
        className={cn("shrink-0", filled ? "text-text-secondary" : "text-text-tertiary")}
      />
      <input
        id={LIBRARY_SEARCH_ID}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            send(text.trim());
          } else if (event.key === "Escape" && filled) {
            // Esc empties the field first; the page's Esc (clear selection) waits for the next one.
            event.preventDefault();
            clear();
          }
        }}
        placeholder={t("assets.sidebar.search")}
        aria-label={t("assets.sidebar.search")}
        className="min-w-0 flex-1 bg-transparent text-small text-text-primary outline-none placeholder:text-text-tertiary focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      {filled ? (
        <IconButton size={24} icon={X} label={t("assets.sidebar.clearSearch")} onClick={clear} />
      ) : null}
    </search>
  );
}

// Folders

type TreeItem =
  | { kind: "folder"; node: FolderNode }
  | { kind: "new"; parentId: string | null; depth: number };

/** Rows in sidebar order, with the new folder's editing row where it will land. */
function treeItems(tree: FolderTree, expanded: ReadonlySet<string>, edit: FolderEdit | null): TreeItem[] {
  const rows: TreeItem[] = visibleFolders(tree, (id) => expanded.has(id)).map((node) => ({
    kind: "folder",
    node,
  }));
  if (edit?.mode !== "new") return rows;
  const parent = edit.parentId ? tree.byId.get(edit.parentId) : undefined;
  if (edit.parentId && !parent) return rows;
  // After the parent's last visible descendant, or at the end for the top level.
  let at = rows.length;
  if (parent) {
    const start = rows.findIndex((r) => r.kind === "folder" && r.node === parent);
    // The parent is inside a collapsed folder: the row shows once the tree opens down to it.
    if (start < 0) return rows;
    at = start + 1;
    while (at < rows.length) {
      const row = rows[at]!;
      if (row.kind !== "folder" || row.node.depth <= parent.depth) break;
      at++;
    }
  }
  rows.splice(at, 0, { kind: "new", parentId: edit.parentId, depth: parent ? parent.depth + 1 : 0 });
  return rows;
}

function FolderSection({
  route,
  tree,
  actions,
}: {
  route: LibraryRoute;
  tree: FolderTree | undefined;
  actions: FolderActions;
}) {
  const expandedList = useLibraryPrefs((s) => s.expanded);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const edit = useFolderEdit((s) => s.edit);
  const openId = route.folderId;
  const items = useMemo(() => (tree ? treeItems(tree, expanded, edit) : []), [tree, expanded, edit]);
  const folderRows = items.filter(
    (item): item is Extract<TreeItem, { kind: "folder" }> => item.kind === "folder",
  );
  const [focusId, setFocusId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef(false);

  // The roving tab stop: the focused row, else the open folder, else the first.
  const tabStop =
    folderRows.find((r) => r.node.folder.id === focusId)?.node.folder.id ??
    folderRows.find((r) => r.node.folder.id === openId)?.node.folder.id ??
    folderRows[0]?.node.folder.id;

  useEffect(() => {
    if (!keyboardMove.current || !focusId) return;
    keyboardMove.current = false;
    list.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(focusId)}"]`)?.focus();
  }, [focusId]);

  // Opening a folder from anywhere brings its row into view.
  useEffect(() => {
    if (!openId) return;
    const frame = requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(openId)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [openId]);

  const setOpen = useLibraryPrefs((s) => s.setExpanded);

  // A new subfolder's row needs its parent on screen, so the tree opens down to it.
  useEffect(() => {
    if (edit?.mode !== "new" || !edit.parentId || !tree) return;
    useLibraryPrefs.getState().expand(folderPath(tree, edit.parentId).map((node) => node.folder.id));
  }, [edit, tree]);

  // After a rename ends, the keyboard picks up on the renamed row rather than at the top of the page.
  const lastEdit = useRef(edit);
  useEffect(() => {
    const was = lastEdit.current;
    lastEdit.current = edit;
    if (edit || was?.mode !== "rename" || document.activeElement !== document.body) return;
    list.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(was.folderId)}"]`)?.focus();
  }, [edit]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const index = folderRows.findIndex((r) => r.node.folder.id === tabStop);
    const row = folderRows[index];
    if (!row) return;
    const node = row.node;
    const id = node.folder.id;
    const focus = (next: FolderNode | undefined) => {
      if (!next) return;
      keyboardMove.current = true;
      setFocusId(next.folder.id);
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focus(folderRows[Math.min(folderRows.length - 1, index + 1)]?.node);
        return;
      case "ArrowUp":
        event.preventDefault();
        focus(folderRows[Math.max(0, index - 1)]?.node);
        return;
      case "Home":
        event.preventDefault();
        focus(folderRows[0]?.node);
        return;
      case "End":
        event.preventDefault();
        focus(folderRows.at(-1)?.node);
        return;
      case "ArrowRight":
        if (!node.children.length) return;
        event.preventDefault();
        if (!expanded.has(id)) setOpen(id, true);
        else focus(node.children[0]);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (node.children.length && expanded.has(id)) setOpen(id, false);
        else focus(node.parent ?? undefined);
        return;
      case "Enter":
        event.preventDefault();
        actions.open(id);
        return;
      case "F2":
        event.preventDefault();
        startRename(id);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        actions.remove(id);
        return;
      case "ContextMenu":
        event.preventDefault();
        openFolderMenu(id, event.target as HTMLElement);
        return;
      default:
        if (event.key === "F10" && event.shiftKey) {
          event.preventDefault();
          openFolderMenu(id, event.target as HTMLElement);
        }
    }
  };

  const empty = tree !== undefined && tree.byId.size === 0 && edit?.mode !== "new";

  return (
    <div className="flex w-full flex-col gap-2 pt-12">
      <FoldersHeader onNew={() => startNewFolder(null)} />
      {empty ? (
        // Library / Folders / Empty (design OxeRm): the header, a line, New folder.
        <div className="flex w-full flex-col gap-6 pt-4">
          <p className="px-10 text-caption leading-[1.45] font-normal text-text-tertiary">
            {t("assets.sidebar.noFolders")}
          </p>
          <Button
            variant="ghost"
            size="s"
            icon={FolderPlus}
            className="self-start"
            onClick={() => startNewFolder(null)}
          >
            {t("assets.sidebar.newFolder")}
          </Button>
        </div>
      ) : (
        <div
          ref={list}
          role="tree"
          aria-label={t("assets.sidebar.folders")}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="flex w-full flex-col gap-2 outline-none"
        >
          {items.map((item) =>
            item.kind === "new" ? (
              <EditingRow
                key={`new:${item.parentId ?? "top"}`}
                depth={item.depth}
                initial=""
                onDone={(name) => actions.commit({ mode: "new", parentId: item.parentId }, name)}
              />
            ) : edit?.mode === "rename" && edit.folderId === item.node.folder.id ? (
              <EditingRow
                key={`rename:${item.node.folder.id}`}
                depth={item.node.depth}
                initial={item.node.folder.name}
                node={item.node}
                open={expanded.has(item.node.folder.id)}
                onDone={(name) => actions.commit(edit, name)}
              />
            ) : (
              <TreeRow
                key={item.node.folder.id}
                node={item.node}
                open={expanded.has(item.node.folder.id)}
                selected={item.node.folder.id === openId}
                tabStop={item.node.folder.id === tabStop}
                actions={actions}
                onFocusRow={() => setFocusId(item.node.folder.id)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Row / Group header and / Drop target (design mhNwJ, BHy26): a folder dropped here goes to the top level. */
function FoldersHeader({ onNew }: { onNew: () => void }) {
  const state = useDragStore((s) =>
    s.payload?.kind === "folder" && s.target?.type === "top" && s.verdict === "allowed" ? "drop" : null,
  );
  return (
    <div
      data-drop-top
      className={cn(
        "flex h-28 w-full shrink-0 items-center justify-between rounded-8 pr-4 pl-10",
        state === "drop" && "bg-accent-soft inset-ring inset-ring-accent",
      )}
    >
      <span
        className={cn(
          "text-caption font-medium",
          state === "drop" ? "text-text-primary" : "text-text-tertiary",
        )}
      >
        {t("assets.sidebar.folders")}
      </span>
      {state === "drop" ? null : (
        <IconButton size={24} icon={FolderPlus} label={t("assets.sidebar.newFolder")} onClick={onNew} />
      )}
    </div>
  );
}

/** Library / Tree row / {Idle, Selected, Hover, Drop target, Can't drop, Disabled} (design ifcYq). */
function TreeRow({
  node,
  open,
  selected,
  tabStop,
  actions,
  onFocusRow,
}: {
  node: FolderNode;
  open: boolean;
  selected: boolean;
  tabStop: boolean;
  actions: FolderActions;
  onFocusRow: () => void;
}) {
  const id = node.folder.id;
  const pending = isPendingFolder(id);
  const drop = useDropState(id);
  const menuOpen = useFolderMenuOpen(id);
  const setOpen = useLibraryPrefs((s) => s.setExpanded);
  const hasChildren = node.children.length > 0;
  const expandedLook = hasChildren && open;
  const row = useRef<HTMLDivElement>(null);

  const dragStart = useDragSource(
    useCallback(
      () =>
        pending
          ? null
          : {
              kind: "folder" as const,
              folderId: id,
              name: node.folder.name,
              subtree: subtreeOf(node),
            },
      [pending, id, node],
    ),
  );

  const Chevron = open ? ChevronDown : ChevronRight;
  const Icon = drop === "drop" ? FolderInput : drop === "cant" ? FolderX : expandedLook ? FolderOpen : Folder;
  const disabled = drop === "disabled";

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    onFocusRow();
    openFolderMenu(id, { x: event.clientX, y: event.clientY }, row.current);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree takes the keys for every row (Enter opens).
    <div
      ref={row}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={selected}
      aria-disabled={pending || undefined}
      tabIndex={tabStop ? 0 : -1}
      data-tree-id={id}
      data-drop-folder={pending ? undefined : id}
      data-drop-name={node.folder.name}
      title={node.folder.name}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusRow();
      }}
      onPointerDown={dragStart}
      onClick={() => actions.open(id)}
      onContextMenu={onContextMenu}
      className={cn(
        "group flex h-34 w-full shrink-0 cursor-pointer select-none items-center gap-8 rounded-10 pr-10 outline-none transition-colors focus-visible:inset-ring-2 focus-visible:inset-ring-accent",
        drop === "drop"
          ? "bg-accent-soft inset-ring inset-ring-accent"
          : drop === "cant"
            ? "inset-ring inset-ring-danger-line"
            : disabled
              ? ""
              : selected
                ? "bg-accent-soft"
                : "hover:bg-elevated",
        menuOpen && !selected && "bg-elevated",
        pending && "cursor-default opacity-60",
      )}
      style={{ paddingLeft: treeIndent(node.depth) }}
    >
      <span className="flex shrink-0 items-center gap-4">
        {/* The slot stays on a folder with no subfolders, so names line up. */}
        <span
          aria-hidden
          className="flex size-16 items-center justify-center"
          onClick={(event) => {
            if (!hasChildren) return;
            event.stopPropagation();
            setOpen(id, !open);
          }}
        >
          {hasChildren ? <Chevron size={14} className="text-text-tertiary" /> : null}
        </span>
        <Icon
          size={16}
          aria-hidden
          className={cn(
            "shrink-0",
            drop === "drop" || (selected && !drop)
              ? "text-accent"
              : drop === "cant"
                ? "text-danger"
                : "text-text-tertiary",
          )}
        />
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click is a shortcut; F2 and Rename do the same. */}
      <span
        onDoubleClick={(event) => {
          event.stopPropagation();
          startRename(id);
        }}
        className={cn(
          "min-w-0 flex-1 truncate text-body",
          drop === "drop"
            ? "font-medium text-text-primary"
            : drop === "cant"
              ? "text-text-secondary"
              : disabled
                ? "text-text-tertiary"
                : selected
                  ? "font-medium text-accent"
                  : "text-text-secondary group-hover:text-text-primary",
        )}
      >
        {node.folder.name}
      </span>
      {disabled ? null : (
        <>
          <span
            className={cn(
              "shrink-0 text-mono-12 text-text-tertiary",
              !pending && !drop && "group-hover:hidden group-focus-visible:hidden",
              menuOpen && "hidden",
            )}
          >
            {formatNumber(node.folder.count)}
          </span>
          {pending || drop ? null : (
            <IconButton
              size={24}
              icon={Ellipsis}
              label={t("assets.sidebar.more", { folder: node.folder.name })}
              tabIndex={-1}
              data-no-drag
              className={cn(
                "hidden group-hover:inline-flex group-focus-visible:inline-flex",
                menuOpen && "inline-flex",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onFocusRow();
                openFolderMenu(id, event.currentTarget, row.current);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

export function subtreeOf(node: FolderNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: FolderNode) => {
    ids.add(n.folder.id);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return ids;
}

/**
 * Library / Tree row / Editing (design u3yNa, v0RQD): the name field in place of the label, with
 * the hint beside it. Enter saves; Esc, an empty name or clicking away cancels (§2.8).
 */
function EditingRow({
  depth,
  initial,
  node,
  open = false,
  onDone,
}: {
  depth: number;
  initial: string;
  node?: FolderNode;
  open?: boolean;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value === null) stopEditing();
    else onDone(value);
  };
  const hasChildren = (node?.children.length ?? 0) > 0;
  const Chevron = open ? ChevronDown : ChevronRight;
  const Icon = hasChildren && open ? FolderOpen : Folder;

  return (
    <Tooltip content={t("assets.folder.editHint")} open side="right" sideOffset={8}>
      <div
        className="flex h-34 w-full shrink-0 items-center gap-8 rounded-10 bg-elevated pr-10"
        style={{ paddingLeft: treeIndent(depth) }}
      >
        <span className="flex shrink-0 items-center gap-4">
          <span aria-hidden className="flex size-16 items-center justify-center">
            {hasChildren ? <Chevron size={14} className="text-text-tertiary" /> : null}
          </span>
          <Icon size={16} aria-hidden className="shrink-0 text-text-tertiary" />
        </span>
        <span className="flex h-26 min-w-0 flex-1 items-center rounded-6 bg-elevated px-8 inset-ring inset-ring-accent-line">
          <input
            // biome-ignore lint/a11y/noAutofocus: the row appears because New folder or Rename was chosen.
            autoFocus
            value={name}
            maxLength={FOLDER_NAME_MAX}
            aria-label={t("assets.folder.name")}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => finish(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finish(name);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
              }
            }}
            className="w-full min-w-0 bg-transparent text-body text-text-primary caret-accent outline-none focus-visible:outline-none"
          />
        </span>
      </div>
    </Tooltip>
  );
}

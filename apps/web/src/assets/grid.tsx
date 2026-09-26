import { type AssetListItem, dayHeading, type FolderNode, groupByDay, t } from "@openfield/core";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LibraryActions } from "./actions";
import { AddToFolderPopover } from "./add-to-folder";
import { DateHeader, FolderCard, ImageCard, SectionTitle } from "./cards";
import type { DragPayload } from "./drag";
import {
  columnsFor,
  computeLayout,
  GRID_GAP,
  GROUP_GAP,
  GROUP_HEADER_HEIGHT,
  type GroupInput,
  moveIndex,
  positionOf,
  rangeBetween,
  rowTop,
  rungFor,
  visibleGroups,
} from "./layout";
import { useModelNames } from "./media";
import { groupState, useSelection } from "./selection";

// Library / Grid (design qln34, s5XLm): subfolder cards first, then date groups of square cards,
// 6 columns at 1440. Only the rows near the viewport render; heights come from the counts, so the
// scrollbar is right from the first paint (§2.8). The grid is one tab stop with arrow keys inside.

const SIDE_PADDING = 25;
/** Room under the last row so the selection bar never covers it. */
const BOTTOM_PADDING = 96;
/** Load the next page this far before the end. */
const LOAD_AHEAD = 1200;

export interface LoadMoreResult {
  items: AssetListItem[];
  hasMore: boolean;
}

export interface LibraryGridProps {
  label: string;
  items: AssetListItem[];
  /** The open folder's subfolders, shown as cards on top. Empty elsewhere and while searching. */
  subfolders: FolderNode[];
  /** How many images the view has, loaded or not, for the scroll height. */
  total: number | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<LoadMoreResult>;
  zoom: number;
  trash: boolean;
  folder: { id: string; name: string } | undefined;
  actions: LibraryActions;
  /** The image the detail view shows: kept in view and focused for when it closes. */
  activeId: string | null;
  onOpen: (id: string) => void;
  onOpenFolder: (id: string) => void;
  /** Shown under the subfolders when there are no images. */
  empty: ReactNode;
}

export function LibraryGrid({
  label,
  items,
  subfolders,
  total,
  hasMore,
  loadingMore,
  loadMore,
  zoom,
  trash,
  folder,
  actions,
  activeId,
  onOpen,
  onOpenFolder,
  empty,
}: LibraryGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const selected = useSelection((s) => s.ids);
  const modelName = useModelNames();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [filingId, setFilingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const focusAfterRender = useRef(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setBox({ width: Math.max(0, el.clientWidth - SIDE_PADDING * 2), height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const days = useMemo(
    () => groupByDay(items, trash ? (item) => item.deletedAt ?? item.createdAt : (item) => item.createdAt),
    [items, trash],
  );
  const columns = columnsFor(zoom);
  const layout = useMemo(() => {
    const groups: GroupInput[] = [
      ...(subfolders.length ? [{ key: "folders", kind: "folders" as const, count: subfolders.length }] : []),
      ...days.map((day) => ({ key: day.day, kind: "day" as const, count: day.items.length })),
    ];
    return computeLayout({ width: box.width, columns, groups });
  }, [box.width, columns, subfolders.length, days]);
  const cardSize = layout.cardSize;

  // Images not loaded yet still take their rows, so the scrollbar doesn't jump as pages arrive.
  const unloaded = hasMore ? Math.max(columns, (total ?? items.length) - items.length) : 0;
  const tail = unloaded > 0 ? GROUP_GAP + Math.ceil(unloaded / columns) * (cardSize + GRID_GAP) : 0;
  const height = layout.height + tail + BOTTOM_PADDING;

  const visible = useMemo(
    () => visibleGroups(layout, scrollTop, box.height),
    [layout, scrollTop, box.height],
  );
  const byId = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
  const dayByKey = useMemo(() => new Map(days.map((day) => [day.day, day])), [days]);
  const order = useMemo(() => items.map((item) => item.id), [items]);

  // Paging: the next page loads as the viewport nears the end of what's loaded.
  useEffect(() => {
    if (!hasMore || loadingMore || box.height === 0) return;
    if (scrollTop + box.height + LOAD_AHEAD >= layout.height) void loadMore();
  }, [hasMore, loadingMore, scrollTop, box.height, layout.height, loadMore]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  /** Scrolls a card into view, clear of the sticky date header. */
  const reveal = useCallback(
    (index: number) => {
      const el = scroller.current;
      const at = positionOf(layout, index);
      if (!el || !at) return;
      const top = at.top;
      const bottom = top + cardSize;
      if (top < el.scrollTop + GROUP_HEADER_HEIGHT + GRID_GAP) {
        el.scrollTop = Math.max(0, top - GROUP_HEADER_HEIGHT - GRID_GAP);
      } else if (bottom > el.scrollTop + el.clientHeight - GRID_GAP) {
        el.scrollTop = bottom - el.clientHeight + GRID_GAP;
      }
      setScrollTop(el.scrollTop);
    },
    [layout, cardSize],
  );

  // The detail view steps through this list: keep its image in view, and make it the tab stop so
  // focus lands on it when the view closes.
  useEffect(() => {
    if (!activeId) return;
    const index = byId.get(activeId);
    if (index === undefined) return;
    setFocusId(activeId);
    reveal(index);
  }, [activeId, byId, reveal]);

  useEffect(() => {
    if (!focusAfterRender.current || !focusId) return;
    focusAfterRender.current = false;
    grid.current
      ?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(focusId)}"]`)
      ?.focus({ preventScroll: true });
  });

  const tabStop = focusId !== null && byId.has(focusId) ? focusId : (items[0]?.id ?? null);

  const selectRange = useCallback(
    (to: AssetListItem) => {
      const { anchor, set, toggle } = useSelection.getState();
      const ids = anchor ? rangeBetween(order, anchor, to.id) : [];
      if (!ids.length) return toggle(to);
      const wanted = new Set(ids);
      set(
        items.filter((item) => wanted.has(item.id)),
        true,
        to.id,
      );
    },
    [order, items],
  );

  const onActivate = useCallback(
    (item: AssetListItem, event: { toggle: boolean; range: boolean }) => {
      setFocusId(item.id);
      if (event.range) selectRange(item);
      else if (event.toggle) useSelection.getState().toggle(item);
      else onOpen(item.id);
    },
    [selectRange, onOpen],
  );

  const onCheck = useCallback(
    (item: AssetListItem, range: boolean) => {
      setFocusId(item.id);
      if (range) selectRange(item);
      else useSelection.getState().toggle(item);
    },
    [selectRange],
  );

  /** A selected card drags the whole selection; any other card drags itself (§2.8). */
  const dragPayload = useCallback((item: AssetListItem): DragPayload | null => {
    const { ids, items: kept } = useSelection.getState();
    if (!ids.has(item.id)) return { kind: "images", ids: [item.id], previews: [item] };
    const others = [...kept.values()].filter((other) => other.id !== item.id);
    return { kind: "images", ids: [...ids], previews: [item, ...others].slice(0, 2) };
  }, []);

  /**
   * A date group's checkbox selects the whole day. If the day may go on past the loaded pages,
   * it pages until the next day starts, then selects (§2.5).
   */
  const toggleDay = useCallback(
    async (day: string) => {
      let list = items;
      let more = hasMore;
      const lastDay = () =>
        groupByDay(list, (i) => (trash ? (i.deletedAt ?? i.createdAt) : i.createdAt)).at(-1);
      while (more && lastDay()?.day === day) {
        const next = await loadMore();
        list = next.items;
        more = next.hasMore;
      }
      const group = groupByDay(list, (i) => (trash ? (i.deletedAt ?? i.createdAt) : i.createdAt)).find(
        (g) => g.day === day,
      );
      if (!group) return;
      const { ids, set } = useSelection.getState();
      set(group.items, groupState(ids, group.items) !== true, group.items.at(-1)?.id ?? null);
    },
    [items, hasMore, loadMore, trash],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input,[role=menu],[role=dialog]")) return;
    // A button inside a card (its checkbox, say) keeps its own Enter and Space.
    if ((event.key === "Enter" || event.key === " ") && target.closest("button")) return;
    const index = tabStop ? (byId.get(tabStop) ?? -1) : -1;
    const item = items[index];
    if (!item) return;
    const selection = useSelection.getState();
    const targets = () => (selection.ids.size > 0 ? [...selection.ids] : [item.id]);
    const mod = event.metaKey || event.ctrlKey;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End": {
        event.preventDefault();
        const next = moveIndex(layout, index, event.key, items.length);
        const target = items[next];
        if (!target) return;
        if (event.shiftKey) {
          if (!selection.anchor) selection.set([item], true, item.id);
          selectRange(target);
        }
        focusAfterRender.current = true;
        setFocusId(target.id);
        reveal(next);
        if (next >= items.length - columns && hasMore && !loadingMore) void loadMore();
        return;
      }
      case "PageDown":
      case "PageUp": {
        event.preventDefault();
        const el = scroller.current;
        if (el) el.scrollTop += (event.key === "PageDown" ? 1 : -1) * (el.clientHeight - GROUP_HEADER_HEIGHT);
        return;
      }
      case "Enter":
        event.preventDefault();
        onOpen(item.id);
        return;
      case " ":
      case "x":
      case "X":
        if (mod) return;
        event.preventDefault();
        selection.toggle(item);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        if (trash) actions.purge(targets());
        else actions.trash(targets());
        return;
      case "f":
      case "F": {
        if (trash || mod || event.shiftKey) return;
        event.preventDefault();
        const ids = targets();
        const all = ids.every((id) => (selection.items.get(id) ?? items[byId.get(id) ?? -1])?.isFavourite);
        actions.favourite(ids, !all);
        return;
      }
      case "ContextMenu":
      case "F10":
        if (event.key === "F10" && !event.shiftKey) return;
        if (trash) return;
        event.preventDefault();
        setMenuId(item.id);
        return;
      case "d":
      case "D": {
        if (mod) return;
        event.preventDefault();
        const list =
          selection.ids.size > 0
            ? [...selection.ids].map((id) => selection.items.get(id)).filter(isItem)
            : [item];
        void actions.download(list);
        return;
      }
    }
  };

  const filingAt = filingId ? byId.get(filingId) : undefined;
  const filingPos = filingAt !== undefined ? positionOf(layout, filingAt) : null;
  const imageGroups = layout.groups.filter((group) => group.kind === "day").length;
  const foldersGroup = layout.groups.find((group) => group.kind === "folders");

  return (
    <div
      ref={scroller}
      data-drag-scroll
      onScroll={onScroll}
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      {imageGroups === 0 ? (
        // No images: the subfolders (if any), then the empty state in the space left.
        <div className="flex min-h-full flex-col px-25">
          {foldersGroup ? (
            <div className="flex flex-col gap-8">
              <SectionTitle label={t("assets.folder.sectionTitle")} count={subfolders.length} />
              <div className="flex flex-wrap gap-18">
                {subfolders.map((node) => (
                  <FolderCard key={node.folder.id} node={node} width={cardSize} onOpen={onOpenFolder} />
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-1 flex-col items-center justify-center pt-20 pb-104">{empty}</div>
        </div>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: an ARIA grid of cards has no native element.
        <div
          ref={grid}
          role="grid"
          aria-label={label}
          aria-multiselectable
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative mx-25 outline-none"
          style={{ height }}
        >
          {visible.map(({ group, firstRow, lastRow }) => {
            const day = group.kind === "day" ? dayByKey.get(group.key) : undefined;
            const rows: number[] = [];
            for (let row = firstRow; row <= lastRow; row++) rows.push(row);
            return (
              // biome-ignore lint/a11y/useSemanticElements: rows of a virtual grid are placed absolutely, which table elements can't be.
              <div
                key={group.key}
                role="rowgroup"
                className="absolute inset-x-0"
                style={{ top: group.top, height: group.height }}
              >
                {
                  // biome-ignore lint/a11y/useSemanticElements: see the row group above.
                  // biome-ignore lint/a11y/useFocusableInteractive: rows aren't tab stops; the checkbox is.
                  <div role="row" className="sticky top-0 z-10 bg-surface">
                    {
                      // biome-ignore lint/a11y/useSemanticElements: see the row group above.
                      // biome-ignore lint/a11y/useFocusableInteractive: the header's checkbox is the tab stop.
                      <div role="rowheader">
                        {group.kind === "folders" ? (
                          <SectionTitle label={t("assets.folder.sectionTitle")} count={subfolders.length} />
                        ) : day ? (
                          <DateHeader
                            label={dayHeading(day.day)}
                            state={groupState(selected, day.items)}
                            onToggle={() => void toggleDay(day.day)}
                          />
                        ) : null}
                      </div>
                    }
                  </div>
                }
                {rows.map((row) => {
                  const start = row * columns;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: see the row group above.
                    // biome-ignore lint/a11y/useFocusableInteractive: rows aren't tab stops; the cards are.
                    <div
                      key={row}
                      role="row"
                      className="absolute left-0 flex gap-18"
                      style={{ top: rowTop(group, row) }}
                    >
                      {group.kind === "folders"
                        ? subfolders
                            .slice(start, start + columns)
                            .map((node) => (
                              <FolderCard
                                key={node.folder.id}
                                node={node}
                                width={cardSize}
                                onOpen={onOpenFolder}
                              />
                            ))
                        : (day?.items.slice(start, start + columns) ?? []).map((item) => (
                            <ImageCard
                              key={item.id}
                              item={item}
                              size={cardSize}
                              rung={rungFor(cardSize, item.width, item.height)}
                              selected={selected.has(item.id)}
                              tabStop={item.id === tabStop}
                              trash={trash}
                              folder={folder}
                              modelName={modelName(item.providerId, item.modelId)}
                              actions={actions}
                              onActivate={onActivate}
                              onCheck={onCheck}
                              onFocusCard={setFocusId}
                              onFile={setFilingId}
                              menuOpen={menuId === item.id}
                              onMenu={setMenuId}
                              dragPayload={dragPayload}
                            />
                          ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {filingId && filingPos ? (
            <AddToFolderPopover
              ids={[filingId]}
              open
              onOpenChange={(open) => (open ? undefined : setFilingId(null))}
              anchorOnly
              side="right"
              align="start"
              returnFocus={() =>
                grid.current?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(filingId)}"]`) ?? null
              }
            >
              <div
                aria-hidden
                className="pointer-events-none absolute"
                style={{
                  top: filingPos.top,
                  left: filingPos.col * (cardSize + GRID_GAP),
                  width: cardSize,
                  height: cardSize,
                }}
              />
            </AddToFolderPopover>
          ) : null}
        </div>
      )}
    </div>
  );
}

const isItem = (item: AssetListItem | undefined): item is AssetListItem => item !== undefined;

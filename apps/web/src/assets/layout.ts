import { THUMB_RUNGS } from "@openfield/core";

// The library grid's geometry (§2.8, design s5XLm): fixed square cards in date groups, laid out
// from numbers alone so the grid can render only what's on screen and the scrollbar is right from
// the first paint. Pure, so it's tested without a browser.

/** Gaps between cards and between their rows. */
export const GRID_GAP = 18;
/** Between one group (Folders, a day) and the next. */
export const GROUP_GAP = 20;
/** Library / Date header and Library / Section title. */
export const GROUP_HEADER_HEIGHT = 40;
/** Between a group's header and its first row. */
export const GROUP_HEADER_GAP = 8;
/** Library / Folder card. */
export const FOLDER_CARD_HEIGHT = 64;
/** Zoom steps 0 to 4 give 8, 7, 6, 5 and 4 columns; 6 at the default step. */
export const COLUMNS_BY_ZOOM = [8, 7, 6, 5, 4] as const;
export const DEFAULT_LIBRARY_ZOOM = 2;

export const columnsFor = (zoom: number): number =>
  COLUMNS_BY_ZOOM[Math.min(COLUMNS_BY_ZOOM.length - 1, Math.max(0, Math.round(zoom)))]!;

/** Card edge for a content width: 174 at 1134 wide and 6 columns. Never below zero. */
export function cardSizeFor(width: number, columns: number): number {
  if (width <= 0 || columns <= 0) return 0;
  return Math.max(0, (width - GRID_GAP * (columns - 1)) / columns);
}

export interface GroupInput {
  key: string;
  kind: "folders" | "day";
  /** Cards in the group: subfolders for "folders", loaded images for a day. */
  count: number;
}

export interface GroupLayout extends GroupInput {
  /** From the top of the groups area. */
  top: number;
  height: number;
  rows: number;
  rowHeight: number;
  /** Where the group's first card sits in the flat list of its kind. */
  start: number;
}

export interface GridLayout {
  groups: GroupLayout[];
  columns: number;
  cardSize: number;
  /** Everything, top padding included. */
  height: number;
}

export function computeLayout({
  width,
  columns,
  groups,
  paddingTop = 0,
  paddingBottom = 0,
}: {
  width: number;
  columns: number;
  groups: readonly GroupInput[];
  paddingTop?: number;
  paddingBottom?: number;
}): GridLayout {
  const cardSize = cardSizeFor(width, columns);
  const out: GroupLayout[] = [];
  let top = paddingTop;
  const starts = { folders: 0, day: 0 };
  for (const group of groups) {
    if (group.count <= 0) continue;
    const rows = Math.ceil(group.count / columns);
    const rowHeight = group.kind === "folders" ? FOLDER_CARD_HEIGHT : cardSize;
    const height = GROUP_HEADER_HEIGHT + GROUP_HEADER_GAP + rows * rowHeight + (rows - 1) * GRID_GAP;
    if (out.length > 0) top += GROUP_GAP;
    out.push({ ...group, top, height, rows, rowHeight, start: starts[group.kind] });
    starts[group.kind] += group.count;
    top += height;
  }
  return { groups: out, columns, cardSize, height: top + paddingBottom };
}

/** Where row `row` of a group starts, from the group's top. */
export const rowTop = (group: GroupLayout, row: number): number =>
  GROUP_HEADER_HEIGHT + GROUP_HEADER_GAP + row * (group.rowHeight + GRID_GAP);

export interface VisibleGroup {
  group: GroupLayout;
  /** Inclusive row range worth rendering. */
  firstRow: number;
  lastRow: number;
}

/**
 * The groups and rows inside the viewport, plus `overscan` pixels either side. A group that's
 * visible at all always renders its header, so the sticky header stays in place while its rows
 * scroll under it.
 */
export function visibleGroups(
  layout: GridLayout,
  scrollTop: number,
  viewport: number,
  overscan = 600,
): VisibleGroup[] {
  const from = scrollTop - overscan;
  const to = scrollTop + viewport + overscan;
  const out: VisibleGroup[] = [];
  for (const group of layout.groups) {
    if (group.top + group.height < from) continue;
    if (group.top > to) break;
    const step = group.rowHeight + GRID_GAP;
    const origin = group.top + GROUP_HEADER_HEIGHT + GROUP_HEADER_GAP;
    const firstRow = Math.max(0, Math.floor((from - origin) / step));
    const lastRow = Math.min(group.rows - 1, Math.floor((to - origin) / step));
    out.push({ group, firstRow: Math.min(firstRow, group.rows - 1), lastRow: Math.max(lastRow, 0) });
  }
  return out;
}

export interface CardPosition {
  group: GroupLayout;
  row: number;
  col: number;
  /** From the top of the groups area. */
  top: number;
}

/** Where the image at flat index `index` sits. Null past the end. */
export function positionOf(layout: GridLayout, index: number): CardPosition | null {
  for (const group of layout.groups) {
    if (group.kind !== "day") continue;
    if (index < group.start || index >= group.start + group.count) continue;
    const local = index - group.start;
    const row = Math.floor(local / layout.columns);
    return { group, row, col: local % layout.columns, top: group.top + rowTop(group, row) };
  }
  return null;
}

/**
 * Arrow keys in the grid (§2.6): left and right walk the list in order, across groups; up and down
 * keep the column, landing on the last card of a shorter row; Home and End go to either end.
 */
export function moveIndex(
  layout: GridLayout,
  index: number,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End",
  total: number,
): number {
  if (total <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(total - 1, index + 1);
  const at = positionOf(layout, index);
  if (!at) return index;
  const days = layout.groups.filter((g) => g.kind === "day");
  const g = days.indexOf(at.group);
  const rowStart = (group: GroupLayout, row: number) => group.start + row * layout.columns;
  const rowLength = (group: GroupLayout, row: number) =>
    Math.min(layout.columns, group.count - row * layout.columns);
  const land = (group: GroupLayout, row: number) =>
    rowStart(group, row) + Math.min(at.col, rowLength(group, row) - 1);
  if (key === "ArrowDown") {
    if (at.row < at.group.rows - 1) return land(at.group, at.row + 1);
    const next = days[g + 1];
    return next ? land(next, 0) : index;
  }
  if (at.row > 0) return land(at.group, at.row - 1);
  const previous = days[g - 1];
  return previous ? land(previous, previous.rows - 1) : index;
}

/** The ids between two in list order, both included. Empty when either isn't in the list. */
export function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/**
 * The thumbnail rung for a card (§0.10): the smallest height at least as big as the card once the
 * image covers it. A portrait image is fit by its width, so it needs a taller rung.
 */
export function rungFor(cardSize: number, width: number, height: number): number {
  const portrait = width > 0 && height > width ? height / width : 1;
  const needed = cardSize * portrait;
  return THUMB_RUNGS.find((rung) => rung >= needed) ?? THUMB_RUNGS[THUMB_RUNGS.length - 1]!;
}

/** The tree's indent: 4 at the top level, 20 more per level (design ifcYq). */
export const treeIndent = (depth: number): number => 4 + 20 * depth;

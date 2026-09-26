import type { AssetListItem } from "@openfield/core";
import { create } from "zustand";

// The library's selection (§2.5): keyed by image id, so it survives zoom, search, filters and
// paging. It keeps the last copy of each selected image it saw, for the bar's Favorite state and
// the drag ghost, even when a search has scrolled the card out of the list.

interface SelectionState {
  ids: ReadonlySet<string>;
  items: ReadonlyMap<string, AssetListItem>;
  /** The last card clicked or toggled: where a Shift+click range starts. */
  anchor: string | null;
  toggle: (item: AssetListItem) => void;
  /** Selects (or deselects) every one of these and moves the anchor to `anchor`. */
  set: (items: readonly AssetListItem[], on: boolean, anchor?: string | null) => void;
  /** Refreshes the kept copies, as favourites change. */
  refresh: (items: readonly AssetListItem[]) => void;
  drop: (ids: readonly string[]) => void;
  clear: () => void;
}

export const useSelection = create<SelectionState>()((set) => ({
  ids: new Set(),
  items: new Map(),
  anchor: null,
  toggle: (item) =>
    set((s) => {
      const ids = new Set(s.ids);
      const items = new Map(s.items);
      if (ids.has(item.id)) {
        ids.delete(item.id);
        items.delete(item.id);
      } else {
        ids.add(item.id);
        items.set(item.id, item);
      }
      return { ids, items, anchor: item.id };
    }),
  set: (list, on, anchor) =>
    set((s) => {
      const ids = new Set(s.ids);
      const items = new Map(s.items);
      for (const item of list) {
        if (on) {
          ids.add(item.id);
          items.set(item.id, item);
        } else {
          ids.delete(item.id);
          items.delete(item.id);
        }
      }
      return { ids, items, anchor: anchor === undefined ? s.anchor : anchor };
    }),
  refresh: (list) =>
    set((s) => {
      let changed = false;
      const items = new Map(s.items);
      for (const item of list) {
        const kept = items.get(item.id);
        if (kept && kept !== item) {
          items.set(item.id, item);
          changed = true;
        }
      }
      return changed ? { items } : s;
    }),
  drop: (gone) =>
    set((s) => {
      if (!gone.some((id) => s.ids.has(id))) return s;
      const ids = new Set(s.ids);
      const items = new Map(s.items);
      for (const id of gone) {
        ids.delete(id);
        items.delete(id);
      }
      return { ids, items, anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null };
    }),
  clear: () => set({ ids: new Set(), items: new Map(), anchor: null }),
}));

/** On (all), mixed (some) or off (none), for a date group's checkbox. */
export function groupState(
  ids: ReadonlySet<string>,
  items: readonly AssetListItem[],
): boolean | "indeterminate" {
  let on = 0;
  for (const item of items) if (ids.has(item.id)) on++;
  if (on === 0) return false;
  return on === items.length ? true : "indeterminate";
}

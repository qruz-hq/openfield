import type { CanvasSummary, MessageKey } from "@openfield/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "../../lib/storage";

// The index sort (§7.3): Last edited by default, then Name or Created. Remembered on this device.

export const CANVAS_SORTS = ["lastEdited", "name", "created"] as const;
export type CanvasSort = (typeof CANVAS_SORTS)[number];

export const SORT_LABELS: Record<CanvasSort, MessageKey> = {
  lastEdited: "canvas.index.sort.lastEdited",
  name: "canvas.index.sort.name",
  created: "canvas.index.sort.created",
};

interface SortState {
  sort: CanvasSort;
  setSort: (sort: CanvasSort) => void;
}

export const useCanvasSort = create<SortState>()(
  persist(
    (set) => ({
      sort: "lastEdited",
      setSort: (sort) => set({ sort }),
    }),
    {
      name: "openfield.canvas-index",
      version: 1,
      storage: safeStorage(),
      partialize: ({ sort }) => ({ sort }),
      merge: (saved, current) => {
        const sort = (saved as Partial<SortState> | undefined)?.sort;
        return { ...current, sort: sort && CANVAS_SORTS.includes(sort) ? sort : current.sort };
      },
    },
  ),
);

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Newest first for the dates, A to Z for names. Ties fall back to the newest edit. */
export function sortCanvases(list: readonly CanvasSummary[], sort: CanvasSort): CanvasSummary[] {
  const newer = (a: string, b: string) => Date.parse(b) - Date.parse(a);
  const byEdit = (a: CanvasSummary, b: CanvasSummary) => newer(a.updatedAt, b.updatedAt);
  const compare: Record<CanvasSort, (a: CanvasSummary, b: CanvasSummary) => number> = {
    lastEdited: byEdit,
    name: (a, b) => collator.compare(a.name, b.name) || byEdit(a, b),
    created: (a, b) => newer(a.createdAt, b.createdAt) || byEdit(a, b),
  };
  return [...list].sort(compare[sort]);
}

/** Case- and accent-blind match on the name. */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  return fold(name).includes(fold(q));
}

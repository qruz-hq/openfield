import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "../lib/storage";
import { DEFAULT_LIBRARY_ZOOM } from "./layout";

// Per-viewer conveniences for the library (§2.8): which folders are open in the tree and the grid
// size. Kept in localStorage, never state that matters: losing it just resets the view.

interface LibraryPrefs {
  /** Folder ids expanded in the sidebar tree. */
  expanded: string[];
  zoom: number;
  setExpanded: (id: string, open: boolean) => void;
  /** Opens every one of these, for "opening a folder expands its ancestors". */
  expand: (ids: readonly string[]) => void;
  setZoom: (zoom: number) => void;
}

export const useLibraryPrefs = create<LibraryPrefs>()(
  persist(
    (set) => ({
      expanded: [],
      zoom: DEFAULT_LIBRARY_ZOOM,
      setExpanded: (id, open) =>
        set((s) => ({
          expanded: open
            ? s.expanded.includes(id)
              ? s.expanded
              : [...s.expanded, id]
            : s.expanded.filter((e) => e !== id),
        })),
      expand: (ids) =>
        set((s) => {
          const missing = ids.filter((id) => !s.expanded.includes(id));
          return missing.length ? { expanded: [...s.expanded, ...missing] } : s;
        }),
      setZoom: (zoom) => set({ zoom }),
    }),
    {
      name: "openfield.library",
      version: 1,
      storage: safeStorage(),
      partialize: ({ expanded, zoom }) => ({ expanded, zoom }),
    },
  ),
);

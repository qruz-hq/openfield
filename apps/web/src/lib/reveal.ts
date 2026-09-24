import { create } from "zustand";

// "Show" on a finished Batch run: the app goes to /image, and the feed scrolls to the run's
// first tile and focuses it once that tile has rendered. A canvas run opens its canvas instead,
// where the node already holds the result.

interface RevealState {
  /** The run to bring into view, until the feed has done it. */
  jobSetId: string | null;
  /** The canvas to open, until the shell has navigated there. */
  canvasId: string | null;
  reveal: (jobSetId: string) => void;
  openCanvas: (canvasId: string) => void;
  done: () => void;
  canvasOpened: () => void;
}

export const useReveal = create<RevealState>((set) => ({
  jobSetId: null,
  canvasId: null,
  reveal: (jobSetId) => set({ jobSetId }),
  openCanvas: (canvasId) => set({ canvasId }),
  done: () => set({ jobSetId: null }),
  canvasOpened: () => set({ canvasId: null }),
}));

export const revealJobSet = (jobSetId: string) => useReveal.getState().reveal(jobSetId);
export const revealCanvas = (canvasId: string) => useReveal.getState().openCanvas(canvasId);

/** True while the canvas editor has this canvas open. */
export const inCanvas = (canvasId: string) =>
  typeof window !== "undefined" && window.location.pathname === `/canvas/${canvasId}`;

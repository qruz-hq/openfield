import { create } from "zustand";

// "Show" on a finished Batch run: the app goes to /image, and the feed scrolls to the run's
// first tile and focuses it once that tile has rendered.

interface RevealState {
  /** The run to bring into view, until the feed has done it. */
  jobSetId: string | null;
  reveal: (jobSetId: string) => void;
  done: () => void;
}

export const useReveal = create<RevealState>((set) => ({
  jobSetId: null,
  reveal: (jobSetId) => set({ jobSetId }),
  done: () => set({ jobSetId: null }),
}));

export const revealJobSet = (jobSetId: string) => useReveal.getState().reveal(jobSetId);

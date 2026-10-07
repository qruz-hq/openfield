import { type BatchState, isTerminalState, type JobSetState } from "@openfield/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "./storage";

// Client state that isn't server data: whether the event stream is up, queue positions it
// reports, Batch runs waiting at a company, failed tiles the person dismissed, and the message
// for screen readers.

/** A Batch run in flight, from batch.updated. Canvas nodes read it; the feed has its own copy. */
export interface LiveBatch {
  providerId: string;
  state: BatchState;
  stopping: boolean;
}

export interface LiveState {
  /** The event stream is connected. When it isn't, the feed polls every 2 s. */
  connected: boolean;
  /** The stream dropped, or failed to connect twice in a row (§8.4.6). */
  reconnecting: boolean;
  /**
   * This connection's snapshot has arrived. Until it has, the runs above are what the last
   * connection knew, and some of them may have ended while the stream was down.
   */
  synced: boolean;
  /** Runs ahead of each waiting job, from job.queued. */
  positions: Record<string, number>;
  /** Jobs waiting out a retry, from job.queued: when they go again, and whether Flex was busy. */
  retries: Record<string, { at: string; busy: boolean }>;
  /** Batch runs not finished yet, by job set id. */
  batches: Record<string, LiveBatch>;
  /**
   * Runs in progress, by job set id: every image, video and canvas node run is one. Kept here and
   * not read from the feed's cache, which only holds the lists a screen has loaded.
   */
  activeJobSets: Record<string, true>;
  /** Canvas runs not settled yet, by run id. Covers the moment between one node and the next. */
  canvasRuns: Record<string, true>;
  /** One polite announcement per run (§2.11). The id makes a repeat message re-announce. */
  announcement: { id: number; text: string };
  /** The server restarted with a new session token, so this page has to reload. */
  sessionExpired: boolean;
  setConnected: (connected: boolean, reconnecting?: boolean) => void;
  setPosition: (jobId: string, position: number | undefined) => void;
  setRetry: (jobId: string, retry: { at: string; busy: boolean } | undefined) => void;
  /** Undefined drops a finished run. */
  setBatch: (jobSetId: string, batch: LiveBatch | undefined) => void;
  clearBatches: () => void;
  /** The snapshot's list of runs in progress replaces what this tab had. */
  resetActive: (jobSetIds: readonly string[]) => void;
  setJobSetActive: (jobSetId: string, active: boolean) => void;
  setCanvasRun: (runId: string, status: JobSetState) => void;
  announce: (text: string) => void;
  expireSession: () => void;
}

export const useLive = create<LiveState>((set) => ({
  connected: false,
  reconnecting: false,
  synced: false,
  positions: {},
  retries: {},
  batches: {},
  activeJobSets: {},
  canvasRuns: {},
  announcement: { id: 0, text: "" },
  sessionExpired: false,
  setConnected: (connected, reconnecting = false) =>
    set({ connected, reconnecting: !connected && reconnecting, synced: false }),
  setPosition: (jobId, position) =>
    set((s) => {
      const positions = { ...s.positions };
      if (position === undefined) delete positions[jobId];
      else positions[jobId] = position;
      return { positions };
    }),
  setRetry: (jobId, retry) =>
    set((s) => {
      if (!retry && !(jobId in s.retries)) return s;
      const retries = { ...s.retries };
      if (retry) retries[jobId] = retry;
      else delete retries[jobId];
      return { retries };
    }),
  setBatch: (jobSetId, batch) =>
    set((s) => {
      if (!batch && !(jobSetId in s.batches)) return s;
      const batches = { ...s.batches };
      if (batch) batches[jobSetId] = batch;
      else delete batches[jobSetId];
      return { batches };
    }),
  clearBatches: () => set({ batches: {} }),
  // A canvas run that settled while the stream was down sends nothing more, so the snapshot
  // drops them all; one still going says so again on its next update.
  resetActive: (ids) =>
    set({
      activeJobSets: Object.fromEntries(ids.map((id) => [id, true] as const)),
      canvasRuns: {},
      synced: true,
    }),
  setJobSetActive: (jobSetId, active) =>
    set((s) => {
      if (active === jobSetId in s.activeJobSets) return s;
      const activeJobSets = { ...s.activeJobSets };
      if (active) activeJobSets[jobSetId] = true;
      else delete activeJobSets[jobSetId];
      return { activeJobSets };
    }),
  setCanvasRun: (runId, status) =>
    set((s) => {
      const active = !isTerminalState(status);
      if (active === runId in s.canvasRuns) return s;
      const canvasRuns = { ...s.canvasRuns };
      if (active) canvasRuns[runId] = true;
      else delete canvasRuns[runId];
      return { canvasRuns };
    }),
  announce: (text) => set((s) => ({ announcement: { id: s.announcement.id + 1, text } })),
  expireSession: () => set({ sessionExpired: true }),
}));

export const announce = (text: string) => useLive.getState().announce(text);

/** The stream is up and its snapshot is in, so what this tab knows about runs is current. */
export const selectInSync = (s: LiveState): boolean => s.connected && s.synced;

/**
 * Something is being made right now: a run, a Batch run waiting at a company, or a canvas run.
 * Only while in sync, since otherwise this tab can't know when it ends.
 */
export const selectGenerating = (s: LiveState): boolean =>
  selectInSync(s) && [s.activeJobSets, s.batches, s.canvasRuns].some((ids) => Object.keys(ids).length > 0);

export const useIsGenerating = () => useLive(selectGenerating);

interface DismissedState {
  jobs: string[];
  dismiss: (jobIds: readonly string[]) => void;
}

/** Failed tiles stay until dismissed (§2.4). Kept per browser; the run itself isn't touched. */
export const useDismissed = create<DismissedState>()(
  persist(
    (set) => ({
      jobs: [],
      // Only the latest few hundred matter: older runs have scrolled out of the feed.
      dismiss: (ids) => set((s) => ({ jobs: [...new Set([...s.jobs, ...ids])].slice(-500) })),
    }),
    { name: "openfield.dismissed", storage: safeStorage() },
  ),
);

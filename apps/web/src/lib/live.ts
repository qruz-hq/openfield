import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeStorage } from "./storage";

// Client state that isn't server data: whether the event stream is up, queue positions it
// reports, failed tiles the person dismissed, and the message for screen readers.

interface LiveState {
  /** The event stream is connected. When it isn't, the feed polls every 2 s. */
  connected: boolean;
  /** The stream dropped, or failed to connect twice in a row (§8.4.6). */
  reconnecting: boolean;
  /** Runs ahead of each waiting job, from job.queued. */
  positions: Record<string, number>;
  /** Jobs waiting out a retry, from job.queued: when they go again, and whether Flex was busy. */
  retries: Record<string, { at: string; busy: boolean }>;
  /** One polite announcement per run (§2.11). The id makes a repeat message re-announce. */
  announcement: { id: number; text: string };
  /** The server restarted with a new session token, so this page has to reload. */
  sessionExpired: boolean;
  setConnected: (connected: boolean, reconnecting?: boolean) => void;
  setPosition: (jobId: string, position: number | undefined) => void;
  setRetry: (jobId: string, retry: { at: string; busy: boolean } | undefined) => void;
  announce: (text: string) => void;
  expireSession: () => void;
}

export const useLive = create<LiveState>((set) => ({
  connected: false,
  reconnecting: false,
  positions: {},
  retries: {},
  announcement: { id: 0, text: "" },
  sessionExpired: false,
  setConnected: (connected, reconnecting = false) =>
    set({ connected, reconnecting: !connected && reconnecting }),
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
  announce: (text) => set((s) => ({ announcement: { id: s.announcement.id + 1, text } })),
  expireSession: () => set({ sessionExpired: true }),
}));

export const announce = (text: string) => useLive.getState().announce(text);

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

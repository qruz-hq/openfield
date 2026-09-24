import type { CanvasDetail, CanvasPatchBody } from "@openfield/core";
import type { CanvasStore } from "../store";
import type { SaveFailure } from "../store/types";

// Autosave (§7.8): 800 ms after the last change, at least every 10 s while changes keep coming,
// and at once on blur, hide, route change and reload. Pans and zooms ride along with the next save
// or go out after 2 s of quiet. One PATCH at a time; a 409 hands the server's copy to the banner and
// stops saving until the person picks Reload or Keep mine; a lost connection or a server hiccup
// retries with backoff. A refusal that waiting won't fix (the canvas was deleted, it's too big)
// says so and waits for the next change instead.

export const SAVE_DEBOUNCE_MS = 800;
export const SAVE_MAX_WAIT_MS = 10_000;
export const VIEW_SAVE_DELAY_MS = 2_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export type SaveOutcome =
  | { kind: "saved"; graphVersion: number; updatedAt: string }
  | { kind: "conflict"; server: CanvasDetail }
  /** Couldn't reach the server, or it had a problem of its own that may pass. */
  | { kind: "retry" }
  /** Refused, and it would be again: the canvas is gone, too big, or the save didn't fit. */
  | { kind: "failed"; failure: SaveFailure };

export interface AutosaveDeps {
  save(body: CanvasPatchBody, opts: { keepalive: boolean }): Promise<SaveOutcome>;
  /** Called after a successful save, e.g. to refresh the canvas preview. */
  onSaved?(): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Autosave {
  /** Saves now if anything is unsaved, and resolves once the server has it (or can't). */
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  /** Stops listening; call flush first to keep the last changes. */
  dispose(): void;
}

export function createAutosave(store: CanvasStore, deps: AutosaveDeps): Autosave {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let dirtySince: number | null = null;
  let failures = 0;
  let disposed = false;
  /** The revision a save was refused for good at: nothing more goes out until the next change. */
  let refusedAt: number | null = null;
  const refused = () => refusedAt !== null && refusedAt === store.getState().persist.revision;
  let savedName = store.getState().doc.name;

  const docDirty = () => {
    const { persist } = store.getState();
    return persist.revision !== persist.savedRevision;
  };
  const viewDirty = () => {
    const { persist } = store.getState();
    return persist.viewRevision !== persist.savedViewRevision;
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (delay?: number) => {
    if (disposed || store.getState().persist.status === "conflict" || refused()) return;
    cancelTimer();
    if (!docDirty() && !viewDirty()) {
      dirtySince = null;
      return;
    }
    let wait = delay;
    if (wait === undefined) {
      if (docDirty()) {
        dirtySince ??= now();
        wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, dirtySince + SAVE_MAX_WAIT_MS - now()));
      } else wait = VIEW_SAVE_DELAY_MS;
    }
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, wait);
  };

  const run = async (keepalive: boolean): Promise<void> => {
    if (disposed) return;
    const state = store.getState();
    if (state.persist.status === "conflict" || state.ui.readOnly || refused()) return;
    if (!docDirty() && !viewDirty()) return;
    const snap = state.actions.snapshot();
    const name = state.doc.name.trim();
    const body: CanvasPatchBody = {
      graph: snap.document,
      graphVersion: snap.graphVersion,
      ...(name && name !== savedName && { name }),
    };
    dirtySince = null;
    state.actions.markSaving();
    let outcome: SaveOutcome;
    try {
      outcome = await deps.save(body, { keepalive });
    } catch {
      outcome = { kind: "retry" };
    }
    const actions = store.getState().actions;
    if (outcome.kind === "saved") {
      failures = 0;
      if (body.name) savedName = body.name;
      actions.markSaved({
        graphVersion: outcome.graphVersion,
        updatedAt: outcome.updatedAt,
        revision: snap.revision,
        viewRevision: snap.viewRevision,
      });
      deps.onSaved?.();
    } else if (outcome.kind === "conflict") {
      failures = 0;
      actions.markConflict(outcome.server);
    } else if (outcome.kind === "failed") {
      failures = 0;
      refusedAt = snap.revision;
      actions.markFailed(outcome.failure);
    } else {
      actions.markOffline();
      failures++;
      schedule(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1)));
    }
  };

  // Saves run one after another; each looks at the store when its turn comes, so a flush always
  // covers every change made before it was called.
  const flush = (opts: { keepalive?: boolean } = {}): Promise<void> => {
    cancelTimer();
    const turn: Promise<void> = (inflight ?? Promise.resolve())
      .then(() => run(opts.keepalive ?? false))
      .finally(() => {
        if (inflight !== turn) return;
        inflight = null;
        if (failures === 0) schedule();
      });
    inflight = turn;
    return turn;
  };

  const unsubscribe = store.subscribe((next, prev) => {
    const a = next.persist;
    const b = prev.persist;
    const leftConflict = b.status === "conflict" && a.status !== "conflict";
    if (leftConflict) {
      // Reload or Keep mine: the server's copy is the baseline again, name included.
      failures = 0;
      savedName = b.conflict?.name ?? next.doc.name;
    }
    const changed = a.revision !== b.revision || a.viewRevision !== b.viewRevision;
    // While offline the backoff timer owns the next attempt.
    if ((changed || leftConflict) && !inflight && failures === 0) schedule();
  });

  return {
    flush,
    dispose() {
      disposed = true;
      cancelTimer();
      unsubscribe();
    },
  };
}

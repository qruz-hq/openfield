import type { CanvasOp } from "./ops";

// Undo and redo (§7.8): 100 entries, and continuous gestures coalesce into one. A drag passes a key
// unique to the gesture; typing passes one key per field and merges while the pauses stay under 500 ms.

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 500;

export interface HistoryEntry {
  /** What the entry did, for a future history menu ("Move 3 nodes"). */
  label?: string;
  ops: CanvasOp[];
  /** Applying these, in order, undoes `ops`. */
  inverse: CanvasOp[];
  coalesce?: string;
  /** When the entry last grew, for the coalescing window. */
  at: number;
  /** How long this entry keeps merging after `at`. */
  windowMs: number;
}

export interface History {
  past: readonly HistoryEntry[];
  future: readonly HistoryEntry[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

export interface PushOptions {
  label?: string;
  coalesce?: string;
  /** Infinity for a gesture that ends on its own (a drag); default 500 ms. */
  coalesceMs?: number;
  /**
   * Keep the redo stack. For changes nobody made by hand, like a run's results landing, which
   * mustn't take away a redo the person is about to press.
   */
  keepRedo?: boolean;
}

/** Records a change. A change made by hand clears redo. */
export function pushEntry(
  history: History,
  ops: CanvasOp[],
  inverse: CanvasOp[],
  now: number,
  opts: PushOptions = {},
): History {
  const past = [...history.past];
  const top = past[past.length - 1];
  if (opts.coalesce && top?.coalesce === opts.coalesce && now - top.at <= top.windowMs) {
    // The newest inverse runs first, then the older one.
    past[past.length - 1] = {
      ...top,
      ops: [...top.ops, ...ops],
      inverse: [...inverse, ...top.inverse],
      at: now,
    };
  } else {
    past.push({
      label: opts.label,
      ops,
      inverse,
      coalesce: opts.coalesce,
      at: now,
      windowMs: opts.coalesceMs ?? COALESCE_MS,
    });
    if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  }
  return { past, future: opts.keepRedo ? history.future : [] };
}

/** Stops the top entry from merging with the next change, e.g. when a drag ends. */
export function sealTop(history: History): History {
  const top = history.past[history.past.length - 1];
  if (!top?.coalesce) return history;
  return { ...history, past: [...history.past.slice(0, -1), { ...top, coalesce: undefined }] };
}

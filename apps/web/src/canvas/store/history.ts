import type { CanvasOp } from "@openfield/canvas/store/ops";

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
    past[past.length - 1] = { ...top, ...mergeOps(top, ops, inverse), at: now };
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

/**
 * Grows a coalescing entry by one change. The newest inverse runs first, then the older one. A drag
 * sends a moveNode per node every frame: each replaces that node's earlier move at the end of the
 * entry and the first inverse stays, so the entry holds one move per node however long the drag.
 */
function mergeOps(
  top: HistoryEntry,
  ops: CanvasOp[],
  inverse: CanvasOp[],
): Pick<HistoryEntry, "ops" | "inverse"> {
  if (!ops.every((op) => op.op === "moveNode")) {
    return { ops: [...top.ops, ...ops], inverse: [...inverse, ...top.inverse] };
  }
  // A move only sets a position, so inside the run of moves that ends the entry a node's later move
  // replaces its earlier one, and the run's oldest inverse alone puts the node back.
  const tail = new Map<string, number>();
  for (let i = top.ops.length - 1; i >= 0; i--) {
    const op = top.ops[i]!;
    if (op.op !== "moveNode") break;
    if (!tail.has(op.id)) tail.set(op.id, i);
  }
  const undone = new Set<string>();
  for (const op of top.inverse) {
    if (op.op !== "moveNode") break;
    undone.add(op.id);
  }
  const merged = [...top.ops];
  for (const op of ops) {
    if (op.op !== "moveNode") continue;
    const at = tail.get(op.id);
    if (at === undefined) {
      tail.set(op.id, merged.length);
      merged.push(op);
    } else merged[at] = op;
  }
  const fresh = inverse.filter((op) => op.op !== "moveNode" || !undone.has(op.id));
  return { ops: merged, inverse: fresh.length ? [...fresh, ...top.inverse] : top.inverse };
}

/** Stops the top entry from merging with the next change, e.g. when a drag ends. */
export function sealTop(history: History): History {
  const top = history.past[history.past.length - 1];
  if (!top?.coalesce) return history;
  return { ...history, past: [...history.past.slice(0, -1), { ...top, coalesce: undefined }] };
}

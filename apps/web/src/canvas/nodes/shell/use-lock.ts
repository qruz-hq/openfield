import type { CanvasOp } from "@openfield/canvas/store/ops";
import { useMemo } from "react";
import { toggleLockOps, unlockOps } from "../../editor/locks";
import { useSessionOptional } from "../../editor/session";
import { useCanvasStoreApi } from "../../store/context";

/**
 * Lock and Unlock for one node (§7.9), from its menu and its side sheet. One undo step, saved at
 * once so a run started right after already sees it.
 */
export function useLockActions(id: string) {
  const store = useCanvasStoreApi();
  const session = useSessionOptional();
  return useMemo(() => {
    const apply = (ops: CanvasOp[]) => {
      if (!ops.length) return;
      if (store.getState().actions.apply(ops, { label: "lock" }).ok) void session?.autosave.flush();
    };
    return {
      toggle: () => apply(toggleLockOps(store.getState().doc, [id])),
      unlock: () => apply(unlockOps(store.getState().doc, [id])),
    };
  }, [store, session, id]);
}

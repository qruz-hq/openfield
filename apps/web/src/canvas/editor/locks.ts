import { nodeTitle } from "@openfield/canvas/engine/describe";
import type { NodeRegistry } from "@openfield/canvas/nodes/registry";
import { containedIn, isLocked, lockedBy } from "@openfield/canvas/store/graph";
import type { CanvasOp, DocSlice } from "@openfield/canvas/store/ops";
import { t } from "@openfield/core";
import type { FrameDeleteMode } from "../store/types";

// Locks (§7.9): the ops that lock or unlock what's picked, and what a delete leaves behind when it
// meets a locked node. A locked frame locks everything in it, so unlocking a node means unlocking
// the frames that lock it too.

/** Clears the node's own lock and the lock of every frame around it that holds it. */
export function unlockOps(doc: DocSlice, ids: readonly string[]): CanvasOp[] {
  const freed = new Set<string>();
  for (const id of ids) {
    for (let at = lockedBy(doc, id); at !== null; ) {
      freed.add(at);
      const parent = doc.nodes[at]?.parentId ?? null;
      at = parent === null ? null : lockedBy(doc, parent);
    }
  }
  return [...freed].map((id): CanvasOp => ({ op: "setLocked", id, locked: false }));
}

/**
 * ⇧⌘L and Lock in the menu: when everything picked is locked, unlock it; otherwise lock what isn't.
 * A node whose frame is picked too is locked by that frame alone.
 */
export function toggleLockOps(doc: DocSlice, ids: readonly string[]): CanvasOp[] {
  const picked = ids.filter((id) => doc.nodes[id]);
  if (!picked.length) return [];
  if (picked.every((id) => isLocked(doc, id))) return unlockOps(doc, picked);
  const inside = new Set(picked.flatMap((id) => containedIn(doc, id)));
  return picked
    .filter((id) => !inside.has(id) && !isLocked(doc, id))
    .map((id): CanvasOp => ({ op: "setLocked", id, locked: true }));
}

/**
 * The locked nodes a delete of `ids` has to leave where they are: those picked, and with
 * "with-contents" those inside a picked frame. Only the outermost of each group, since a locked
 * frame keeps what's in it.
 */
export function lockedToKeep(doc: DocSlice, ids: readonly string[], mode: FrameDeleteMode): string[] {
  const reached = new Set<string>();
  for (const id of ids) {
    if (!doc.nodes[id]) continue;
    reached.add(id);
    if (mode === "with-contents") for (const inner of containedIn(doc, id)) reached.add(inner);
  }
  return doc.order.filter((id) => {
    if (!reached.has(id) || !isLocked(doc, id)) return false;
    const parent = doc.nodes[id]!.parentId;
    return !(parent !== null && reached.has(parent) && isLocked(doc, parent));
  });
}

/** The toast after a delete that left locked nodes in place (design u47ehv). */
export function stayedMessage(doc: DocSlice, registry: NodeRegistry, kept: readonly string[]): string {
  const [id] = kept;
  const frame = id !== undefined ? doc.nodes[id] : undefined;
  if (kept.length !== 1 || !frame) return t("canvas.lock.stayedMany", { count: kept.length });
  const name = nodeTitle(frame, registry);
  return lockedBy(doc, id!) === id
    ? t("canvas.lock.stayed", { name })
    : t("canvas.lock.stayedInFrame", { name });
}

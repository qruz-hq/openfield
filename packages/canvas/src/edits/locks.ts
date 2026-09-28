import { canonicalJson, t } from "@openfield/core";
import { nodeTitle } from "../engine/describe";
import type { NodeRegistry } from "../nodes/registry";
import { isLocked, lockedBy } from "../store/graph";
import type { DocSlice } from "../store/ops";

// Locked nodes (§7.9) stay exactly as they are when a change comes from outside the editor, an
// agent's or a script's. Connections into and out of them are fine; changing, moving or deleting
// one, locking or unlocking anything, or putting a node into a locked frame is for the person
// alone. Restoring a version is held to the same rule.

export interface LockProblem {
  nodeId: string;
  /** Says it's locked, that only the person can unlock it, and what's still allowed. */
  message: string;
}

/** The first locked node the change from `before` to `after` would touch, or null when it's fine. */
export function lockProblem(before: DocSlice, after: DocSlice, registry: NodeRegistry): LockProblem | null {
  const content = (doc: DocSlice, nodeId: string) =>
    doc.nodes[nodeId]
      ? canonicalJson({
          frame: doc.nodes[nodeId],
          params: doc.params[nodeId] ?? null,
          result: doc.results[nodeId] ?? null,
        })
      : null;
  const title = (doc: DocSlice, nodeId: string) => nodeTitle(doc.nodes[nodeId]!, registry);

  for (const nodeId of before.order) {
    const by = lockedBy(before, nodeId);
    if (by === null || content(before, nodeId) === content(after, nodeId)) continue;
    const node = title(before, nodeId);
    return {
      nodeId,
      message:
        by === nodeId
          ? t("canvas.edits.locked", { node })
          : t("canvas.edits.lockedByFrame", { node, frame: title(before, by) }),
    };
  }
  for (const nodeId of after.order) {
    if (!isLocked(after, nodeId) || isLocked(before, nodeId)) continue;
    const by = lockedBy(after, nodeId)!;
    return {
      nodeId,
      message:
        by === nodeId
          ? t("canvas.edits.lockOnlyPerson", { node: title(after, nodeId) })
          : t("canvas.edits.lockedFrame", { frame: title(after, by) }),
    };
  }
  return null;
}

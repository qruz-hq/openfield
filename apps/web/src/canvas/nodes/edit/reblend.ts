import { planFingerprints, resolveFingerprints } from "@openfield/canvas/engine/fingerprint";
import {
  canReblend,
  type EditKeepRest,
  editKeepRestOf,
  keepRestBody,
  keptEditsOf,
  type ReblendSwap,
  reblendOps,
  sameKeepRest,
} from "@openfield/canvas/nodes/edit/keep-rest";
import { editSpec } from "@openfield/canvas/nodes/edit/spec";
import { isLocked } from "@openfield/canvas/store/graph";
import type { DocSlice } from "@openfield/canvas/store/ops";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../../../api/raw";
import { notifyError } from "../../../lib/notify";
import { useEngineStore } from "../../engine/engine-store";
import { useCanvasStoreApi } from "../../store/context";
import type { CanvasStore } from "../../store/store";
import { nodeRegistry } from "../registry";
import { keptEditOf, reblendImages, saveModelResults } from "./keep-rest-api";

// Changing how an Edit node keeps the rest after it ran (§0.9): its images are blended again on the
// server, for free, and the node stays done while the nodes after it go out of date. Undo, redo or
// a change from another tab can put other settings back on a node that's still up to date; the
// sync then blends its images to match, so an up-to-date node always shows its own settings.

/** The settings each Edit node's images were last blended with, per open canvas. */
const blended = new WeakMap<CanvasStore, Map<string, EditKeepRest>>();

function blendedOf(store: CanvasStore): Map<string, EditKeepRest> {
  let map = blended.get(store);
  if (!map) {
    map = new Map();
    blended.set(store, map);
  }
  return map;
}

/** Whether a change to how this node keeps the rest is free right now. */
export function reblendable(store: CanvasStore, nodeId: string): boolean {
  const { doc, fingerprints } = store.getState();
  const analysis = useEngineStore.getState().analysis.nodes[nodeId];
  return canReblend(doc, nodeId, fingerprints[nodeId], analysis?.inputsChanged ?? false);
}

/**
 * Commits a change to how the node keeps the rest. Free when the node is up to date: the images are
 * blended first (turned off, the model's own results are saved as new images and stand in; turned
 * on again, the kept edits come back), and only then is the change written, as one undo step.
 * Anything else is an ordinary setting for the next Run. False when the blend failed: nothing changed.
 */
export function useKeepRestCommit(nodeId: string) {
  const store = useCanvasStoreApi();
  const [busy, setBusy] = useState(false);
  const commit = useCallback(
    async (patch: Record<string, unknown>, label: string, opts: { fixes?: Blob } = {}): Promise<boolean> => {
      const { doc, actions } = store.getState();
      const ctx = useEngineStore.getState().ctx;
      const next = editKeepRestOf({ ...doc.params[nodeId], ...patch }, ctx);
      const result = doc.results[nodeId];
      if (!result || !reblendable(store, nodeId)) {
        actions.apply([{ op: "setParams", id: nodeId, patch }], { label });
        return true;
      }
      const before = editKeepRestOf(doc.params[nodeId] ?? {}, ctx);
      // Off already: it shows the model's own results, which only Run or the switch changes.
      if (!next.keep && !before.keep) {
        actions.apply([{ op: "setParams", id: nodeId, patch }], { label });
        return true;
      }
      setBusy(true);
      let swap: ReblendSwap | undefined;
      try {
        if (!next.keep) {
          // Off after a run: the model's own results, saved as images of their own, stand in.
          const saved = await saveModelResults(result.assetIds, opts.fixes);
          swap = { assetIds: saved, keptEdits: result.assetIds };
        } else {
          // On again: back to the kept edits it was showing (the result says, or the saved image).
          const kept = before.keep ? [] : keptEditsOf(result);
          const targets = await Promise.all(
            result.assetIds.map((id, i) => kept[i] ?? (before.keep ? id : keptEditOf(id))),
          );
          await reblendImages(targets, keepRestBody(next), opts.fixes);
          if (targets.some((id, i) => id !== result.assetIds[i])) swap = { assetIds: targets };
        }
      } catch (error) {
        notifyError(errorMessage(error));
        return false;
      } finally {
        setBusy(false);
      }
      const now = store.getState();
      blendedOf(store).set(nodeId, next);
      // A run that landed meanwhile made new images: the setting waits for the next Run like any other.
      if (now.doc.results[nodeId] !== result) {
        now.actions.apply([{ op: "setParams", id: nodeId, patch }], { label });
        return true;
      }
      now.actions.apply(
        await reblendOps(now.doc, nodeRegistry, ctx, nodeId, patch, { ...(swap && { swap }) }),
        {
          label,
        },
      );
      return true;
    },
    [store, nodeId],
  );
  return { commit, busy };
}

/** Edit nodes that have images to keep the rest of, with the settings they have now. */
function editNodes(doc: DocSlice): [string, EditKeepRest][] {
  const ctx = useEngineStore.getState().ctx;
  const out: [string, EditKeepRest][] = [];
  for (const id of doc.order) {
    const result = doc.results[id];
    if (doc.nodes[id]?.type !== editSpec.type || !result?.assetIds.length) continue;
    out.push([id, editKeepRestOf(doc.params[id] ?? {}, ctx)]);
  }
  return out;
}

/**
 * Keeps up-to-date Edit nodes' images in step with their settings when the settings change some
 * other way than the inspector (undo, redo, another tab). Mounted once per open canvas.
 */
export function useKeepRestSync(): void {
  const store = useCanvasStoreApi();
  useEffect(() => {
    const known = blendedOf(store);
    for (const [id, k] of editNodes(store.getState().doc)) known.set(id, k);
    return store.subscribe((next, prev) => {
      if (next.doc.params === prev.doc.params && next.doc.results === prev.doc.results) return;
      const changed: [string, EditKeepRest][] = [];
      for (const [id, k] of editNodes(next.doc)) {
        const was = known.get(id);
        known.set(id, k);
        if (was && !sameKeepRest(was, k) && k.keep && !isLocked(next.doc, id)) changed.push([id, k]);
      }
      if (changed.length) void settle(store, changed);
    });
  }, [store]);
}

async function settle(store: CanvasStore, changed: readonly [string, EditKeepRest][]): Promise<void> {
  const { doc } = store.getState();
  const ctx = useEngineStore.getState().ctx;
  const fingerprints = await resolveFingerprints(planFingerprints(doc, nodeRegistry, ctx), new Map());
  for (const [id, k] of changed) {
    const result = doc.results[id];
    // Only a node that's up to date with these settings shows them; any other waits for its Run.
    if (!result || result.fingerprint !== fingerprints[id]) continue;
    try {
      await reblendImages(result.assetIds, keepRestBody(k));
    } catch (error) {
      notifyError(errorMessage(error));
    }
  }
}

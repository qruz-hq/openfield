import { useCallback, useMemo } from "react";
import { deriveDisplay, visibleBlocker } from "../../engine/display";
import { useCanvasEngineContext, useNodeAnalysis } from "../../engine/engine-store";
import type { EngineContext, NodeDisplay, RunRequest } from "../../engine/types";
import {
  useCanvasActions,
  useCanvasStoreApi,
  useNodeFingerprint,
  useNodeFrame,
  useNodeParams,
  useNodeResult,
  useNodeRuntime,
} from "../../store/context";
import type { NodeFrame } from "../../store/ops";
import type { NodeSpec } from "../params";

// What a node component reads about itself: its frame, its params as its type reads them, its
// result and live state, and what to draw. Each piece is its own store selector, so a node
// re-renders when its own data changes and at no other time (§7.10). Components get their type
// from their own spec rather than the registry, which imports them.

export function useParsedParams<P extends object>(id: string, spec: NodeSpec<P>, ctx: EngineContext): P {
  const raw = useNodeParams(id);
  return useMemo(() => spec.parseParams(raw ?? {}, ctx), [raw, spec, ctx]);
}

export function useNodeDisplay(id: string): NodeDisplay {
  const result = useNodeResult(id);
  const runtime = useNodeRuntime(id);
  const fingerprint = useNodeFingerprint(id);
  const analysis = useNodeAnalysis(id);
  return useMemo(
    () =>
      deriveDisplay({
        result,
        runtime,
        fingerprint,
        blocker: visibleBlocker(analysis?.blocker ?? null, runtime),
        fanOut: analysis?.fanOut ?? 1,
        inputsChanged: analysis?.inputsChanged ?? false,
      }),
    [result, runtime, fingerprint, analysis],
  );
}

/** Writes a node's params. Typing into one field coalesces into one undo entry (§7.8). */
export function useSetParams(id: string) {
  const actions = useCanvasActions();
  return useCallback(
    (patch: Record<string, unknown>, field?: string) =>
      actions.apply([{ op: "setParams", id, patch }], field ? { coalesce: `param:${id}:${field}` } : {}),
    [actions, id],
  );
}

/** Runs this node, or it and everything after it. */
export function useRunNode(id: string) {
  const store = useCanvasStoreApi();
  return useCallback(
    (scope: "node" | "downstream" = "node", extra: Omit<RunRequest, "scope" | "nodeIds"> = {}) =>
      store.getState().runController.run({ scope, nodeIds: [id], ...extra }),
    [store, id],
  );
}

/** The frame and engine context every node component starts from. Null for a node already gone. */
export function useNodeBasics(id: string): { frame: NodeFrame; ctx: EngineContext } | null {
  const frame = useNodeFrame(id);
  const ctx = useCanvasEngineContext();
  return frame ? { frame, ctx } : null;
}

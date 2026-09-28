import type { NodeRuntime } from "@openfield/canvas/engine/types";
import { isLocked, lockedBy } from "@openfield/canvas/store/graph";
import type { NodeFrame, NodeParams } from "@openfield/canvas/store/ops";
import type { CanvasNodeResult } from "@openfield/core/canvas";
import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { CanvasStore } from "./store";
import type { CanvasActions, CanvasState, CanvasUiState } from "./types";

// React access to the open canvas's store. Select the smallest slice you need: a node component
// that selects its own params re-renders when those change and at no other time (§7.10).

const CanvasStoreContext = createContext<CanvasStore | null>(null);

export function CanvasStoreProvider({ store, children }: { store: CanvasStore; children: ReactNode }) {
  return <CanvasStoreContext.Provider value={store}>{children}</CanvasStoreContext.Provider>;
}

/** The store itself, for event handlers that read state without subscribing (getState()). */
export function useCanvasStoreApi(): CanvasStore {
  const store = useContext(CanvasStoreContext);
  if (!store) throw new Error("useCanvasStoreApi needs a CanvasStoreProvider");
  return store;
}

export function useCanvas<T>(selector: (state: CanvasState) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}

/** For selectors that build a new array or object each time: compares one level deep. */
export function useCanvasShallow<T>(selector: (state: CanvasState) => T): T {
  return useStore(useCanvasStoreApi(), useShallow(selector));
}

/** Stable for the life of the store. */
export const useCanvasActions = (): CanvasActions => useCanvas((s) => s.actions);

export const useNodeFrame = (id: string): NodeFrame | undefined => useCanvas((s) => s.doc.nodes[id]);
export const useNodeParams = (id: string): NodeParams | undefined => useCanvas((s) => s.doc.params[id]);
export const useNodeResult = (id: string): CanvasNodeResult | null =>
  useCanvas((s) => s.doc.results[id] ?? null);
export const useNodeRuntime = (id: string): NodeRuntime | undefined => useCanvas((s) => s.runtime[id]);
export const useNodeFingerprint = (id: string): string | undefined => useCanvas((s) => s.fingerprints[id]);
export const useUi = <T,>(selector: (ui: CanvasUiState) => T): T => useCanvas((s) => selector(s.ui));
export const useReadOnly = (): boolean => useCanvas((s) => s.ui.readOnly);
/** The node that locks this one (itself or a frame around it), or null: its settings are read-only. */
export const useLockedBy = (id: string): string | null => useCanvas((s) => lockedBy(s.doc, id));
/** Locked, on its own or by its frame: it keeps its images and its settings can't change (§7.9). */
export const useLocked = (id: string): boolean => useCanvas((s) => isLocked(s.doc, id));

const NO_MISSING: ReadonlySet<string> = new Set();
const noStore = { getState: () => null, getInitialState: () => null, subscribe: () => () => {} };

/** True when this image isn't in the library. Works outside a canvas too (then always false). */
export function useAssetMissing(assetId: string): boolean {
  const store = useContext(CanvasStoreContext);
  const missing = useStore(
    (store ?? noStore) as CanvasStore,
    (s: CanvasState | null) => s?.missingAssets ?? NO_MISSING,
  );
  return missing.has(assetId);
}

import type { NodeRuntime } from "../engine/types";
import type { CanvasState } from "./types";

// Plain selectors, usable with useCanvas, useCanvasShallow or getState().

const ACTIVE_STATES = new Set<NodeRuntime["state"]>(["queued", "running"]);

/** Any node on the canvas is queued or running: the top bar shows Stop. */
export const selectAnyRunning = (state: CanvasState): boolean =>
  Object.values(state.runtime).some((r) => ACTIVE_STATES.has(r.state));

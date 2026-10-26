import type { CanvasViewport } from "@openfield/core/canvas";
import type { CanvasStore } from "../store";

// Where the view rests, for the store. Every store change wakes every selector on the canvas, and
// a pan or a scroll of the wheel ends many times a second: so the view only goes into the store
// once it has rested a moment, or at once when a save is about to read it.

/** How long the view has to rest before the store hears of it. */
export const VIEW_SETTLE_MS = 250;

export interface ViewSettle {
  /** A pan or zoom ended here. */
  moved(viewport: CanvasViewport): void;
  /** Puts a view that hasn't rested yet into the store now (before a save, or as the pane goes). */
  settle(): void;
}

export function createViewSettle(
  store: CanvasStore,
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): ViewSettle {
  let pending: CanvasViewport | null = null;
  let timer: unknown = null;

  const settle = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    const next = pending;
    pending = null;
    if (!next) return;
    const { viewport, actions } = store.getState();
    if (viewport.x === next.x && viewport.y === next.y && viewport.zoom === next.zoom) return;
    actions.setViewport(next);
  };

  return {
    moved(viewport) {
      pending = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
      if (timer !== null) timers.clear(timer);
      timer = timers.set(settle, VIEW_SETTLE_MS);
    },
    settle,
  };
}

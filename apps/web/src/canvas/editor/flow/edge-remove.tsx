import { t } from "@openfield/core";
import { EdgeLabelRenderer } from "@xyflow/react";
import { X } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useCanvasActions } from "../../store";

// The × that removes a link (design Iq51i, vaCAK): one button for the whole pane, at the midpoint of
// the hovered link, or of the selected one when it's the only link selected. Each link used to
// carry its own, and a box selection lit hundreds of them, each in its own label layer.

/** A short grace period so the pointer can travel from the line onto the × button. */
const LEAVE_MS = 120;

interface EdgeRemoveState {
  /** The link under the pointer, or the × of it. */
  hovered: string | null;
  /** Where each link that can show the × wants it: the hovered one and a lone selected one. */
  spots: Readonly<Record<string, { x: number; y: number }>>;
}

export interface EdgeRemove {
  store: StoreApi<EdgeRemoveState>;
  enter(id: string): void;
  leave(): void;
  place(id: string, x: number, y: number): void;
  clear(id: string): void;
}

export function createEdgeRemove(): EdgeRemove {
  const store = createStore<EdgeRemoveState>()(() => ({ hovered: null, spots: {} }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    store,
    enter(id) {
      clearTimeout(timer);
      if (store.getState().hovered !== id) store.setState({ hovered: id });
    },
    leave() {
      clearTimeout(timer);
      timer = setTimeout(() => store.setState({ hovered: null }), LEAVE_MS);
    },
    place(id, x, y) {
      const { spots } = store.getState();
      const at = spots[id];
      if (at?.x === x && at.y === y) return;
      store.setState({ spots: { ...spots, [id]: { x, y } } });
    },
    clear(id) {
      const { spots } = store.getState();
      if (!(id in spots)) return;
      const { [id]: _gone, ...rest } = spots;
      store.setState({ spots: rest });
    },
  };
}

/** The pane's × for links. Off the pane (the card pictures) there's none, and links show no ×. */
export const EdgeRemoveContext = createContext<EdgeRemove | null>(null);

const NO_REMOVE = createEdgeRemove();

/** True while this link is hovered (or its × is). */
export function useEdgeHovered(id: string): boolean {
  const remove = useContext(EdgeRemoveContext);
  return useStore((remove ?? NO_REMOVE).store, (s) => s.hovered === id);
}

/** The link's pointer handlers, and its claim on the × while `removable`, at (x, y). */
export function useEdgeRemove(id: string, removable: boolean, x: number, y: number) {
  const remove = useContext(EdgeRemoveContext);
  useLayoutEffect(() => {
    if (!remove) return;
    if (removable) remove.place(id, x, y);
    else remove.clear(id);
  }, [remove, id, removable, x, y]);
  useEffect(() => () => remove?.clear(id), [remove, id]);
  return {
    onPointerEnter: () => remove?.enter(id),
    onPointerLeave: () => remove?.leave(),
  };
}

/** The one × on the pane. Mounted inside React Flow, so it rides in the edge label layer. */
export function EdgeRemoveButton({ remove }: { remove: EdgeRemove }) {
  const actions = useCanvasActions();
  const hovered = useStore(remove.store, (s) => s.hovered);
  const spots = useStore(remove.store, (s) => s.spots);
  // The hovered link first; otherwise the lone selected one.
  const id = hovered && spots[hovered] ? hovered : Object.keys(spots)[0];
  if (!id) return null;
  const at = spots[id]!;
  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan pointer-events-auto absolute flex items-center gap-4"
        style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
        onPointerEnter={() => remove.enter(id)}
        onPointerLeave={remove.leave}
      >
        <button
          type="button"
          aria-label={t("canvas.editor.selection.delete")}
          onClick={(e) => {
            e.stopPropagation();
            actions.deleteEdges([id]);
          }}
          className="flex size-16 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-fg"
        >
          <X size={10} strokeWidth={2.5} aria-hidden />
        </button>
      </div>
    </EdgeLabelRenderer>
  );
}

import type { NodeRegistry } from "../nodes/registry";
import type { CanvasOp, DocSlice } from "../store/ops";
import type { CanvasStore } from "../store/store";
import type { EngineContext } from "./types";

// Saved sizes of nodes whose box follows what they show (Generate's image card, design Y5jjx).
// React Flow draws the live box (NodeDefinition.box); this keeps the saved size in step so a
// reopened canvas and its index card start at the right shape. Only a change made in this tab
// moves it: a run's image landing, a new aspect ratio or model, an undo of either. Opening the
// canvas, a reload, a thumbnail loading or the pager never saves, so a canvas open in two tabs, or
// on screens of different density, never saves over itself (every tab that sees a run land writes
// the same exact size, which the server takes as no change). No undo step of its own.

/** A saved size closer than this to the box it should be isn't worth a save. */
const TOLERANCE = 1;

export interface BoxFollower {
  /** What every node rests on now, taken as already saved: opening, or a reload. */
  seed(doc: DocSlice): void;
  /** Resizes for nodes whose resting point changed since, among `ids` (all when omitted). */
  check(doc: DocSlice, ctx: EngineContext, ids?: Iterable<string>): CanvasOp[];
  /** Nodes that changed but wait for their image's exact size. */
  waiting(): ReadonlySet<string>;
}

export function createBoxFollower(registry: NodeRegistry): BoxFollower {
  const rested = new Map<string, string>();
  const waiting = new Set<string>();
  const rest = (doc: DocSlice, id: string) => {
    const frame = doc.nodes[id];
    const def = frame ? registry.get(frame.type) : undefined;
    return frame && def?.rest ? { frame, rest: def.rest } : null;
  };
  return {
    seed(doc) {
      rested.clear();
      waiting.clear();
      for (const id of doc.order) {
        const found = rest(doc, id);
        if (found)
          rested.set(id, found.rest.key({ params: doc.params[id] ?? {}, result: doc.results[id] ?? null }));
      }
    },
    check(doc, ctx, ids = doc.order) {
      const ops: CanvasOp[] = [];
      for (const id of ids) {
        const found = rest(doc, id);
        if (!found) {
          rested.delete(id);
          waiting.delete(id);
          continue;
        }
        const params = doc.params[id] ?? {};
        const result = doc.results[id] ?? null;
        const key = found.rest.key({ params, result });
        const before = rested.get(id);
        // A node that's new here was sized when it was made (or pasted, or restored).
        if (before === undefined || before === key) {
          rested.set(id, key);
          waiting.delete(id);
          continue;
        }
        const box = found.rest.box({ frame: found.frame, params, result, ctx });
        if (!box) {
          waiting.add(id);
          continue;
        }
        rested.set(id, key);
        waiting.delete(id);
        const saved = found.frame.size;
        if (saved && Math.abs(saved.w - box.w) < TOLERANCE && Math.abs(saved.h - box.h) < TOLERANCE) continue;
        ops.push({ op: "resizeNode", id, size: box });
      }
      return ops;
    },
    waiting: () => waiting,
  };
}

/**
 * Follows the store: every committed change is checked for nodes whose params or result moved, and
 * `sizes` says when image sizes arrive for nodes still waiting on one. Returns the unsubscribe.
 */
export function followBoxes(
  store: CanvasStore,
  registry: NodeRegistry,
  context: () => EngineContext,
  sizes: (onChange: () => void) => () => void,
): () => void {
  const follower = createBoxFollower(registry);
  follower.seed(store.getState().doc);
  const write = (ops: CanvasOp[]) => {
    if (ops.length) store.getState().actions.apply(ops, { history: false });
  };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.doc === previous.doc) return;
    // Every commit counts up; a reload starts again from nothing, and is an opening.
    if (state.persist.revision <= previous.persist.revision) return follower.seed(state.doc);
    const { doc } = state;
    const moved = doc.order.filter(
      (id) =>
        doc.params[id] !== previous.doc.params[id] ||
        doc.results[id] !== previous.doc.results[id] ||
        !previous.doc.nodes[id],
    );
    const gone = previous.doc.order.filter((id) => !doc.nodes[id]);
    write(follower.check(doc, context(), [...moved, ...gone]));
  });
  const unsubscribeSizes = sizes(() => {
    if (follower.waiting().size)
      write(follower.check(store.getState().doc, context(), [...follower.waiting()]));
  });
  return () => {
    unsubscribe();
    unsubscribeSizes();
  };
}

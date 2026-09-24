import type { CanvasDetail } from "@openfield/core";
import { createStore, type StoreApi } from "zustand/vanilla";
import { idleRuntime, NOOP_RUN_CONTROLLER, type NodeRuntime } from "../engine/types";
import { fromDocument, toDocument } from "./document";
import { type CanvasFragment, containedIn, extractFragment, remapFragment } from "./graph";
import { emptyHistory, pushEntry, sealTop } from "./history";
import { applyOps, type CanvasOp, CanvasOpError, type DocSlice, lockedTargets, type Point } from "./ops";
import type {
  ApplyOptions,
  ApplyResult,
  CanvasState,
  CanvasUiState,
  FrameDeleteMode,
  PersistState,
  SelectionState,
} from "./types";
import { NOOP_VIEW_CONTROLLER } from "./types";

// One store per open canvas. Every document change goes through actions.apply, which runs the
// pure reducer, records undo, bumps the revision autosave watches and keeps the selection valid.

export type CanvasStore = StoreApi<CanvasState>;

export interface CanvasStoreOptions {
  /** A version preview: the document can't change. */
  readOnly?: boolean;
  /** Clock for undo coalescing. Tests pass their own. */
  now?: () => number;
}

const DUPLICATE_OFFSET: Point = { x: 24, y: 24 };
const ACTIVE = new Set(["queued", "running"]);

const initialUi = (readOnly: boolean): CanvasUiState => ({
  tool: "select",
  lod: "full",
  addMenu: null,
  connecting: null,
  drawer: null,
  findOpen: false,
  minimapOpen: false,
  shortcutsOpen: false,
  renamingNodeId: null,
  readOnly,
});

const initialPersist = (graphVersion: number, updatedAt: string): PersistState => ({
  graphVersion,
  revision: 0,
  savedRevision: 0,
  viewRevision: 0,
  savedViewRevision: 0,
  status: "saved",
  conflict: null,
  failure: null,
  lastSavedAt: updatedAt,
});

const emptySelection: SelectionState = { nodeIds: [], edgeIds: [] };

function loadState(detail: CanvasDetail) {
  const { slice, meta, viewport } = fromDocument(detail.graph);
  // The canvases.name column is the name of record; the document copy follows it.
  return {
    canvasId: detail.id,
    doc: { ...slice, name: detail.name },
    docMeta: meta,
    viewport,
    persist: initialPersist(detail.graphVersion, detail.updatedAt),
    history: emptyHistory(),
    selection: emptySelection,
    runtime: {},
    fingerprints: {},
    missingAssets: new Set(detail.missingAssetIds ?? []) as ReadonlySet<string>,
  };
}

/** Drops selected ids that no longer exist. Returns the same object when nothing changed. */
function pruneSelection(selection: SelectionState, doc: DocSlice): SelectionState {
  const nodeIds = selection.nodeIds.filter((id) => doc.nodes[id]);
  const edgeIds = selection.edgeIds.filter((id) => doc.edges[id]);
  if (nodeIds.length === selection.nodeIds.length && edgeIds.length === selection.edgeIds.length)
    return selection;
  return { nodeIds, edgeIds };
}

const statusAfterChange = (persist: PersistState): PersistState["status"] =>
  persist.status === "conflict" || persist.status === "offline" || persist.status === "saving"
    ? persist.status
    : "dirty";

export function createCanvasStore(detail: CanvasDetail, options: CanvasStoreOptions = {}): CanvasStore {
  const now = options.now ?? Date.now;

  return createStore<CanvasState>()((set, get) => {
    /** Runs ops through the reducer and the running-node guard, without touching history. */
    const run = (
      ops: readonly CanvasOp[],
    ): { ok: true; doc: DocSlice; inverse: CanvasOp[] } | Exclude<ApplyResult, { ok: true }> => {
      const state = get();
      if (state.ui.readOnly) return { ok: false, reason: "read_only" };
      const busy = lockedTargets(ops).filter((id) => ACTIVE.has(state.runtime[id]?.state ?? ""));
      if (busy.length) return { ok: false, reason: "running", nodeIds: [...new Set(busy)] };
      try {
        const { doc, inverse } = applyOps(state.doc, ops);
        return { ok: true, doc, inverse };
      } catch (error) {
        if (error instanceof CanvasOpError) return { ok: false, reason: "invalid", message: error.message };
        throw error;
      }
    };

    const commit = (doc: DocSlice, extra: Partial<CanvasState> = {}, select?: Partial<SelectionState>) => {
      const state = get();
      const base = select ? { ...state.selection, ...select } : state.selection;
      set({
        doc,
        selection: pruneSelection(base, doc),
        persist: {
          ...state.persist,
          revision: state.persist.revision + 1,
          status: statusAfterChange(state.persist),
        },
        ...extra,
      });
    };

    const apply = (ops: readonly CanvasOp[], opts: ApplyOptions = {}): ApplyResult => {
      if (!ops.length) return { ok: true };
      const result = run(ops);
      if (!result.ok) return result;
      const history =
        opts.history === false
          ? get().history
          : pushEntry(get().history, [...ops], result.inverse, now(), opts);
      commit(result.doc, { history }, opts.select);
      return { ok: true };
    };

    const deleteNodes = (ids: readonly string[], mode: FrameDeleteMode = "with-contents"): ApplyResult => {
      const { doc } = get();
      const doomed = new Set<string>();
      const ops: CanvasOp[] = [];
      for (const id of ids) {
        const frame = doc.nodes[id];
        if (!frame) continue;
        doomed.add(id);
        const inside = containedIn(doc, id);
        if (mode === "with-contents") {
          for (const inner of inside) doomed.add(inner);
        } else {
          // Hand direct children to this frame's own frame, keeping them where they are on screen.
          for (const child of inside.filter((c) => doc.nodes[c]?.parentId === id)) {
            if (ids.includes(child)) continue;
            const c = doc.nodes[child]!;
            ops.push({
              op: "reparent",
              id: child,
              parentId: frame.parentId,
              position: { x: c.position.x + frame.position.x, y: c.position.y + frame.position.y },
            });
          }
        }
      }
      // Deepest first, so every frame is empty by the time it goes.
      const depth = (id: string) => {
        let d = 0;
        for (let at = doc.nodes[id]?.parentId ?? null; at !== null; at = doc.nodes[at]?.parentId ?? null) d++;
        return d;
      };
      const order = [...doomed].sort((a, b) => depth(b) - depth(a));
      for (const id of order) ops.push({ op: "deleteNode", id });
      return apply(ops, { label: "delete" });
    };

    const insertFragment = (
      fragment: CanvasFragment,
      place: { offset: Point } | { at: Point },
      keepForeignParents = false,
    ): string[] => {
      let offset: Point;
      if ("offset" in place) offset = place.offset;
      else {
        const top = fragment.nodes.filter((n) => n.parentId === null);
        const minX = Math.min(...top.map((n) => n.position.x));
        const minY = Math.min(...top.map((n) => n.position.y));
        offset = top.length ? { x: place.at.x - minX, y: place.at.y - minY } : { x: 0, y: 0 };
      }
      const fresh = remapFragment(fragment, offset, { keepForeignParents });
      const ops: CanvasOp[] = [
        ...fresh.nodes.map((node): CanvasOp => ({ op: "addNode", node })),
        ...fresh.edges.map((edge): CanvasOp => ({ op: "addEdge", edge })),
      ];
      const nodeIds = fresh.nodes.map((n) => n.id);
      const result = apply(ops, { label: "paste", select: { nodeIds, edgeIds: [] } });
      return result.ok ? nodeIds : [];
    };

    return {
      ...loadState(detail),
      ui: initialUi(options.readOnly ?? false),
      runController: NOOP_RUN_CONTROLLER,
      viewController: NOOP_VIEW_CONTROLLER,
      actions: {
        apply,

        undo() {
          const entry = get().history.past.at(-1);
          if (!entry) return null;
          const result = run(entry.inverse);
          if (!result.ok) return result;
          const { past, future } = get().history;
          commit(result.doc, { history: { past: past.slice(0, -1), future: [...future, entry] } });
          return { ok: true };
        },

        redo() {
          const entry = get().history.future.at(-1);
          if (!entry) return null;
          const result = run(entry.ops);
          if (!result.ok) return result;
          const { past, future } = get().history;
          commit(result.doc, {
            history: {
              past: [...past, { ...entry, inverse: result.inverse, coalesce: undefined }],
              future: future.slice(0, -1),
            },
          });
          return { ok: true };
        },

        sealHistory() {
          set({ history: sealTop(get().history) });
        },

        clearHistory() {
          set({ history: emptyHistory() });
        },

        deleteNodes,

        deleteEdges(ids) {
          const { doc } = get();
          return apply(
            ids.filter((id) => doc.edges[id]).map((id): CanvasOp => ({ op: "deleteEdge", id })),
            { label: "delete" },
          );
        },

        duplicateNodes(ids, offset = DUPLICATE_OFFSET) {
          // Duplicating a node inside a frame keeps it in that frame.
          const fragment = extractFragment(get().doc, ids, { keepParents: true });
          return insertFragment(fragment, { offset }, true);
        },

        insertFragment: (fragment, place) => insertFragment(fragment, place),

        setViewport(viewport) {
          const { persist } = get();
          set({ viewport, persist: { ...persist, viewRevision: persist.viewRevision + 1 } });
        },

        setSelection(selection) {
          set({ selection: pruneSelection({ ...get().selection, ...selection }, get().doc) });
        },

        selectAll() {
          const { doc } = get();
          set({ selection: { nodeIds: [...doc.order], edgeIds: [] } });
        },

        clearSelection() {
          set({ selection: emptySelection });
        },

        setUi(patch) {
          set({ ui: { ...get().ui, ...patch } });
        },

        openAddMenu(menu) {
          set({ ui: { ...get().ui, addMenu: menu } });
        },

        closeAddMenu() {
          set({ ui: { ...get().ui, addMenu: null, connecting: null } });
        },

        openInspector(nodeId) {
          set({ ui: { ...get().ui, drawer: { panel: "inspector", nodeId } } });
        },

        closeDrawer() {
          set({ ui: { ...get().ui, drawer: null } });
        },

        setRuntime(updates) {
          const runtime: Record<string, NodeRuntime> = { ...get().runtime };
          for (const [id, patch] of Object.entries(updates)) {
            if (patch === null) delete runtime[id];
            else runtime[id] = { ...(runtime[id] ?? idleRuntime()), ...patch };
          }
          set({ runtime });
        },

        setFingerprints(next) {
          set({ fingerprints: next });
        },

        installRunController(controller) {
          set({ runController: controller });
        },

        installViewController(controller) {
          set({ viewController: controller });
        },

        loadDetail(next) {
          const { runtime, missingAssets } = get();
          const loaded = loadState(next);
          // Runs carry on across a Reload or a restore: nodes still there keep their live state, so
          // a running one still looks it, and still refuses delete, until the next frame lands.
          const kept = Object.fromEntries(Object.entries(runtime).filter(([id]) => loaded.doc.nodes[id]));
          set({
            ...loaded,
            runtime: kept,
            missingAssets: next.missingAssetIds ? loaded.missingAssets : missingAssets,
            ui: { ...get().ui, drawer: null, addMenu: null, connecting: null },
          });
        },

        setMissingAssets(ids) {
          const current = get().missingAssets;
          if (ids.size === current.size && [...ids].every((id) => current.has(id))) return;
          set({ missingAssets: ids });
        },

        snapshot() {
          const { doc, docMeta, viewport, persist } = get();
          return {
            document: toDocument(doc, docMeta, viewport),
            revision: persist.revision,
            viewRevision: persist.viewRevision,
            graphVersion: persist.graphVersion,
          };
        },

        markSaving() {
          const { persist } = get();
          if (persist.status === "conflict") return;
          set({ persist: { ...persist, status: "saving" } });
        },

        markSaved(saved) {
          const { persist } = get();
          const savedRevision = Math.max(persist.savedRevision, saved.revision);
          const savedViewRevision = Math.max(persist.savedViewRevision, saved.viewRevision);
          const clean = savedRevision === persist.revision && savedViewRevision === persist.viewRevision;
          set({
            persist: {
              ...persist,
              graphVersion: saved.graphVersion,
              savedRevision,
              savedViewRevision,
              status: clean ? "saved" : "dirty",
              conflict: null,
              failure: null,
              lastSavedAt: saved.updatedAt,
            },
          });
        },

        markOffline() {
          const { persist } = get();
          if (persist.status === "conflict") return;
          set({ persist: { ...persist, status: "offline" } });
        },

        markFailed(failure) {
          const { persist } = get();
          if (persist.status === "conflict") return;
          set({ persist: { ...persist, status: "failed", failure } });
        },

        markConflict(server) {
          set({ persist: { ...get().persist, status: "conflict", conflict: server } });
        },

        keepMine() {
          const { persist } = get();
          if (!persist.conflict) return;
          set({
            persist: {
              ...persist,
              graphVersion: persist.conflict.graphVersion,
              conflict: null,
              status: "dirty",
              // Forces the next save even if nothing changed since the rejected one.
              savedRevision: -1,
            },
          });
        },
      },
    };
  });
}

import type { CanvasRunScope } from "@openfield/core";
import { t } from "@openfield/core";
import type { CanvasEdge } from "@openfield/core/canvas";
import { type Connection, type ReactFlowInstance, useReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import { notify } from "../../lib/notify";
import { canConnect } from "../engine/connect";
import { useEngineStore } from "../engine/engine-store";
import { nodeRegistry } from "../nodes/registry";
import {
  type ApplyResult,
  type CanvasOp,
  type CanvasStore,
  childrenOf,
  containedIn,
  extractFragment,
  type FrameDeleteMode,
  incomingEdges,
  newEdgeId,
  type Point,
  type Size,
  useCanvasStoreApi,
} from "../store";
import type { CanvasTool } from "../store/types";
import { PASTE_STEP, parseFragment, serializeFragment } from "./clipboard";
import type { FlowEdge, FlowNode } from "./flow/adapter";
import { FIT_PADDING } from "./flow/view-controller";
import {
  type Alignment,
  alignOps,
  distributeOps,
  dropOp,
  FRAME_TYPE,
  frameAtPoint,
  groupIntoFrameOps,
  topLevelSelection,
  ungroupOps,
} from "./geometry";
import { type EditorSession, useSession } from "./session";

// What the chrome and the keyboard do to the canvas. Every command reads the store when it runs
// (never a stale render), goes through actions.apply, and says so when the store refuses: a node
// with a run in flight can't be deleted or leave its frame, and a previewed version can't change.

const ZOOM_MS = 200;
/** Deleting more than this many nodes saves a version first (§7.8). */
const SNAPSHOT_DELETE_ABOVE = 5;
const PLACEABLE = new Set<CanvasTool>(["note", "shape", "text", "frame"]);
/** The add-node menu's width, and how far above the toolbar it sits (design ahPMh). */
const ADD_MENU_WIDTH = 320;
const ADD_MENU_GAP = 12;

export type PlaceTool = "note" | "shape" | "text" | "frame";

export function createCommands(
  store: CanvasStore,
  session: EditorSession,
  rf: ReactFlowInstance<FlowNode, FlowEdge>,
) {
  const actions = () => store.getState().actions;
  /** Models and defaults, as the engine keeps them, for nodes this creates itself. */
  const engineContext = () => useEngineStore.getState().ctx;

  const toast = (message: string, duration?: number) => notify(message, duration ? { duration } : {});

  const report = (result: ApplyResult | null): boolean => {
    if (!result) return false;
    if (result.ok) return true;
    if (result.reason === "running") toast(t("canvas.editor.toasts.running"));
    else if (result.reason === "read_only") toast(t("canvas.editor.toasts.readOnly"));
    return false;
  };

  const sizeOf = (id: string): Size | undefined => {
    const node = rf.getInternalNode(id);
    const w = node?.measured.width;
    const h = node?.measured.height;
    return w && h ? { w, h } : undefined;
  };

  const paneRect = () => document.querySelector(".of-canvas .react-flow")?.getBoundingClientRect() ?? null;

  const paneCentre = (): { screen: Point; flow: Point } => {
    const box = paneRect();
    const screen = box
      ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { screen, flow: rf.screenToFlowPosition(screen) };
  };

  const pointerOnPane = (): Point | null => {
    const pointer = session.ui.getState().pointer;
    const box = paneRect();
    if (!pointer || !box) return null;
    const inside =
      pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
    return inside ? rf.screenToFlowPosition(pointer) : null;
  };

  const performDelete = async (
    nodeIds: readonly string[],
    edgeIds: readonly string[],
    mode: FrameDeleteMode,
  ) => {
    const { doc } = store.getState();
    const doomed = new Set(nodeIds);
    if (mode === "with-contents")
      for (const id of nodeIds) for (const inner of containedIn(doc, id)) doomed.add(inner);
    if (doomed.size > SNAPSHOT_DELETE_ABOVE) {
      // Snapshot first, so a big delete can be undone even after a reload.
      await session.snapshot("before_delete").catch(() => {});
    }
    if (nodeIds.length && !report(actions().deleteNodes(nodeIds, mode))) return;
    const left = edgeIds.filter((id) => store.getState().doc.edges[id]);
    if (left.length) report(actions().deleteEdges(left));
  };

  const commands = {
    toast,
    report,
    sizeOf,

    setTool(tool: CanvasTool) {
      const { ui } = store.getState();
      if (ui.readOnly && tool !== "select" && tool !== "pan") return;
      actions().setUi({ tool, renamingNodeId: null });
    },

    connect(connection: Connection) {
      const state = store.getState();
      const check = canConnect(state, connection);
      if (!check.ok) {
        if (check.reason) toast(check.reason, 2500);
        return;
      }
      const { source, sourceHandle, target, targetHandle } = connection;
      if (!sourceHandle || !targetHandle) return;
      const ops: CanvasOp[] = [];
      if (check.replaces) ops.push({ op: "deleteEdge", id: check.replaces });
      let order: number | undefined;
      if (check.kind === "data") {
        const node = state.doc.nodes[target];
        const port = node ? nodeRegistry.port(node.type, targetHandle, "in") : undefined;
        if (port?.arity === "multi") {
          const existing = incomingEdges(state.doc, target, targetHandle);
          order = existing.reduce((max, e, i) => Math.max(max, (e.order ?? i) + 1), 0);
        }
      }
      const edge: CanvasEdge = {
        id: newEdgeId(),
        source,
        sourceHandle,
        target,
        targetHandle,
        kind: check.kind,
        ...(order !== undefined && { order }),
      };
      ops.push({ op: "addEdge", edge });
      if (!report(actions().apply(ops, { label: "connect" }))) return;
      if (check.replaces) {
        notify(t("canvas.editor.toasts.replaced"), {
          action: { label: t("actions.undo"), onClick: () => report(store.getState().actions.undo()) },
        });
      }
    },

    reconnect(edgeId: string, connection: Connection) {
      const state = store.getState();
      const check = canConnect(state, connection);
      const { source, sourceHandle, target, targetHandle } = connection;
      if (!check.ok || !sourceHandle || !targetHandle) {
        if (!check.ok && check.reason) toast(check.reason, 2500);
        return;
      }
      const ops: CanvasOp[] = [];
      if (check.replaces && check.replaces !== edgeId) ops.push({ op: "deleteEdge", id: check.replaces });
      ops.push({ op: "reconnectEdge", id: edgeId, source, sourceHandle, target, targetHandle });
      report(actions().apply(ops, { label: "connect" }));
    },

    /** Drops a new annotation where the pane was clicked, inside the frame under it. */
    place(tool: PlaceTool, at: Point) {
      const state = store.getState();
      if (state.ui.readOnly || !PLACEABLE.has(tool)) return;
      const def = nodeRegistry.get(tool);
      if (!def) return;
      const size = def.size;
      const topLeft = size
        ? { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) }
        : { x: Math.round(at.x), y: Math.round(at.y - 12) };
      const parentId = tool === FRAME_TYPE ? null : frameAtPoint(state.doc, "", at, sizeOf);
      const origin = parentId
        ? (rf.getInternalNode(parentId)?.internals.positionAbsolute ?? { x: 0, y: 0 })
        : { x: 0, y: 0 };
      const node = nodeRegistry.instantiate(tool, {
        position: { x: topLeft.x - origin.x, y: topLeft.y - origin.y },
        ctx: engineContext(),
        parentId,
      });
      if (
        !report(
          actions().apply([{ op: "addNode", node }], {
            label: "add",
            select: { nodeIds: [node.id], edgeIds: [] },
          }),
        )
      )
        return;
      actions().setUi({ tool: "select", renamingNodeId: tool === FRAME_TYPE ? null : node.id });
    },

    /** Start options and anything else that adds a node in the middle of the view. */
    addAtCentre(type: string) {
      const state = store.getState();
      const def = nodeRegistry.get(type);
      if (state.ui.readOnly || !def) return null;
      const { flow } = paneCentre();
      const size = def.size ?? { w: 0, h: 0 };
      const node = nodeRegistry.instantiate(type, {
        position: { x: Math.round(flow.x - size.w / 2), y: Math.round(flow.y - size.h / 2) },
        ctx: engineContext(),
      });
      const ok = report(
        actions().apply([{ op: "addNode", node }], {
          label: "add",
          select: { nodeIds: [node.id], edgeIds: [] },
        }),
      );
      return ok ? node.id : null;
    },

    /** The + tool and A (design ahPMh): the menu above the toolbar, the node at the view's centre. */
    openAddMenu() {
      const state = store.getState();
      if (state.ui.readOnly) return;
      const { screen, flow } = paneCentre();
      const plus = document.querySelector<HTMLElement>('.of-canvas [data-canvas-toolbar] [data-tool="add"]');
      const bar = plus?.closest<HTMLElement>("[data-canvas-toolbar]");
      if (plus && bar) {
        const button = plus.getBoundingClientRect();
        const top = bar.getBoundingClientRect().top;
        actions().openAddMenu({
          flowPosition: flow,
          screenPosition: { x: button.left + button.width / 2 - ADD_MENU_WIDTH / 2, y: top - ADD_MENU_GAP },
          pending: null,
          above: true,
        });
        return;
      }
      actions().openAddMenu({ flowPosition: flow, screenPosition: screen, pending: null });
    },

    /** After a drag: nodes dropped on a frame join it; dragged out of one, they leave it. */
    dropIntoFrames(ids: readonly string[], gesture: string | null) {
      const { doc } = store.getState();
      const ops = topLevelSelection(doc, ids).flatMap((id) => {
        const op = dropOp(doc, id, sizeOf);
        return op ? [op] : [];
      });
      if (!ops.length) return;
      report(
        actions().apply(ops, {
          label: "move",
          ...(gesture && { coalesce: gesture, coalesceMs: Number.POSITIVE_INFINITY }),
        }),
      );
    },

    /** ⌫: frames that still hold nodes ask whether their nodes go too. */
    deleteSelection() {
      const { selection, doc, ui } = store.getState();
      if (ui.readOnly) return;
      const nodeIds = [...selection.nodeIds];
      if (!nodeIds.length && !selection.edgeIds.length) return;
      const framesWithNodes = nodeIds.filter(
        (id) =>
          doc.nodes[id]?.type === FRAME_TYPE && childrenOf(doc, id).some((child) => !nodeIds.includes(child)),
      );
      if (framesWithNodes.length) {
        session.ui.setState({ frameDelete: nodeIds });
        return;
      }
      void performDelete(nodeIds, selection.edgeIds, "with-contents");
    },

    confirmFrameDelete(mode: FrameDeleteMode) {
      const ids = session.ui.getState().frameDelete;
      session.ui.setState({ frameDelete: null });
      if (ids) void performDelete(ids, store.getState().selection.edgeIds, mode);
    },

    duplicateSelection() {
      const { selection, ui } = store.getState();
      if (ui.readOnly || !selection.nodeIds.length) return;
      actions().duplicateNodes(topLevelSelection(store.getState().doc, selection.nodeIds));
    },

    /** The clipboard text for the selection, or null when nothing is selected. */
    copyText(): string | null {
      const { selection, doc } = store.getState();
      if (!selection.nodeIds.length) return null;
      const fragment = extractFragment(doc, selection.nodeIds);
      session.ui.setState({ paste: null });
      return serializeFragment(fragment, session.canvasId);
    },

    paste(text: string | null | undefined): boolean {
      const state = store.getState();
      if (state.ui.readOnly) return false;
      const payload = parseFragment(text);
      if (!payload?.nodes.length) return false;
      const key = payload.nodes.map((n) => n.id).join(",");
      const sameCanvas = payload.canvasId === session.canvasId;
      const pointer = pointerOnPane();
      const top = payload.nodes.filter((n) => n.parentId === null);
      const origin = {
        x: Math.min(...top.map((n) => n.position.x)),
        y: Math.min(...top.map((n) => n.position.y)),
      };
      const base = pointer ?? (sameCanvas ? origin : paneCentre().flow);
      const last = session.ui.getState().paste;
      const repeat = last?.key === key && last.at.x === base.x && last.at.y === base.y;
      const count = repeat ? last.count + 1 : sameCanvas && !pointer ? 1 : 0;
      session.ui.setState({ paste: { key, at: base, count } });
      const at = { x: Math.round(base.x + PASTE_STEP * count), y: Math.round(base.y + PASTE_STEP * count) };
      return actions().insertFragment(payload, { at }).length > 0;
    },

    selectAll() {
      actions().selectAll();
    },

    group() {
      const state = store.getState();
      if (state.ui.readOnly) return;
      const plan = groupIntoFrameOps(
        state.doc,
        state.selection.nodeIds,
        sizeOf,
        (position, size, parentId) => ({
          ...nodeRegistry.instantiate(FRAME_TYPE, { position, ctx: engineContext(), parentId }),
          size,
        }),
      );
      if (!plan) return;
      report(actions().apply(plan.ops, { label: "group", select: { nodeIds: [plan.frameId], edgeIds: [] } }));
    },

    ungroup() {
      const state = store.getState();
      if (state.ui.readOnly) return;
      const frames = state.selection.nodeIds.filter((id) => state.doc.nodes[id]?.type === FRAME_TYPE);
      if (!frames.length) return;
      const children = frames.flatMap((id) => childrenOf(state.doc, id));
      report(
        actions().apply(ungroupOps(state.doc, frames), { label: "ungroup", select: { nodeIds: children } }),
      );
    },

    align(how: Alignment) {
      const state = store.getState();
      report(actions().apply(alignOps(state.doc, state.selection.nodeIds, how, sizeOf), { label: "align" }));
    },

    distribute(axis: "x" | "y") {
      const state = store.getState();
      report(
        actions().apply(distributeOps(state.doc, state.selection.nodeIds, axis, sizeOf), { label: "align" }),
      );
    },

    nudge(dx: number, dy: number) {
      const state = store.getState();
      if (state.ui.readOnly) return;
      const ops: CanvasOp[] = topLevelSelection(state.doc, state.selection.nodeIds).map((id) => {
        const p = state.doc.nodes[id]!.position;
        return { op: "moveNode", id, position: { x: p.x + dx, y: p.y + dy } };
      });
      report(actions().apply(ops, { label: "move", coalesce: "nudge" }));
    },

    undo() {
      report(actions().undo());
    },

    redo() {
      report(actions().redo());
    },

    zoomIn() {
      void rf.zoomIn({ duration: ZOOM_MS });
    },
    zoomOut() {
      void rf.zoomOut({ duration: ZOOM_MS });
    },
    zoomTo(level: number) {
      void rf.zoomTo(level, { duration: ZOOM_MS });
    },
    fit() {
      void rf.fitView({ padding: FIT_PADDING, duration: ZOOM_MS });
    },
    zoomToSelection() {
      const ids = store.getState().selection.nodeIds;
      if (!ids.length) return commands.fit();
      void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: FIT_PADDING, duration: ZOOM_MS });
    },

    run(scope: CanvasRunScope, bypassCache = false) {
      const { runController, selection, ui } = store.getState();
      if (!runController.ready || ui.readOnly) return;
      const ids = selection.nodeIds.filter(
        (id) => nodeRegistry.get(store.getState().doc.nodes[id]?.type ?? "")?.runnable,
      );
      if (scope === "all") return void runController.run({ scope, nodeIds: [], bypassCache });
      if (scope === "selection") {
        if (ids.length) void runController.run({ scope, nodeIds: ids, bypassCache });
        return;
      }
      // One node: the one selected. With several, ⌘⏎ runs them as a selection.
      if (ids.length === 1) void runController.run({ scope, nodeIds: ids, bypassCache });
      else if (ids.length > 1 && scope === "node")
        void runController.run({ scope: "selection", nodeIds: ids, bypassCache });
    },
  };
  return commands;
}

export type EditorCommands = ReturnType<typeof createCommands>;

export function useEditorCommands(): EditorCommands {
  const store = useCanvasStoreApi();
  const session = useSession();
  const rf = useReactFlow<FlowNode, FlowEdge>();
  return useMemo(() => createCommands(store, session, rf), [store, session, rf]);
}

import { t } from "@openfield/core";
import { cn, Menu, MenuContent, MenuItem, MenuTrigger } from "@openfield/ui";
import {
  type AriaLabelConfig,
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type NodePositionChange,
  type OnConnectStartParams,
  ReactFlow,
  SelectionMode,
  useStore as useFlowStore,
  useReactFlow,
  type Viewport,
  ViewportPortal,
} from "@xyflow/react";
import { Trash2 } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useStore as useZustand } from "zustand";
import { type ConnectionEnds, canConnect } from "../../engine/connect";
import { useCanvasEngineContext } from "../../engine/engine-store";
import { isAnnotationHandle } from "../../engine/types";
import { takeFitOnOpen } from "../../fit-on-open";
import { cardMedia } from "../../nodes/generate/card-media";
import { nodeRegistry } from "../../nodes/registry";
import {
  type CanvasOp,
  lodForZoom,
  useCanvas,
  useCanvasActions,
  useCanvasStoreApi,
  useReadOnly,
  useUi,
} from "../../store";
import { NOOP_VIEW_CONTROLLER } from "../../store/types";
import { alignToNeighbours, type Box, unionBox } from "../geometry";
import { PresenceLayer } from "../presence-layer";
import { useEditorUi, useSession } from "../session";
import { isMac } from "../shortcuts";
import { useEditorCommands } from "../use-commands";
import {
  boxesFor,
  createEdgeCache,
  createNodeCache,
  type FlowEdge,
  type FlowNode,
  type Measured,
} from "./adapter";
import { ConnectionLine, EdgeModeContext, edgeTypes } from "./edges";
import { buildNodeTypes } from "./node-types";
import { PendingEdge } from "./pending-edge";
import { createViewController, FIT_PADDING, nodeRect } from "./view-controller";

// The pane: React Flow wired to the canvas store. Our store is the source of truth; React Flow
// renders it and reports gestures, which come back here as ops (§7.8, §7.11).

const NODE_TYPES = buildNodeTypes(nodeRegistry);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Above this many edges, the cheaper curve (§7.10). */
const SIMPLE_EDGES_ABOVE = 300;
/** Alignment guides catch an edge or centre within this many screen pixels (§7.9). */
const GUIDE_PX = 4;
/** Held while dragging: no grid, no guides. ⌥ is taken by duplicate-drag. */
const freeKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac() ? e.metaKey : e.ctrlKey);

const portType = (nodeType: string, handle: string) => nodeRegistry.port(nodeType, handle)?.type;

let gestures = 0;

export interface CanvasFlowProps {
  className?: string;
}

export function CanvasFlow({ className }: CanvasFlowProps) {
  const store = useCanvasStoreApi();
  const session = useSession();
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const commands = useEditorCommands();

  const doc = useCanvas((s) => s.doc);
  const selection = useCanvas((s) => s.selection);
  const readOnly = useReadOnly();
  const tool = useUi((ui) => ui.tool);
  const findHit = useEditorUi((s) => s.findHit);

  const measured = useRef(new Map<string, Measured>());
  const [measureTick, setMeasureTick] = useState(0);
  const buildNodes = useRef(createNodeCache()).current;
  const buildEdges = useRef(createEdgeCache()).current;
  const gesture = useRef<string | null>(null);
  const [initialViewport] = useState(() => store.getState().viewport);
  // ⌘ (Ctrl elsewhere) held: drag freely, off the grid and past the guides.
  const free = useRef(false);
  const [snap, setSnap] = useState(true);

  useEffect(() => {
    const sync = (event: { metaKey: boolean; ctrlKey: boolean }) => {
      const on = freeKey(event);
      if (on === free.current) return;
      free.current = on;
      setSnap(!on);
      if (on) session.ui.setState({ guides: [] });
    };
    const reset = () => sync({ metaKey: false, ctrlKey: false });
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
    };
  }, [session]);

  // Image cards take the shape of the image they show: its size and the pager feed their box.
  const ctx = useCanvasEngineContext();
  const media = useZustand(cardMedia);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measureTick stands for the measured map; media feeds boxesFor through the store.
  const nodes = useMemo(() => {
    // Forget sizes of nodes that are gone, so a re-added id gets measured afresh.
    for (const id of measured.current.keys()) if (!doc.nodes[id]) measured.current.delete(id);
    const definition = (type: string) => nodeRegistry.get(type);
    return buildNodes({
      doc,
      selection,
      readOnly,
      tool,
      measured: measured.current,
      findHit,
      definition,
      boxOf: boxesFor(doc, definition, ctx),
    });
  }, [
    doc.nodes,
    doc.order,
    doc.params,
    doc.results,
    selection,
    readOnly,
    tool,
    findHit,
    measureTick,
    ctx,
    media,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the edge list depends on these slices only.
  const edges = useMemo(
    () => buildEdges({ doc, selection, readOnly, portType, definition: (type) => nodeRegistry.get(type) }),
    [doc.edges, doc.edgeOrder, doc.nodes, selection, readOnly],
  );

  // A canvas just made from a template or a file opens fitted to its nodes.
  useEffect(() => {
    if (takeFitOnOpen(session.canvasId)) void rf.fitView({ padding: FIT_PADDING, maxZoom: 1 });
  }, [rf, session]);

  // Pane moves and Find ask the view controller; it lives as long as this pane.
  useEffect(() => {
    const actions = store.getState().actions;
    actions.installViewController(createViewController(rf));
    return () => actions.installViewController(NOOP_VIEW_CONTROLLER);
  }, [rf, store]);

  /** Lines dragged nodes up with their neighbours (§7.9): shifts the moves and draws the guides. */
  const alignDrag = useCallback(
    (drags: NodePositionChange[]) => {
      const moving = new Set(drags.map((c) => c.id));
      const absolute = (id: string, position: { x: number; y: number }) => {
        const parentId = rf.getInternalNode(id)?.parentId;
        const parent = parentId ? rf.getInternalNode(parentId)?.internals.positionAbsolute : undefined;
        return parent ? { x: parent.x + position.x, y: parent.y + position.y } : position;
      };
      const boxes = drags.flatMap((c): Box[] => {
        const node = rf.getInternalNode(c.id);
        if (!node || !c.position) return [];
        const at = absolute(c.id, c.position);
        return [{ x: at.x, y: at.y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }];
      });
      const moved = unionBox(boxes);
      if (!moved) return;
      const insideMoving = (id: string) => {
        for (let at = rf.getInternalNode(id)?.parentId; at; at = rf.getInternalNode(at)?.parentId) {
          if (moving.has(at)) return true;
        }
        return false;
      };
      const others = rf.getNodes().flatMap((n) => {
        if (moving.has(n.id) || n.hidden || insideMoving(n.id)) return [];
        const rect = nodeRect(rf, n.id);
        return rect ? [rect] : [];
      });
      const { dx, dy, guides } = alignToNeighbours(moved, others, GUIDE_PX / rf.getZoom());
      if (dx || dy) {
        for (const c of drags) if (c.position) c.position = { x: c.position.x + dx, y: c.position.y + dy };
      }
      session.ui.setState({ guides });
    },
    [rf, session],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const drags = changes.filter(
        (c): c is NodePositionChange => c.type === "position" && !!c.position && !!c.dragging,
      );
      if (drags.length && !free.current) alignDrag(drags);
      const state = store.getState();
      const { doc: current, actions } = state;
      const moves = new Map<string, { x: number; y: number }>();
      const resizes = new Map<string, { w: number; h: number }>();
      let resizeEnded = false;
      let remeasured = false;
      let nextSelection: Set<string> | null = null;

      for (const change of changes) {
        if (change.type === "dimensions" && change.dimensions) {
          const { width, height } = change.dimensions;
          measured.current.set(change.id, { width, height });
          remeasured = true;
          if (change.resizing !== undefined) {
            resizes.set(change.id, { w: Math.round(width), h: Math.round(height) });
            if (change.resizing === false) resizeEnded = true;
          }
        } else if (change.type === "position" && change.position) {
          moves.set(change.id, change.position);
        } else if (change.type === "select") {
          nextSelection ??= new Set(state.selection.nodeIds);
          if (change.selected) nextSelection.add(change.id);
          else nextSelection.delete(change.id);
        }
      }

      const ops: CanvasOp[] = [];
      for (const [id, size] of resizes) {
        const frame = current.nodes[id];
        if (!frame) continue;
        const at = moves.get(id);
        moves.delete(id);
        const position = at ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined;
        const same =
          frame.size?.w === size.w &&
          frame.size?.h === size.h &&
          (!position || (position.x === frame.position.x && position.y === frame.position.y));
        if (!same) ops.push({ op: "resizeNode", id, size, ...(position && { position }) });
      }
      for (const [id, at] of moves) {
        const frame = current.nodes[id];
        if (!frame) continue;
        const position = { x: Math.round(at.x), y: Math.round(at.y) };
        if (position.x !== frame.position.x || position.y !== frame.position.y) {
          ops.push({ op: "moveNode", id, position });
        }
      }
      if (ops.length) {
        // A drag or resize is one undo entry however many frames it takes; arrow-key moves merge
        // while they keep coming.
        const key = gesture.current ?? (resizes.size ? `resize:${[...resizes.keys()].join(",")}` : "nudge");
        actions.apply(ops, {
          label: resizes.size ? "resize" : "move",
          coalesce: key,
          coalesceMs: gesture.current || resizes.size ? Number.POSITIVE_INFINITY : 500,
        });
      }
      if (resizeEnded) actions.sealHistory();
      if (nextSelection) actions.setSelection({ nodeIds: [...nextSelection] });
      if (remeasured) setMeasureTick((n) => n + 1);
    },
    [store, alignDrag],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      const state = store.getState();
      let next: Set<string> | null = null;
      for (const change of changes) {
        if (change.type !== "select") continue;
        next ??= new Set(state.selection.edgeIds);
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      if (next) state.actions.setSelection({ edgeIds: [...next] });
    },
    [store],
  );

  const onDragStart = useCallback(
    (event: { altKey: boolean }, dragged: FlowNode[]) => {
      gesture.current = `drag:${++gestures}`;
      // ⌥-drag leaves a copy behind and carries the originals (§7.9).
      if (event.altKey && !store.getState().ui.readOnly) {
        const ids = dragged.map((n) => n.id);
        const { actions } = store.getState();
        actions.duplicateNodes(ids, { x: 0, y: 0 });
        actions.setSelection({ nodeIds: ids });
      }
    },
    [store],
  );

  const onDragStop = useCallback(
    (_event: unknown, dragged: FlowNode[]) => {
      const key = gesture.current;
      gesture.current = null;
      session.ui.setState({ guides: [] });
      commands.dropIntoFrames(
        dragged.map((n) => n.id),
        key,
      );
      store.getState().actions.sealHistory();
    },
    [commands, session, store],
  );

  const isValidConnection = useCallback(
    (connection: Connection | FlowEdge) => canConnect(store.getState(), connection as ConnectionEnds).ok,
    [store],
  );

  const onConnectStart = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      const { nodeId, handleId, handleType } = params;
      if (!nodeId || !handleId || !handleType) return;
      if (isAnnotationHandle(handleId)) {
        session.ui.setState({ annotationConnecting: true });
        return;
      }
      const node = store.getState().doc.nodes[nodeId];
      const type = node ? portType(node.type, handleId) : undefined;
      if (!type) return;
      store.getState().actions.setUi({ connecting: { nodeId, handleId, handleType, portType: type } });
    },
    [session, store],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      commands.connect(connection);
    },
    [commands],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      session.ui.setState({ annotationConnecting: false });
      const { actions, ui } = store.getState();
      const pending = ui.connecting;
      if (state.isValid) {
        actions.setUi({ connecting: null });
        return;
      }
      const from = state.fromHandle;
      if (from && state.toHandle && state.toNode) {
        // Dropped on a port that doesn't fit: say why (§7.6 rule 3).
        const ends =
          from.type === "source"
            ? {
                source: from.nodeId,
                sourceHandle: from.id,
                target: state.toNode.id,
                targetHandle: state.toHandle.id,
              }
            : {
                source: state.toNode.id,
                sourceHandle: state.toHandle.id,
                target: from.nodeId,
                targetHandle: from.id,
              };
        const check = canConnect(store.getState(), ends);
        if (!check.ok && check.reason) commands.toast(check.reason, 2500);
        actions.setUi({ connecting: null });
        return;
      }
      const target = event.target as Element | null;
      const onPane = !!target?.classList?.contains("react-flow__pane");
      if (pending && onPane && !ui.readOnly) {
        // Dropped on empty pane: the add-node menu, filtered to what fits (§7.6).
        const point = "changedTouches" in event ? event.changedTouches[0]! : event;
        const screen = { x: point.clientX, y: point.clientY };
        actions.openAddMenu({
          flowPosition: rf.screenToFlowPosition(screen),
          screenPosition: screen,
          pending,
        });
        return;
      }
      actions.setUi({ connecting: null });
    },
    [commands, rf, session, store],
  );

  const onReconnect = useCallback(
    (old: FlowEdge, connection: Connection) => {
      commands.reconnect(old.id, connection);
    },
    [commands],
  );

  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: FlowEdge, _type: unknown, state: FinalConnectionState) => {
      // Dropping a reconnected end on empty pane removes the connection (§7.6).
      if (!state.isValid && !state.toHandle) store.getState().actions.deleteEdges([edge.id]);
    },
    [store],
  );

  const onPaneClick = useCallback(
    (event: ReactMouseEvent) => {
      // A click on the empty pane lets go of the node being edited too (§7.9 Esc and clicks away).
      const main = session.main.getState();
      if (main.ui.drawer?.panel === "inspector") main.actions.closeDrawer();
      const { ui } = store.getState();
      if (ui.tool === "note" || ui.tool === "shape" || ui.tool === "text" || ui.tool === "frame") {
        commands.place(ui.tool, rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }
    },
    [commands, rf, session, store],
  );

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as Element;
      if (!target.classList.contains("react-flow__pane")) return;
      const { actions, ui } = store.getState();
      if (ui.readOnly) return;
      const screen = { x: event.clientX, y: event.clientY };
      actions.openAddMenu({
        flowPosition: rf.screenToFlowPosition(screen),
        screenPosition: screen,
        pending: null,
      });
    },
    [rf, store],
  );

  const onMove = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      const { ui, actions } = store.getState();
      const lod = lodForZoom(viewport.zoom);
      if (lod !== ui.lod) actions.setUi({ lod });
    },
    [store],
  );

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      const { viewport: saved, actions } = store.getState();
      if (saved.x === viewport.x && saved.y === viewport.y && saved.zoom === viewport.zoom) return;
      actions.setViewport({ x: viewport.x, y: viewport.y, zoom: viewport.zoom });
    },
    [store],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      session.ui.setState({ pointer: { x: event.clientX, y: event.clientY } });
    },
    [session],
  );
  const onPointerLeave = useCallback(() => session.ui.setState({ pointer: null }), [session]);

  // A fresh canvas starts at its saved zoom level of detail.
  useEffect(() => {
    store.getState().actions.setUi({ lod: lodForZoom(initialViewport.zoom) });
  }, [initialViewport, store]);

  const placing = tool === "note" || tool === "shape" || tool === "text" || tool === "frame";
  const simpleEdges = edges.length > SIMPLE_EDGES_ABOVE;

  // Right-click on a connection: Delete (§7.6).
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const onEdgeContextMenu = useCallback(
    (event: ReactMouseEvent, edge: FlowEdge) => {
      event.preventDefault();
      if (readOnly) return;
      store.getState().actions.setSelection({ nodeIds: [], edgeIds: [edge.id] });
      setEdgeMenu({ id: edge.id, x: event.clientX, y: event.clientY });
    },
    [readOnly, store],
  );

  return (
    <EdgeModeContext.Provider value={simpleEdges}>
      <ReactFlow<FlowNode, FlowEdge>
        className={cn(className)}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={(e, _n, dragged) => onDragStart(e, dragged)}
        onNodeDragStop={(e, _n, dragged) => onDragStop(e, dragged)}
        onSelectionDragStart={onDragStart}
        onSelectionDragStop={onDragStop}
        isValidConnection={isValidConnection}
        onConnectStart={onConnectStart}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        onPaneClick={onPaneClick}
        onEdgeContextMenu={onEdgeContextMenu}
        onDoubleClick={onDoubleClick}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        connectionLineComponent={ConnectionLine}
        connectionRadius={40}
        defaultViewport={initialViewport}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        selectionOnDrag={tool === "select" && !readOnly}
        selectionMode={SelectionMode.Partial}
        panOnDrag={tool === "pan" ? true : [1, 2]}
        panOnScroll
        zoomOnPinch
        zoomActivationKeyCode={isMac() ? "Meta" : "Control"}
        panActivationKeyCode="Space"
        multiSelectionKeyCode={["Shift", isMac() ? "Meta" : "Control"]}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect
        snapToGrid={snap}
        snapGrid={[8, 8]}
        onlyRenderVisibleElements
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={ariaLabels()}
        aria-label={t("canvas.editor.pane")}
        data-placing={placing || undefined}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} offset={1} />
        <PendingEdge />
        <AlignmentGuides />
        <PresenceLayer />
      </ReactFlow>
      <EdgeMenu menu={edgeMenu} onClose={() => setEdgeMenu(null)} />
    </EdgeModeContext.Provider>
  );
}

/** React Flow's screen reader words, in the app's copy and describing the keys this editor uses. */
const ariaLabels = (): Partial<AriaLabelConfig> => ({
  // React Flow 12 reads these two the other way round: "keyboardDisabled" is the one it shows
  // while arrow keys do move nodes.
  "node.a11yDescription.keyboardDisabled": t("canvas.editor.a11y.nodeHelp"),
  "node.a11yDescription.default": t("canvas.editor.a11y.nodeHelpLocked"),
  "node.a11yDescription.ariaLiveMessage": ({ direction }) => t("canvas.editor.a11y.moved", { direction }),
  "edge.a11yDescription.default": t("canvas.editor.a11y.connectionHelp"),
  "handle.ariaLabel": t("canvas.editor.a11y.port"),
  "minimap.ariaLabel": t("canvas.editor.zoom.minimap"),
});

function EdgeMenu({
  menu,
  onClose,
}: {
  menu: { id: string; x: number; y: number } | null;
  onClose: () => void;
}) {
  const actions = useCanvasActions();
  if (!menu) return null;
  return createPortal(
    <Menu open onOpenChange={(open) => !open && onClose()}>
      <MenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={{ left: menu.x, top: menu.y }}
        />
      </MenuTrigger>
      <MenuContent align="start" side="bottom" sideOffset={0} aria-label={t("canvas.editor.edgeMenu.label")}>
        <MenuItem icon={Trash2} danger onSelect={() => actions.deleteEdges([menu.id])}>
          {t("canvas.nodes.menu.delete")}
        </MenuItem>
      </MenuContent>
    </Menu>,
    document.body,
  );
}

/** The alignment guides while a drag lines up with a neighbour: 1 px accent lines, in pane units. */
function AlignmentGuides() {
  const guides = useEditorUi((s) => s.guides);
  const zoom = useFlowStore((s) => s.transform[2]);
  if (!guides.length) return null;
  const line = 1 / zoom;
  return (
    <ViewportPortal>
      {guides.map((g) => (
        <div
          key={`${g.axis}:${g.at}`}
          aria-hidden
          className="pointer-events-none absolute bg-accent"
          style={
            g.axis === "x"
              ? { left: g.at - line / 2, top: g.from, width: line, height: g.to - g.from }
              : { top: g.at - line / 2, left: g.from, height: line, width: g.to - g.from }
          }
        />
      ))}
    </ViewportPortal>
  );
}

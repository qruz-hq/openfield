import { t } from "@openfield/core";
import type { CanvasEdge } from "@openfield/core/canvas";
import type { Edge, Node } from "@xyflow/react";
import type { PortType } from "../../engine/types";
import type { NodeDefinition } from "../../nodes/registry";
import { type DocSlice, type NodeFrame, parentsFirst, type Size } from "../../store";
import type { CanvasTool, SelectionState } from "../../store/types";

// The store's document, as React Flow's nodes and edges. Our store stays the source of truth: React
// Flow only renders and reports gestures back. Objects are cached per node and edge and reused while
// nothing about them changed, so React Flow skips them and a drag re-renders one node (§7.10).

export const UNKNOWN_NODE_TYPE = "of-unknown";
export const DATA_EDGE_TYPE = "of-data";
export const ANNOTATION_EDGE_TYPE = "of-annotation";
export const FRAME_NODE_TYPE = "frame";
/** A collapsed frame keeps its width and title and folds to this height, its nodes hidden. */
export const FRAME_COLLAPSED_HEIGHT = 40;
/** The box for a node whose type this build doesn't know and whose size wasn't saved. */
export const UNKNOWN_NODE_SIZE: Size = { w: 280, h: 160 };

type EmptyData = Record<string, never>;
export type FlowNode = Node<EmptyData>;
export interface EdgeData extends Record<string, unknown> {
  /** Image into mask: drawn with the coercion glyph (§7.6). */
  coerce: boolean;
}
export type FlowEdge = Edge<EdgeData>;

const EMPTY_DATA: EmptyData = Object.freeze({}) as EmptyData;

export interface Measured {
  width: number;
  height: number;
}

export interface FlowNodeInputs {
  doc: DocSlice;
  selection: SelectionState;
  readOnly: boolean;
  tool: CanvasTool;
  measured: ReadonlyMap<string, Measured>;
  /** The Find match in focus, ringed. */
  findHit: string | null;
  definition(type: string): NodeDefinition | undefined;
}

/** What screen readers call a node: its title, else its type's name. */
export function nodeName(frame: Pick<NodeFrame, "title" | "type">, def: NodeDefinition | undefined): string {
  return frame.title?.trim() || (def ? t(def.label) : frame.type);
}

/** True when any frame around the node is collapsed. */
export function insideCollapsed(doc: DocSlice, id: string): boolean {
  for (let at = doc.nodes[id]?.parentId ?? null, guard = 0; at !== null && guard < 10_000; guard++) {
    const frame = doc.nodes[at];
    if (!frame) return false;
    if (frame.collapsed) return true;
    at = frame.parentId;
  }
  return false;
}

/** The box React Flow gets for a node: saved size, then the type's default, then nothing (measured). */
export function flowSize(
  frame: NodeFrame,
  def: NodeDefinition | undefined,
): { width?: number; height?: number } {
  const size = frame.size ?? (def ? (def.size ?? undefined) : UNKNOWN_NODE_SIZE);
  if (!size) return {};
  if (frame.collapsed) {
    // Frames fold to a strip; data nodes draw their own 56-tall card at their width.
    return frame.type === FRAME_NODE_TYPE
      ? { width: size.w, height: FRAME_COLLAPSED_HEIGHT }
      : { width: size.w };
  }
  return { width: size.w, height: size.h };
}

interface NodeEntry {
  frame: NodeFrame;
  def: NodeDefinition | undefined;
  selected: boolean;
  hidden: boolean;
  interactive: boolean;
  hit: boolean;
  measured: Measured | undefined;
  node: FlowNode;
}

export function createNodeCache() {
  let cache = new Map<string, NodeEntry>();
  return function build(inputs: FlowNodeInputs): FlowNode[] {
    const { doc, selection, readOnly, tool, measured, findHit } = inputs;
    const selected = new Set(selection.nodeIds);
    const interactive = !readOnly && tool === "select";
    const next = new Map<string, NodeEntry>();
    const out: FlowNode[] = [];
    for (const id of parentsFirst(doc)) {
      const frame = doc.nodes[id]!;
      const def = inputs.definition(frame.type);
      const entry = {
        frame,
        def,
        selected: selected.has(id),
        hidden: insideCollapsed(doc, id),
        interactive,
        hit: findHit === id,
        measured: measured.get(id),
      };
      const old = cache.get(id);
      const same =
        old &&
        old.frame === entry.frame &&
        old.def === entry.def &&
        old.selected === entry.selected &&
        old.hidden === entry.hidden &&
        old.interactive === entry.interactive &&
        old.hit === entry.hit &&
        old.measured?.width === entry.measured?.width &&
        old.measured?.height === entry.measured?.height;
      const node = same ? old.node : toFlowNode(entry);
      next.set(id, { ...entry, node });
      out.push(node);
    }
    cache = next;
    return out;
  };
}

function toFlowNode(e: Omit<NodeEntry, "node">): FlowNode {
  const { frame, def } = e;
  const isFrame = frame.type === FRAME_NODE_TYPE;
  return {
    id: frame.id,
    type: def ? def.type : UNKNOWN_NODE_TYPE,
    position: frame.position,
    ...(frame.parentId !== null && { parentId: frame.parentId }),
    data: EMPTY_DATA,
    ...flowSize(frame, def),
    ...(e.measured && { measured: { width: e.measured.width, height: e.measured.height } }),
    selected: e.selected,
    hidden: e.hidden,
    draggable: e.interactive,
    selectable: e.interactive,
    connectable: e.interactive,
    // Delete goes through the editor, which knows about frames and running nodes.
    deletable: false,
    // Frames sit under everything, nodes inside them above them (React Flow lifts children).
    ...(isFrame && { zIndex: -1 }),
    ...(e.hit && { className: "of-find-hit" }),
    // Read out by name, never by id, in the app's words.
    ariaLabel: nodeName(frame, def),
    domAttributes: { "aria-roledescription": t("canvas.editor.a11y.node") },
  };
}

export interface FlowEdgeInputs {
  doc: DocSlice;
  selection: SelectionState;
  readOnly: boolean;
  portType(nodeType: string, handle: string): PortType | undefined;
  /** For the names screen readers give connections. */
  definition?(type: string): NodeDefinition | undefined;
}

interface EdgeEntry {
  edge: CanvasEdge;
  selected: boolean;
  readOnly: boolean;
  coerce: boolean;
  /** "Prompt to Generate". */
  name: string;
  flow: FlowEdge;
}

export function createEdgeCache() {
  let cache = new Map<string, EdgeEntry>();
  return function build(inputs: FlowEdgeInputs): FlowEdge[] {
    const { doc, selection, readOnly } = inputs;
    const selected = new Set(selection.edgeIds);
    const next = new Map<string, EdgeEntry>();
    const out: FlowEdge[] = [];
    for (const id of doc.edgeOrder) {
      const edge = doc.edges[id];
      if (!edge) continue;
      const source = doc.nodes[edge.source];
      const target = doc.nodes[edge.target];
      if (!source || !target) continue;
      const coerce =
        edge.kind === "data" &&
        inputs.portType(source.type, edge.sourceHandle) === "image" &&
        inputs.portType(target.type, edge.targetHandle) === "mask";
      const name = t("canvas.editor.a11y.connectionName", {
        from: nodeName(source, inputs.definition?.(source.type)),
        to: nodeName(target, inputs.definition?.(target.type)),
      });
      const entry = { edge, selected: selected.has(id), readOnly, coerce, name };
      const old = cache.get(id);
      const same =
        old &&
        old.edge === entry.edge &&
        old.selected === entry.selected &&
        old.readOnly === entry.readOnly &&
        old.coerce === entry.coerce &&
        old.name === entry.name;
      const flow = same ? old.flow : toFlowEdge(entry);
      next.set(id, { ...entry, flow });
      out.push(flow);
    }
    cache = next;
    return out;
  };
}

function toFlowEdge(e: Omit<EdgeEntry, "flow">): FlowEdge {
  const { edge } = e;
  const data = edge.kind === "data";
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: data ? DATA_EDGE_TYPE : ANNOTATION_EDGE_TYPE,
    selected: e.selected,
    // Arrows are notes on the canvas, never data: they're not picked with the data edges (§7.6).
    selectable: !e.readOnly,
    reconnectable: data && !e.readOnly,
    deletable: false,
    data: { coerce: e.coerce },
    ariaLabel: e.name,
    domAttributes: { "aria-roledescription": t("canvas.editor.a11y.connection") },
  };
}

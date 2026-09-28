import type { CanvasEdge, CanvasNode, CanvasNodeResult } from "@openfield/core/canvas";

// Every change to a canvas document is one of these ops, applied by one reducer (§7.9, §7.11).
// The closed set is what undo, autosave, paste, a future multiplayer layer and graph patches all
// share. applyOps is pure: it returns a new document and the ops that undo it.

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

/** A node without its params and result, which live in their own maps so typing re-renders one node. */
export type NodeFrame = Omit<CanvasNode, "params" | "result">;
export type NodeParams = Readonly<Record<string, unknown>>;

/** The document, normalized. `order` is the saved node order and the stacking order. */
export interface DocSlice {
  name: string;
  nodes: Readonly<Record<string, NodeFrame>>;
  order: readonly string[];
  params: Readonly<Record<string, NodeParams>>;
  results: Readonly<Record<string, CanvasNodeResult | null>>;
  edges: Readonly<Record<string, CanvasEdge>>;
  edgeOrder: readonly string[];
}

export type EdgeEnds = Pick<CanvasEdge, "source" | "sourceHandle" | "target" | "targetHandle">;

export type CanvasOp =
  | { op: "addNode"; node: CanvasNode; index?: number }
  /** Also removes the node's edges. A frame must be emptied first (reparent or delete its children). */
  | { op: "deleteNode"; id: string }
  | { op: "moveNode"; id: string; position: Point }
  /** position moves too when resizing from a top or left handle. */
  | { op: "resizeNode"; id: string; size: Size | undefined; position?: Point }
  /** position is relative to the new parent, as React Flow expects. */
  | { op: "reparent"; id: string; parentId: string | null; position: Point }
  | { op: "setTitle"; id: string; title: string | null }
  | { op: "setCollapsed"; id: string; collapsed: boolean }
  /** A lock keeps what the node made (§7.9); unlocking leaves no trace in the document. */
  | { op: "setLocked"; id: string; locked: boolean }
  | { op: "setPresetLocks"; id: string; locks: string[] }
  /** Shallow merge. A key set to undefined is removed. */
  | { op: "setParams"; id: string; patch: Readonly<Record<string, unknown>> }
  | { op: "setResult"; id: string; result: CanvasNodeResult | null }
  | { op: "reorderNode"; id: string; index: number }
  | { op: "addEdge"; edge: CanvasEdge; index?: number }
  | { op: "deleteEdge"; id: string }
  | ({ op: "reconnectEdge"; id: string } & EdgeEnds)
  | { op: "setEdgeOrder"; id: string; order: number | undefined }
  | { op: "setName"; name: string };

export type CanvasOpName = CanvasOp["op"];

export class CanvasOpError extends Error {
  constructor(
    message: string,
    readonly op: CanvasOp,
  ) {
    super(message);
    this.name = "CanvasOpError";
  }
}

type RecordKey = "nodes" | "params" | "results" | "edges";
type ListKey = "order" | "edgeOrder";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Copy-on-write: a map or list is copied the first time an op touches it, and only then. */
function draftOf(base: DocSlice) {
  const doc: Mutable<DocSlice> = { ...base };
  const touched = new Set<RecordKey | ListKey>();
  const rec = <K extends RecordKey>(key: K): Record<string, DocSlice[K][string]> => {
    if (!touched.has(key)) {
      (doc as Record<K, unknown>)[key] = { ...base[key] };
      touched.add(key);
    }
    return doc[key] as Record<string, DocSlice[K][string]>;
  };
  const list = (key: ListKey): string[] => {
    if (!touched.has(key)) {
      doc[key] = [...base[key]];
      touched.add(key);
    }
    return doc[key] as string[];
  };
  return { doc, rec, list };
}

const clampIndex = (index: number | undefined, length: number) =>
  index === undefined ? length : Math.max(0, Math.min(length, Math.trunc(index)));

function isInside(doc: DocSlice, id: string, ancestorId: string): boolean {
  let at = doc.nodes[id]?.parentId ?? null;
  for (let guard = 0; at !== null && guard < 10_000; guard++) {
    if (at === ancestorId) return true;
    at = doc.nodes[at]?.parentId ?? null;
  }
  return false;
}

/** Applies ops in order. Throws CanvasOpError, leaving the input untouched, when one doesn't fit. */
export function applyOps(base: DocSlice, ops: readonly CanvasOp[]): { doc: DocSlice; inverse: CanvasOp[] } {
  const { doc, rec, list } = draftOf(base);
  const groups: CanvasOp[][] = [];

  const node = (op: CanvasOp, id: string): NodeFrame => {
    const found = doc.nodes[id];
    if (!found) throw new CanvasOpError(`No node ${id}`, op);
    return found;
  };
  const edge = (op: CanvasOp, id: string): CanvasEdge => {
    const found = doc.edges[id];
    if (!found) throw new CanvasOpError(`No connection ${id}`, op);
    return found;
  };
  const setFrame = (id: string, frame: NodeFrame) => {
    rec("nodes")[id] = frame;
  };

  for (const op of ops) {
    switch (op.op) {
      case "addNode": {
        const { params, result, ...frame } = op.node;
        if (doc.nodes[frame.id]) throw new CanvasOpError(`Node ${frame.id} already exists`, op);
        if (frame.parentId !== null && !doc.nodes[frame.parentId])
          throw new CanvasOpError(`No frame ${frame.parentId}`, op);
        setFrame(frame.id, frame);
        rec("params")[frame.id] = params ?? {};
        rec("results")[frame.id] = result ?? null;
        const order = list("order");
        order.splice(clampIndex(op.index, order.length), 0, frame.id);
        groups.push([{ op: "deleteNode", id: frame.id }]);
        break;
      }
      case "deleteNode": {
        const frame = node(op, op.id);
        if (doc.order.some((id) => doc.nodes[id]?.parentId === op.id))
          throw new CanvasOpError(`Frame ${op.id} still has nodes in it`, op);
        const removed: CanvasOp[] = [];
        doc.edgeOrder.forEach((edgeId, index) => {
          const e = doc.edges[edgeId];
          if (e && (e.source === op.id || e.target === op.id))
            removed.push({ op: "addEdge", edge: e, index });
        });
        if (removed.length) {
          const gone = new Set(removed.map((r) => (r as { edge: CanvasEdge }).edge.id));
          const edges = rec("edges");
          for (const id of gone) delete edges[id];
          const edgeOrder = list("edgeOrder");
          doc.edgeOrder = edgeOrder.filter((id) => !gone.has(id));
        }
        const index = doc.order.indexOf(op.id);
        const snapshot: CanvasNode = {
          ...frame,
          params: { ...(doc.params[op.id] ?? {}) },
          result: doc.results[op.id] ?? null,
        };
        delete rec("nodes")[op.id];
        delete rec("params")[op.id];
        delete rec("results")[op.id];
        list("order").splice(index, 1);
        // Node first, then its edges at their old places (ascending, so the indices hold).
        groups.push([{ op: "addNode", node: snapshot, index }, ...removed]);
        break;
      }
      case "moveNode": {
        const frame = node(op, op.id);
        setFrame(op.id, { ...frame, position: { ...op.position } });
        groups.push([{ op: "moveNode", id: op.id, position: frame.position }]);
        break;
      }
      case "resizeNode": {
        const frame = node(op, op.id);
        setFrame(op.id, {
          ...frame,
          size: op.size ? { ...op.size } : undefined,
          ...(op.position && { position: { ...op.position } }),
        });
        groups.push([
          {
            op: "resizeNode",
            id: op.id,
            size: frame.size,
            ...(op.position && { position: frame.position }),
          },
        ]);
        break;
      }
      case "reparent": {
        const frame = node(op, op.id);
        if (op.parentId !== null) {
          if (op.parentId === op.id || !doc.nodes[op.parentId] || isInside(doc, op.parentId, op.id))
            throw new CanvasOpError(`Can't put ${op.id} inside ${op.parentId}`, op);
        }
        setFrame(op.id, { ...frame, parentId: op.parentId, position: { ...op.position } });
        groups.push([{ op: "reparent", id: op.id, parentId: frame.parentId, position: frame.position }]);
        break;
      }
      case "setTitle": {
        const frame = node(op, op.id);
        setFrame(op.id, { ...frame, title: op.title });
        groups.push([{ op: "setTitle", id: op.id, title: frame.title }]);
        break;
      }
      case "setCollapsed": {
        const frame = node(op, op.id);
        setFrame(op.id, { ...frame, collapsed: op.collapsed });
        groups.push([{ op: "setCollapsed", id: op.id, collapsed: frame.collapsed }]);
        break;
      }
      case "setLocked": {
        const frame = node(op, op.id);
        const { locked: was = false, ...rest } = frame;
        setFrame(op.id, op.locked ? { ...rest, locked: true } : rest);
        groups.push([{ op: "setLocked", id: op.id, locked: was }]);
        break;
      }
      case "setPresetLocks": {
        const frame = node(op, op.id);
        setFrame(op.id, { ...frame, presetLocks: [...op.locks] });
        groups.push([{ op: "setPresetLocks", id: op.id, locks: frame.presetLocks }]);
        break;
      }
      case "setParams": {
        node(op, op.id);
        const before = doc.params[op.id] ?? {};
        const next: Record<string, unknown> = { ...before };
        const undo: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(op.patch)) {
          undo[key] = Object.hasOwn(before, key) ? before[key] : undefined;
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        rec("params")[op.id] = next;
        groups.push([{ op: "setParams", id: op.id, patch: undo }]);
        break;
      }
      case "setResult": {
        node(op, op.id);
        const before = doc.results[op.id] ?? null;
        rec("results")[op.id] = op.result;
        groups.push([{ op: "setResult", id: op.id, result: before }]);
        break;
      }
      case "reorderNode": {
        node(op, op.id);
        const order = list("order");
        const from = order.indexOf(op.id);
        order.splice(from, 1);
        order.splice(clampIndex(op.index, order.length), 0, op.id);
        groups.push([{ op: "reorderNode", id: op.id, index: from }]);
        break;
      }
      case "addEdge": {
        const e = op.edge;
        if (doc.edges[e.id]) throw new CanvasOpError(`Connection ${e.id} already exists`, op);
        node(op, e.source);
        node(op, e.target);
        rec("edges")[e.id] = e;
        const edgeOrder = list("edgeOrder");
        edgeOrder.splice(clampIndex(op.index, edgeOrder.length), 0, e.id);
        groups.push([{ op: "deleteEdge", id: e.id }]);
        break;
      }
      case "deleteEdge": {
        const e = edge(op, op.id);
        const index = doc.edgeOrder.indexOf(op.id);
        delete rec("edges")[op.id];
        list("edgeOrder").splice(index, 1);
        groups.push([{ op: "addEdge", edge: e, index }]);
        break;
      }
      case "reconnectEdge": {
        const e = edge(op, op.id);
        node(op, op.source);
        node(op, op.target);
        const { source, sourceHandle, target, targetHandle } = op;
        rec("edges")[op.id] = { ...e, source, sourceHandle, target, targetHandle };
        groups.push([
          {
            op: "reconnectEdge",
            id: op.id,
            source: e.source,
            sourceHandle: e.sourceHandle,
            target: e.target,
            targetHandle: e.targetHandle,
          },
        ]);
        break;
      }
      case "setEdgeOrder": {
        const e = edge(op, op.id);
        const next = { ...e };
        if (op.order === undefined) delete next.order;
        else next.order = op.order;
        rec("edges")[op.id] = next;
        groups.push([{ op: "setEdgeOrder", id: op.id, order: e.order }]);
        break;
      }
      case "setName": {
        groups.push([{ op: "setName", name: doc.name }]);
        doc.name = op.name;
        break;
      }
    }
  }

  // Undo runs the groups newest first; each group keeps its own order.
  const inverse: CanvasOp[] = [];
  for (let i = groups.length - 1; i >= 0; i--) inverse.push(...groups[i]!);
  return { doc, inverse };
}

/**
 * Node ids an op would delete or move out of its frame: what a node with a run in flight refuses
 * (§7.7).
 */
export function lockedTargets(ops: readonly CanvasOp[]): string[] {
  const ids: string[] = [];
  for (const op of ops) if (op.op === "deleteNode" || op.op === "reparent") ids.push(op.id);
  return ids;
}

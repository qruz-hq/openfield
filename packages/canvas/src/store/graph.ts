import { newId } from "@openfield/core";
import type { CanvasEdge, CanvasNode } from "@openfield/core/canvas";
import type { DocSlice, Point } from "./ops";

// Read-only graph queries over the normalized document. Only data edges count as dependencies;
// annotation arrows never do (§7.7). Indices are cached per edges map, so repeated calls are cheap.

interface EdgeIndex {
  incoming: ReadonlyMap<string, readonly CanvasEdge[]>;
  outgoing: ReadonlyMap<string, readonly CanvasEdge[]>;
}

const indexCache = new WeakMap<object, EdgeIndex>();

/** Data edges by node, each list sorted by `order` then document order (the multi-input order). */
export function edgeIndex(doc: Pick<DocSlice, "edges" | "edgeOrder">): EdgeIndex {
  const cached = indexCache.get(doc.edges);
  if (cached) return cached;
  const incoming = new Map<string, CanvasEdge[]>();
  const outgoing = new Map<string, CanvasEdge[]>();
  const position = new Map(doc.edgeOrder.map((id, i) => [id, i]));
  for (const id of doc.edgeOrder) {
    const edge = doc.edges[id];
    if (edge?.kind !== "data") continue;
    const into = incoming.get(edge.target) ?? [];
    into.push(edge);
    incoming.set(edge.target, into);
    const out = outgoing.get(edge.source) ?? [];
    out.push(edge);
    outgoing.set(edge.source, out);
  }
  const byOrder = (a: CanvasEdge, b: CanvasEdge) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
    (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
  for (const list of incoming.values()) list.sort(byOrder);
  const built = { incoming, outgoing };
  indexCache.set(doc.edges, built);
  return built;
}

/** Data edges into a node, optionally one port, in input order. */
export function incomingEdges(doc: DocSlice, nodeId: string, port?: string): readonly CanvasEdge[] {
  const list = edgeIndex(doc).incoming.get(nodeId) ?? [];
  return port === undefined ? list : list.filter((e) => e.targetHandle === port);
}

export function outgoingEdges(doc: DocSlice, nodeId: string, port?: string): readonly CanvasEdge[] {
  const list = edgeIndex(doc).outgoing.get(nodeId) ?? [];
  return port === undefined ? list : list.filter((e) => e.sourceHandle === port);
}

function walk(start: string, next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(start)];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...next(id));
  }
  return seen;
}

/** Every node that feeds this one, directly or not. */
export function ancestorsOf(doc: DocSlice, nodeId: string): Set<string> {
  return walk(nodeId, (id) => incomingEdges(doc, id).map((e) => e.source));
}

/** Every node this one feeds, directly or not. */
export function descendantsOf(doc: DocSlice, nodeId: string): Set<string> {
  return walk(nodeId, (id) => outgoingEdges(doc, id).map((e) => e.target));
}

// A locked node hands on the images it keeps, so nothing above it can change what's below it. The
// two walks below stop at locked nodes (they include the lock, not what's past it); the node they
// start from is followed even when it's locked.

/** The nodes whose results can change what this one reads. */
export function feedersOf(doc: DocSlice, nodeId: string): Set<string> {
  return walk(nodeId, (id) =>
    id !== nodeId && isLocked(doc, id) ? [] : incomingEdges(doc, id).map((e) => e.source),
  );
}

/** The nodes a new result here can change. */
export function reachedBy(doc: DocSlice, nodeId: string): Set<string> {
  return walk(nodeId, (id) =>
    id !== nodeId && isLocked(doc, id) ? [] : outgoingEdges(doc, id).map((e) => e.target),
  );
}

/** True when a data edge source → target would close a loop (§7.6 rule 4). */
export function wouldCreateCycle(doc: DocSlice, source: string, target: string): boolean {
  return source === target || descendantsOf(doc, target).has(source);
}

/**
 * Kahn's algorithm over data edges, stable in document order. Nodes left in a cycle (which the
 * connect rules make impossible, but imports can carry) come back in `cyclic` and must not run.
 */
export function topoOrder(doc: DocSlice, only?: ReadonlySet<string>): { order: string[]; cyclic: string[] } {
  const ids = doc.order.filter((id) => !only || only.has(id));
  const inSet = new Set(ids);
  const indegree = new Map<string, number>();
  for (const id of ids) {
    indegree.set(id, incomingEdges(doc, id).filter((e) => inSet.has(e.source)).length);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of outgoingEdges(doc, id)) {
      if (!inSet.has(edge.target)) continue;
      const left = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, left);
      if (left === 0) ready.push(edge.target);
    }
  }
  const placed = new Set(order);
  return { order, cyclic: ids.filter((id) => !placed.has(id)) };
}

// Frames

/** Direct children of a frame, in document order. */
export function childrenOf(doc: DocSlice, frameId: string): string[] {
  return doc.order.filter((id) => doc.nodes[id]?.parentId === frameId);
}

/** Children, grandchildren and so on, deepest last. */
export function containedIn(doc: DocSlice, frameId: string): string[] {
  const out: string[] = [];
  const stack = childrenOf(doc, frameId);
  while (stack.length) {
    const id = stack.shift()!;
    out.push(id);
    stack.push(...childrenOf(doc, id));
  }
  return out;
}

/**
 * The node that locks this one: itself when it's locked, else the nearest locked frame around it,
 * else null. A locked frame locks everything in it (§7.9).
 */
export function lockedBy(doc: Pick<DocSlice, "nodes">, nodeId: string): string | null {
  for (let at: string | null = nodeId, guard = 0; at !== null && guard < 10_000; guard++) {
    const frame: DocSlice["nodes"][string] | undefined = doc.nodes[at];
    if (!frame) return null;
    if (frame.locked) return at;
    at = frame.parentId;
  }
  return null;
}

/** Locked, on its own or by a frame it's in: it keeps what it made and can't be deleted. */
export const isLocked = (doc: Pick<DocSlice, "nodes">, nodeId: string): boolean =>
  lockedBy(doc, nodeId) !== null;

/** A node's position on the pane, adding up its frames' positions. */
export function absolutePosition(doc: DocSlice, nodeId: string): Point {
  let x = 0;
  let y = 0;
  let at: string | null = nodeId;
  for (let guard = 0; at !== null && guard < 10_000; guard++) {
    const frame: DocSlice["nodes"][string] | undefined = doc.nodes[at];
    if (!frame) break;
    x += frame.position.x;
    y += frame.position.y;
    at = frame.parentId;
  }
  return { x, y };
}

/** Node ids with every frame before the nodes inside it, which React Flow requires. */
export function parentsFirst(doc: DocSlice): string[] {
  const placed = new Set<string>();
  const out: string[] = [];
  const place = (id: string, depth: number) => {
    if (placed.has(id) || depth > 10_000) return;
    const parent = doc.nodes[id]?.parentId;
    if (parent && doc.nodes[parent]) place(parent, depth + 1);
    placed.add(id);
    out.push(id);
  };
  for (const id of doc.order) place(id, 0);
  return out;
}

// Fragments: copy, cut, paste and duplicate (§7.9)

/** Clipboard payload, as application/json and as text/plain, so paste works across canvases and windows. */
export const CANVAS_FRAGMENT_KIND = "openfield.canvas.fragment/1";

export interface CanvasFragment {
  kind: typeof CANVAS_FRAGMENT_KIND;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export function isCanvasFragment(value: unknown): value is CanvasFragment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CanvasFragment>;
  return v.kind === CANVAS_FRAGMENT_KIND && Array.isArray(v.nodes) && Array.isArray(v.edges);
}

/**
 * The selected nodes, everything inside selected frames, and the edges between them. Results are
 * stripped. A node copied without its frame gets its pane position and no parent, unless
 * `keepParents` (duplicate in place) keeps it in that frame. Duplicating also keeps each node's
 * images (`keepResults`) and the data links coming into it from nodes left behind (`keepInputs`).
 * A copy is never locked: the lock stays with what the person locked.
 */
export function extractFragment(
  doc: DocSlice,
  nodeIds: readonly string[],
  opts: { keepParents?: boolean; keepResults?: boolean; keepInputs?: boolean } = {},
): CanvasFragment {
  const picked = new Set<string>();
  for (const id of nodeIds) {
    if (!doc.nodes[id]) continue;
    picked.add(id);
    for (const inner of containedIn(doc, id)) picked.add(inner);
  }
  const nodes: CanvasNode[] = [];
  for (const id of parentsFirst(doc)) {
    if (!picked.has(id)) continue;
    const { locked: _locked, ...frame } = doc.nodes[id]!;
    const keepParent = frame.parentId !== null && (opts.keepParents || picked.has(frame.parentId));
    nodes.push({
      ...frame,
      parentId: keepParent ? frame.parentId : null,
      position: keepParent ? { ...frame.position } : absolutePosition(doc, id),
      params: structuredClone({ ...(doc.params[id] ?? {}) }),
      result: opts.keepResults ? structuredClone(doc.results[id] ?? null) : null,
    });
  }
  const edges = doc.edgeOrder
    .map((id) => doc.edges[id])
    .filter(
      (e): e is CanvasEdge =>
        !!e && picked.has(e.target) && (picked.has(e.source) || (!!opts.keepInputs && e.kind === "data")),
    )
    .map((e) => ({ ...e }));
  return { kind: CANVAS_FRAGMENT_KIND, nodes, edges };
}

export const newNodeId = (): string => `n_${newId().toLowerCase()}`;
export const newEdgeId = (): string => `e_${newId().toLowerCase()}`;

/**
 * Fresh ids for every node and edge, internal edges and frame links kept. Nodes whose frame isn't in
 * the fragment move by `offset`; they lose that frame unless `keepForeignParents` (same canvas).
 * On the same canvas a duplicate also keeps its images and the links coming in from nodes outside
 * the fragment (`keepOutside`).
 */
export function remapFragment(
  fragment: CanvasFragment,
  offset: Point = { x: 0, y: 0 },
  opts: { keepForeignParents?: boolean; keepOutside?: boolean } = {},
): CanvasFragment {
  const ids = new Map(fragment.nodes.map((n) => [n.id, newNodeId()]));
  const nodes = fragment.nodes.map((n) => {
    const inner = n.parentId !== null ? ids.get(n.parentId) : undefined;
    const parentId = inner ?? (opts.keepForeignParents ? n.parentId : null);
    return {
      ...n,
      id: ids.get(n.id)!,
      parentId,
      position: inner ? n.position : { x: n.position.x + offset.x, y: n.position.y + offset.y },
      result: opts.keepOutside ? n.result : null,
    };
  });
  const edges = fragment.edges
    .filter((e) => ids.has(e.target) && (ids.has(e.source) || !!opts.keepOutside))
    .map((e) => ({
      ...e,
      id: newEdgeId(),
      source: ids.get(e.source) ?? e.source,
      target: ids.get(e.target)!,
    }));
  return { kind: CANVAS_FRAGMENT_KIND, nodes, edges };
}

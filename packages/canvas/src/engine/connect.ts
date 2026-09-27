import { t } from "@openfield/core";
import type { CanvasEdge } from "@openfield/core/canvas";
import type { NodeRegistry } from "../nodes/registry";
import { specRegistry as nodeRegistry } from "../nodes/specs";
import { absolutePosition, incomingEdges, newEdgeId, wouldCreateCycle } from "../store/graph";
import { applyOps, type DocSlice } from "../store/ops";
import { isAnnotationHandle, type PortFlow, type PortSpec, type PortType, portFlow } from "./types";

/** What canConnect reads: the editor's store state, or anything else holding a document. */
type CanvasState = { doc: DocSlice };

// Connection rules (§7.6): compatible types, visible ports, no loops, annotation handles only to
// annotation handles. The editor hands this to React Flow's isValidConnection and toasts `reason`.

export interface ConnectionEnds {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
}

export type ConnectCheck =
  | {
      ok: true;
      kind: "data" | "annotation";
      /** "coerce": an image going into a mask input. The edge shows the coercion glyph. */
      flow: PortFlow;
      /** A single input already has this edge; connecting replaces it ("Replaced connection"). */
      replaces?: string;
    }
  /** reason is the toast, or null when there's nothing worth saying (a duplicate, a dropped drag). */
  | { ok: false; reason: string | null };

const refuse = (reason: string | null): ConnectCheck => ({ ok: false, reason });

/** "Text can't go into an image input on Generate." */
export function mismatchMessage(from: PortType, to: PortType, nodeLabel: string): string {
  return t("canvas.nodes.connect.mismatch", { from, to, node: nodeLabel });
}

export function checkConnection(
  doc: DocSlice,
  connection: ConnectionEnds,
  registry: NodeRegistry = nodeRegistry,
): ConnectCheck {
  const { source, sourceHandle, target, targetHandle } = connection;
  if (!sourceHandle || !targetHandle) return refuse(null);
  const from = doc.nodes[source];
  const to = doc.nodes[target];
  if (!from || !to) return refuse(null);

  const sourceArrow = isAnnotationHandle(sourceHandle);
  const targetArrow = isAnnotationHandle(targetHandle);
  if (sourceArrow || targetArrow) {
    // Arrows run from a source side to a target side, and never carry data.
    const fits =
      sourceArrow &&
      targetArrow &&
      sourceHandle.startsWith("arrow-source-") &&
      targetHandle.startsWith("arrow-target-");
    return fits && source !== target ? { ok: true, kind: "annotation", flow: "ok" } : refuse(null);
  }

  const out = registry.port(from.type, sourceHandle, "out");
  const into = registry.port(to.type, targetHandle, "in");
  if (!out || !into || out.hidden || into.hidden) {
    return refuse(null);
  }
  const flow = portFlow(out.type, into.type);
  if (flow === "no") {
    const label = to.title?.trim() || t(registry.get(to.type)!.label);
    return refuse(mismatchMessage(out.type, into.type, label));
  }
  if (source === target || wouldCreateCycle(doc, source, target))
    return refuse(t("canvas.nodes.connect.loop"));

  const existing = incomingEdges(doc, target, targetHandle);
  if (existing.some((e) => e.source === source && e.sourceHandle === sourceHandle)) return refuse(null);
  const replaces = into.arity === "single" ? existing[0]?.id : undefined;
  return { ok: true, kind: "data", flow, ...(replaces && { replaces }) };
}

/** The store-facing form the editor calls from isValidConnection and onConnect. */
export function canConnect(state: Pick<CanvasState, "doc">, connection: ConnectionEnds): ConnectCheck {
  return checkConnection(state.doc, connection);
}

/** The order a new link into a many-link input gets: after every link already there. */
export function nextEdgeOrder(doc: DocSlice, target: string, targetHandle: string): number {
  return incomingEdges(doc, target, targetHandle).reduce((max, e, i) => Math.max(max, (e.order ?? i) + 1), 0);
}

/** Where a drag started: the node, and whether from an output ("source") or an input ("target"). */
export interface DragOrigin {
  nodeId: string;
  handleType: "source" | "target";
}

export interface GroupConnectPlan {
  /** Links for the rest of the selection, in the order they're added. */
  edges: CanvasEdge[];
  /** Selected nodes that only fit one-link inputs already taken, with the first such input. */
  skipped: { nodeId: string; port: PortSpec }[];
}

/**
 * The rest of a selection joining a link dragged from one of its nodes (§7.6). `doc` already has the
 * dragged link. Every other selected node, top to bottom then left to right, links to the node the
 * drag ended on, through the dropped port when it fits and has room, or else the first other port
 * that fits (type for type: an image never lands in a mask input unless that's where it was
 * dropped). Many-link inputs take them all; a one-link input already taken is never replaced for
 * them, so those nodes are skipped and reported. Loops, duplicates and nodes already linked to it
 * are left out quietly, as are nodes with nothing that fits.
 */
export function planGroupConnect(
  doc: DocSlice,
  dragged: ConnectionEnds,
  origin: DragOrigin,
  selection: readonly string[],
  registry: NodeRegistry = nodeRegistry,
): GroupConnectPlan {
  const plan: GroupConnectPlan = { edges: [], skipped: [] };
  const { sourceHandle, targetHandle } = dragged;
  if (!sourceHandle || !targetHandle) return plan;
  // Dragged from an output, the selection feeds the node it was dropped on; from an input, that
  // node feeds the selection.
  const feeds = origin.handleType === "source";
  const drop = feeds ? dragged.target : dragged.source;
  const dropNode = doc.nodes[drop];
  if (!dropNode || !selection.includes(origin.nodeId) || selection.length < 2) return plan;

  const others = selection
    .filter((id) => id !== origin.nodeId && id !== drop && doc.nodes[id])
    .map((id) => ({ id, at: absolutePosition(doc, id) }))
    .sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)
    .map(({ id }) => id);

  let current = doc;
  for (const id of others) {
    const node = current.nodes[id]!;
    const linked = Object.values(current.edges).some(
      (e) =>
        e.kind === "data" &&
        (feeds ? e.source === id && e.target === drop : e.source === drop && e.target === id),
    );
    if (linked) continue;
    // Inputs to try, the dropped one first: on the drop node when it's fed, on this node otherwise
    // (where the dragged link's input is the one to match).
    const inputs = registry.ports(feeds ? dropNode.type : node.type, "in");
    const dropped = targetHandle;
    const ordered = [...inputs].sort((a, b) => Number(b.id === dropped) - Number(a.id === dropped));
    const outputs = registry.ports(feeds ? node.type : dropNode.type, "out");
    let full: PortSpec | null = null;
    for (const into of ordered) {
      const fits = (out: PortSpec) => {
        const flow = portFlow(out.type, into.type);
        return flow === "ok" || (flow === "coerce" && into.id === dropped);
      };
      // Feeding from the drop node, its dragged output comes first.
      const out = feeds
        ? outputs.find(fits)
        : (outputs.find((o) => o.id === sourceHandle && fits(o)) ?? outputs.find(fits));
      if (!out) continue;
      const ends = feeds
        ? { source: id, sourceHandle: out.id, target: drop, targetHandle: into.id }
        : { source: drop, sourceHandle: out.id, target: id, targetHandle: into.id };
      const check = checkConnection(current, ends, registry);
      if (!check.ok || check.kind !== "data") continue;
      if (check.replaces) {
        full ??= into;
        continue;
      }
      const edge: CanvasEdge = {
        id: newEdgeId(),
        ...ends,
        kind: "data",
        ...(into.arity === "multi" && { order: nextEdgeOrder(current, ends.target, into.id) }),
      };
      plan.edges.push(edge);
      current = applyOps(current, [{ op: "addEdge", edge }]).doc;
      full = null;
      break;
    }
    if (full) plan.skipped.push({ nodeId: id, port: full });
  }
  return plan;
}

/** The toast for nodes a group link skipped: "2 nodes didn't connect: Prompt takes one link." */
export function skippedMessage(skipped: GroupConnectPlan["skipped"]): string {
  const ports = new Set(skipped.map((s) => s.port.id));
  const first = skipped[0]?.port;
  if (ports.size === 1 && first?.label) {
    return t("canvas.nodes.connect.oneLink", { count: skipped.length, port: t(first.label) });
  }
  return t("canvas.nodes.connect.oneLinkEach", { count: skipped.length });
}

export type BodyDrop =
  | { ok: true; ends: ConnectionEnds; port: PortSpec }
  /** reason is the toast, as for a drop on a port that doesn't fit, or null to say nothing. */
  | { ok: false; reason: string | null };

/**
 * A link dropped on a node's body rather than on one of its ports (§7.6): the port it goes to. From
 * an output, the node's inputs; from an input, its outputs; in rail order. A port with room (one
 * that takes many, or a free one-link port) comes first, and among those one of the same type
 * before one that would convert (an image into a mask). With no room anywhere it goes where a drop
 * on that port would, replacing what's there. Nothing that fits: the reason a drop on its first
 * port would give.
 */
export function bodyDropPort(
  doc: DocSlice,
  origin: DragOrigin & { handleId: string },
  nodeId: string,
  registry: NodeRegistry = nodeRegistry,
): BodyDrop {
  const node = doc.nodes[nodeId];
  if (!node || nodeId === origin.nodeId || isAnnotationHandle(origin.handleId))
    return { ok: false, reason: null };
  const feeds = origin.handleType === "source";
  const ports = registry.ports(node.type, feeds ? "in" : "out");
  let best: { ends: ConnectionEnds; port: PortSpec; rank: number } | null = null;
  let reason: string | null = null;
  for (const port of ports) {
    const ends: ConnectionEnds = feeds
      ? { source: origin.nodeId, sourceHandle: origin.handleId, target: nodeId, targetHandle: port.id }
      : { source: nodeId, sourceHandle: port.id, target: origin.nodeId, targetHandle: origin.handleId };
    const check = checkConnection(doc, ends, registry);
    if (!check.ok) {
      // A loop says more than a type that doesn't fit, so it wins.
      if (check.reason && (reason === null || check.reason === t("canvas.nodes.connect.loop")))
        reason = check.reason;
      continue;
    }
    const rank = (check.replaces ? 2 : 0) + (check.flow === "ok" ? 0 : 1);
    if (!best || rank < best.rank) best = { ends, port, rank };
  }
  return best ? { ok: true, ends: best.ends, port: best.port } : { ok: false, reason };
}

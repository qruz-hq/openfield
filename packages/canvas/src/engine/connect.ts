import { t } from "@openfield/core";
import type { NodeRegistry } from "../nodes/registry";
import { specRegistry as nodeRegistry } from "../nodes/specs";
import { incomingEdges, wouldCreateCycle } from "../store/graph";
import type { DocSlice } from "../store/ops";
import { isAnnotationHandle, type PortFlow, type PortType, portFlow } from "./types";

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

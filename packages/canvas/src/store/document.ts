import {
  CANVAS_SCHEMA,
  type CanvasComment,
  type CanvasDocument,
  type CanvasNode,
  type CanvasNodeResult,
  type CanvasViewport,
} from "@openfield/core/canvas";
import type { DocSlice, NodeFrame, NodeParams } from "./ops";

// Between the saved document (§7.8) and the store's normalized slice. Both directions keep the
// node order, so a load followed by a save changes nothing but updatedAt.

/** Document fields the editor doesn't touch but must write back unchanged. */
export interface DocMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  comments: CanvasComment[];
  meta: CanvasDocument["meta"];
}

export function fromDocument(doc: CanvasDocument): {
  slice: DocSlice;
  meta: DocMeta;
  viewport: CanvasViewport;
} {
  const nodes: Record<string, NodeFrame> = {};
  const params: Record<string, NodeParams> = {};
  const results: Record<string, CanvasNodeResult | null> = {};
  for (const node of doc.nodes) {
    const { params: p, result, ...frame } = node;
    nodes[node.id] = frame;
    params[node.id] = p;
    results[node.id] = result;
  }
  const edges: Record<string, DocSlice["edges"][string]> = {};
  for (const edge of doc.edges) edges[edge.id] = edge;
  return {
    slice: {
      name: doc.name,
      nodes,
      order: doc.nodes.map((n) => n.id),
      params,
      results,
      edges,
      edgeOrder: doc.edges.map((e) => e.id),
    },
    meta: {
      id: doc.id,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      comments: doc.comments,
      meta: doc.meta,
    },
    viewport: doc.viewport,
  };
}

export function toDocument(
  slice: DocSlice,
  meta: DocMeta,
  viewport: CanvasViewport,
  updatedAt = new Date().toISOString(),
): CanvasDocument {
  const nodes: CanvasNode[] = [];
  for (const id of slice.order) {
    const frame = slice.nodes[id];
    if (!frame) continue;
    nodes.push({ ...frame, params: { ...(slice.params[id] ?? {}) }, result: slice.results[id] ?? null });
  }
  const edges = slice.edgeOrder.flatMap((id) => (slice.edges[id] ? [slice.edges[id]] : []));
  return {
    schema: CANVAS_SCHEMA,
    id: meta.id,
    name: slice.name,
    createdAt: meta.createdAt,
    updatedAt,
    viewport: { ...viewport },
    nodes,
    edges,
    comments: meta.comments,
    meta: meta.meta,
  };
}

/** A new, empty document (the server makes the real one; tests and previews use this). */
export function emptyDocument(id: string, name: string, at = new Date().toISOString()): CanvasDocument {
  return {
    schema: CANVAS_SCHEMA,
    id,
    name,
    createdAt: at,
    updatedAt: at,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    comments: [],
    meta: {},
  };
}

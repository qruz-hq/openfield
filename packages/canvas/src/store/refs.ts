import type { CanvasDocument, CanvasNodeResult } from "@openfield/core/canvas";
import { newEdgeId, newNodeId } from "./graph";

// Which library images a document names, and the id rewrites a copy brought into another library
// needs (§7.8): fresh node and connection ids so the same file can come in twice, and asset ids
// that point at the rows this library keeps for the same pictures. Fields are named one by one, not
// found by scanning for ULIDs: params.folderId (Assets in folder mode) is a folder, not an image.

export interface DocumentAssetRefs {
  /**
   * The images the canvas shows: what nodes were given (params.assetIds on Upload and Assets) and
   * what their runs made (result.assetIds and outputs). No repeats, in document order.
   */
  shown: string[];
  /**
   * The images runs read (result.inputs), which decide whether a node is up to date. Usually
   * also shown; one a run read from an image since taken off the canvas is only here.
   */
  read: string[];
}

const ownAssetIds = (params: Record<string, unknown>): string[] => {
  const own = params.assetIds;
  return Array.isArray(own) ? own.filter((id): id is string => typeof id === "string") : [];
};

export function documentAssetRefs(doc: CanvasDocument): DocumentAssetRefs {
  const shown = new Set<string>();
  const read = new Set<string>();
  for (const node of doc.nodes) {
    for (const id of ownAssetIds(node.params)) shown.add(id);
    const result = node.result;
    if (!result) continue;
    for (const id of result.assetIds) shown.add(id);
    for (const output of result.outputs) shown.add(output.assetId);
    for (const id of result.inputs ?? []) read.add(id);
  }
  return { shown: [...shown], read: [...read] };
}

/** Every asset id field moved through `map`; ids it doesn't name stay as they are. */
export function remapDocumentAssets(doc: CanvasDocument, map: ReadonlyMap<string, string>): CanvasDocument {
  if (map.size === 0) return doc;
  const to = (id: string) => map.get(id) ?? id;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const own = node.params.assetIds;
      const params = Array.isArray(own)
        ? { ...node.params, assetIds: own.map((id) => (typeof id === "string" ? to(id) : id)) }
        : node.params;
      return { ...node, params, result: node.result && remapResult(node.result, to) };
    }),
  };
}

function remapResult(result: CanvasNodeResult, to: (id: string) => string): CanvasNodeResult {
  return {
    ...result,
    assetIds: result.assetIds.map(to),
    outputs: result.outputs.map((output) => ({ ...output, assetId: to(output.assetId) })),
    // Kept sorted and unique, the way a run writes them, so the comparison with what a node reads
    // now still holds when two ids became one.
    ...(result.inputs && { inputs: [...new Set(result.inputs.map(to))].sort() }),
  };
}

/**
 * Fresh node and connection ids throughout, with frame membership, connections and comments
 * following them. Results, params and frames are kept. `nodeIds` maps each old node id to its new
 * one, for anything outside the document that names a node.
 */
export function remapDocumentIds(doc: CanvasDocument): {
  doc: CanvasDocument;
  nodeIds: ReadonlyMap<string, string>;
} {
  const ids = new Map(doc.nodes.map((node) => [node.id, newNodeId()]));
  const next: CanvasDocument = {
    ...doc,
    nodes: doc.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      parentId: node.parentId === null ? null : (ids.get(node.parentId) ?? null),
    })),
    edges: doc.edges.map((edge) => ({
      ...edge,
      id: newEdgeId(),
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
    })),
    comments: doc.comments.map(({ nodeId, ...comment }) => {
      const moved = nodeId === undefined ? undefined : ids.get(nodeId);
      // A comment on a node that isn't there stays where it was put, without the node.
      return moved ? { ...comment, nodeId: moved } : comment;
    }),
  };
  return { doc: next, nodeIds: ids };
}

/** remapDocumentIds without the map: what an imported file needs before it's created. */
export const remapDocument = (doc: CanvasDocument): CanvasDocument => remapDocumentIds(doc).doc;

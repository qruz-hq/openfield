// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { CanvasDocument, CanvasNode, CanvasNodeResult } from "@openfield/core/canvas";
import { emptyDocument } from "../src/store/document";
import { documentAssetRefs, remapDocument, remapDocumentAssets, remapDocumentIds } from "../src/store/refs";

// Which images a document names, and the id rewrites an import makes (§7.8).

const A = "01K6BQ8000000000000000000A";
const B = "01K6BQ8000000000000000000B";
const C = "01K6BQ8000000000000000000C";
const D = "01K6BQ8000000000000000000D";
const F = "01K6BQ800000000000000000FF";

function node(id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    parentId: null,
    collapsed: false,
    title: null,
    params: {},
    presetLocks: [],
    result: null,
    ...extra,
  };
}

function result(fields: Partial<CanvasNodeResult>): CanvasNodeResult {
  return {
    state: "done",
    assetIds: [],
    jobSetId: null,
    jobSetIds: [],
    outputs: [],
    fingerprint: null,
    costUsd: null,
    ranAt: null,
    error: null,
    ...fields,
  };
}

function doc(): CanvasDocument {
  return {
    ...emptyDocument("01K6BQ800000000000000CANVS", "Refs"),
    nodes: [
      node("frame", "frame"),
      node("up", "image.upload", { parentId: "frame", params: { assetIds: [A] } }),
      // A folder id is not an image.
      node("lib", "image.asset", { params: { assetIds: [B, 42], folderId: F } }),
      node("gen", "image.generate", {
        result: result({ assetIds: [C], outputs: [{ assetId: C }, { assetId: D }], inputs: [B, A] }),
      }),
    ],
    edges: [
      {
        id: "e1",
        source: "up",
        sourceHandle: "images",
        target: "gen",
        targetHandle: "references",
        kind: "data",
      },
    ],
    comments: [
      { id: "c1", nodeId: "gen", text: "nice", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "c2", nodeId: "gone", text: "orphan", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "c3", point: { x: 1, y: 2 }, text: "here", createdAt: "2026-10-01T00:00:00.000Z" },
    ],
  };
}

describe("documentAssetRefs", () => {
  test("names what nodes were given and what runs made, apart from what runs read", () => {
    expect(documentAssetRefs(doc())).toEqual({ shown: [A, B, C, D], read: [B, A] });
  });
});

describe("remapDocumentAssets", () => {
  test("moves every asset field and keeps what it doesn't name", () => {
    const moved = remapDocumentAssets(doc(), new Map([[A, B]]));
    const [, up, lib, gen] = moved.nodes;
    expect(up!.params.assetIds).toEqual([B]);
    expect(lib!.params).toEqual({ assetIds: [B, 42], folderId: F });
    // Two ids that became one read as one, sorted, as a run writes them.
    expect(gen!.result!.inputs).toEqual([B]);
    expect(gen!.result!.assetIds).toEqual([C]);
  });

  test("results and outputs follow, and an empty map changes nothing", () => {
    const moved = remapDocumentAssets(doc(), new Map([[C, A]]));
    expect(moved.nodes[3]!.result!.assetIds).toEqual([A]);
    expect(moved.nodes[3]!.result!.outputs).toEqual([{ assetId: A }, { assetId: D }]);
    const same = doc();
    expect(remapDocumentAssets(same, new Map())).toBe(same);
  });
});

describe("remapDocumentIds", () => {
  test("fresh ids for nodes and connections, with frames, wiring and comments following", () => {
    const original = doc();
    const { doc: copy, nodeIds } = remapDocumentIds(original);
    expect(copy.nodes.some((n) => original.nodes.some((o) => o.id === n.id))).toBe(false);
    expect(nodeIds.get("up")).toBe(copy.nodes[1]!.id);
    expect(copy.nodes[1]!.parentId).toBe(copy.nodes[0]!.id);
    expect(copy.edges[0]).toMatchObject({ source: nodeIds.get("up"), target: nodeIds.get("gen") });
    expect(copy.edges[0]!.id).not.toBe("e1");
    expect(copy.comments[0]!.nodeId).toBe(nodeIds.get("gen")!);
    // A comment on a node that isn't there keeps its place without one.
    expect(copy.comments[1]).toEqual({ id: "c2", text: "orphan", createdAt: "2026-10-01T00:00:00.000Z" });
    expect(copy.comments[2]).toEqual(original.comments[2]!);
    // Results stay.
    expect(copy.nodes[3]!.result).toEqual(original.nodes[3]!.result);
    expect(remapDocument(original).nodes[0]!.id).not.toBe(remapDocument(original).nodes[0]!.id);
  });
});

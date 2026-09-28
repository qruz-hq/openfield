// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { EngineContext, PortSpec } from "@openfield/canvas/engine/types";
import { createNodeRegistry, railOffsets } from "@openfield/canvas/nodes/registry";
import type { CanvasDetail } from "@openfield/core";
import { type CanvasDocument, type CanvasNode, canvasDocumentSchema } from "@openfield/core/canvas";
import { Type } from "lucide-react";
import { lockedToKeep, stayedMessage, toggleLockOps, unlockOps } from "../src/canvas/editor/locks";
import { defineNode, nodeRegistry } from "../src/canvas/nodes/registry";
import {
  applyOps,
  type CanvasOp,
  createCanvasStore,
  emptyDocument,
  extractFragment,
  fromDocument,
  incomingEdges,
  isLocked,
  lockedBy,
  type PendingConnection,
  topoOrder,
  wouldCreateCycle,
} from "../src/canvas/store";

const CANVAS_ID = "01K6BQ8000000000000000CNVS";
const AT = "2026-09-23T09:12:04.118Z";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "prompt",
  typeVersion: 1,
  position: { x: 0, y: 0 },
  parentId: null,
  collapsed: false,
  title: null,
  params: { text: id },
  presetLocks: [],
  result: null,
  ...extra,
});

const dataEdge = (id: string, source: string, target: string, targetHandle = "prompt") => ({
  id,
  source,
  sourceHandle: "text",
  target,
  targetHandle,
  kind: "data" as const,
});

function documentWith(nodes: CanvasNode[], edges: CanvasDocument["edges"] = []): CanvasDocument {
  return { ...emptyDocument(CANVAS_ID, "Mug campaign", AT), nodes, edges };
}

function detailOf(doc: CanvasDocument): CanvasDetail {
  return { id: CANVAS_ID, name: doc.name, graph: doc, graphVersion: 3, updatedAt: AT };
}

/** Prompt a → generate b → generate c, and a separate prompt d. */
const chain = () =>
  documentWith(
    [
      node("a"),
      node("b", { type: "image.generate", position: { x: 400, y: 0 } }),
      node("c", { type: "image.generate", position: { x: 800, y: 0 } }),
      node("d", { position: { x: 0, y: 300 } }),
    ],
    [dataEdge("e1", "a", "b"), { ...dataEdge("e2", "b", "c", "input_images"), sourceHandle: "images" }],
  );

describe("applyOps", () => {
  test("deleting a node takes its edges, and the inverse puts everything back exactly", () => {
    const { slice } = fromDocument(chain());
    const deleted = applyOps(slice, [{ op: "deleteNode", id: "b" }]);
    expect(deleted.doc.nodes.b).toBeUndefined();
    expect(deleted.doc.edgeOrder).toEqual([]);
    const restored = applyOps(deleted.doc, deleted.inverse);
    expect(restored.doc).toEqual(slice);
  });

  test("setParams merges, removes undefined keys, and undoes to the old values", () => {
    const { slice } = fromDocument(chain());
    const changed = applyOps(slice, [{ op: "setParams", id: "a", patch: { text: "new", extra: 1 } }]);
    expect(changed.doc.params.a).toEqual({ text: "new", extra: 1 });
    const back = applyOps(changed.doc, changed.inverse);
    expect(back.doc.params.a).toEqual({ text: "a" });
  });

  test("leaves maps it didn't touch alone, so selectors don't see a change", () => {
    const { slice } = fromDocument(chain());
    const moved = applyOps(slice, [{ op: "setParams", id: "a", patch: { text: "x" } }]);
    expect(moved.doc.nodes).toBe(slice.nodes);
    expect(moved.doc.edges).toBe(slice.edges);
    expect(moved.doc.params).not.toBe(slice.params);
  });

  test("refuses a frame inside itself and a frame that still holds nodes", () => {
    const doc = documentWith([
      node("f", { type: "frame" }),
      node("g", { type: "frame", parentId: "f" }),
      node("n", { parentId: "g" }),
    ]);
    const { slice } = fromDocument(doc);
    expect(() =>
      applyOps(slice, [{ op: "reparent", id: "f", parentId: "g", position: { x: 0, y: 0 } }]),
    ).toThrow();
    expect(() => applyOps(slice, [{ op: "deleteNode", id: "g" }])).toThrow();
  });
});

describe("graph", () => {
  test("orders data nodes, spots loops and keeps multi-input order", () => {
    const { slice } = fromDocument(chain());
    expect(topoOrder(slice).order).toEqual(["a", "d", "b", "c"]);
    expect(wouldCreateCycle(slice, "c", "a")).toBe(true);
    expect(wouldCreateCycle(slice, "d", "c")).toBe(false);
    const withTwo = applyOps(slice, [
      { op: "addEdge", edge: { ...dataEdge("e3", "d", "c", "input_images"), order: 0 } },
    ]).doc;
    expect(incomingEdges(withTwo, "c", "input_images").map((e) => e.id)).toEqual(["e3", "e2"]);
  });

  test("copies a node out of its frame at its place on the pane, with no result", () => {
    const doc = documentWith([
      node("f", { type: "frame", position: { x: 100, y: 50 } }),
      node("n", { parentId: "f", position: { x: 10, y: 20 }, result: null }),
    ]);
    const fragment = extractFragment(fromDocument(doc).slice, ["n"]);
    expect(fragment.nodes[0]).toMatchObject({ parentId: null, position: { x: 110, y: 70 }, result: null });
  });
});

describe("canvas store", () => {
  const typing = (value: string): CanvasOp[] => [{ op: "setParams", id: "a", patch: { text: value } }];

  test("changes bump the revision, and typing coalesces into one undo entry", () => {
    let clock = 1_000;
    const store = createCanvasStore(detailOf(chain()), { now: () => clock });
    const { actions } = store.getState();
    actions.apply(typing("l"), { coalesce: "a.text" });
    clock += 200;
    actions.apply(typing("li"), { coalesce: "a.text" });
    clock += 900;
    actions.apply(typing("lig"), { coalesce: "a.text" });
    const state = store.getState();
    expect(state.persist.revision).toBe(3);
    expect(state.persist.status).toBe("dirty");
    expect(state.history.past).toHaveLength(2);
    actions.undo();
    expect(store.getState().doc.params.a).toEqual({ text: "li" });
    actions.undo();
    expect(store.getState().doc.params.a).toEqual({ text: "a" });
    actions.redo();
    actions.redo();
    expect(store.getState().doc.params.a).toEqual({ text: "lig" });
  });

  test("a node with a run in flight can't be deleted, even by undo", () => {
    const store = createCanvasStore(detailOf(chain()));
    const { actions } = store.getState();
    actions.setRuntime({ b: { state: "running", runId: "01K6BQ8000000000000000RUN1" } });
    expect(actions.deleteNodes(["b"])).toEqual({ ok: false, reason: "running", nodeIds: ["b"] });
    const fresh = node("z");
    actions.apply([{ op: "addNode", node: fresh }]);
    actions.setRuntime({ z: { state: "queued" } });
    expect(actions.undo()).toMatchObject({ ok: false, reason: "running" });
    expect(store.getState().doc.nodes.z).toBeDefined();
  });

  test("deleting a frame alone keeps its nodes where they are on screen", () => {
    const doc = documentWith([
      node("f", { type: "frame", position: { x: 100, y: 50 } }),
      node("n", { parentId: "f", position: { x: 10, y: 20 } }),
    ]);
    const store = createCanvasStore(detailOf(doc));
    store.getState().actions.deleteNodes(["f"], "frame-only");
    expect(store.getState().doc.nodes.n).toMatchObject({ parentId: null, position: { x: 110, y: 70 } });
    const both = createCanvasStore(detailOf(doc));
    both.getState().actions.deleteNodes(["f"]);
    expect(both.getState().doc.order).toEqual([]);
  });

  test("duplicate keeps frame membership, remaps edges and selects the copies", () => {
    const doc = documentWith(
      [
        node("f", { type: "frame" }),
        node("p", { parentId: "f" }),
        node("g", { type: "image.generate", parentId: "f" }),
      ],
      [dataEdge("e1", "p", "g")],
    );
    const store = createCanvasStore(detailOf(doc));
    const ids = store.getState().actions.duplicateNodes(["p", "g"]);
    const state = store.getState();
    expect(ids).toHaveLength(2);
    expect(state.selection.nodeIds).toEqual(ids);
    for (const id of ids)
      expect(state.doc.nodes[id]).toMatchObject({ parentId: "f", position: { x: 24, y: 24 } });
    const copied = Object.values(state.doc.edges).find((e) => e.id !== "e1")!;
    expect([copied.source, copied.target].sort()).toEqual([...ids].sort());
  });

  test("a duplicate keeps its images and the links coming into it; links out stay with the original", () => {
    const doc = documentWith(
      [node("p"), node("g", { type: "image.generate" }), node("v", { type: "image.generate" })],
      [dataEdge("in", "p", "g"), dataEdge("out", "g", "v")],
    );
    const store = createCanvasStore(detailOf(doc));
    const images = ["01K6BQ80000000000000AS0001", "01K6BQ80000000000000AS0002"];
    store.getState().actions.apply([
      {
        op: "setResult",
        id: "g",
        result: {
          state: "done",
          assetIds: images,
          jobSetId: null,
          jobSetIds: [],
          outputs: [],
          fingerprint: "f".repeat(64),
          costUsd: null,
          ranAt: null,
          error: null,
        },
      },
    ]);
    const [copy] = store.getState().actions.duplicateNodes(["g"]);
    const state = store.getState();
    expect(state.doc.results[copy!]?.assetIds).toEqual(images);
    const edges = Object.values(state.doc.edges);
    expect(edges.filter((e) => e.target === copy).map((e) => e.source)).toEqual(["p"]);
    expect(edges.filter((e) => e.source === copy)).toEqual([]);
    // The original keeps both its links.
    expect(
      edges
        .filter((e) => e.source === "g" || e.target === "g")
        .map((e) => e.id)
        .sort(),
    ).toEqual(["in", "out"]);
  });

  test("the saved document is valid and round-trips", () => {
    const original = chain();
    const store = createCanvasStore(detailOf(original));
    const { document } = store.getState().actions.snapshot();
    expect(canvasDocumentSchema.safeParse(document).success).toBe(true);
    expect({ ...document, updatedAt: AT }).toEqual(canvasDocumentSchema.parse(original));
  });

  test("a 409 then Keep mine saves over the server's copy", () => {
    const store = createCanvasStore(detailOf(chain()));
    const { actions } = store.getState();
    actions.apply(typing("mine"));
    const sent = actions.snapshot();
    actions.markSaving();
    actions.markConflict({ ...detailOf(chain()), graphVersion: 7 });
    expect(store.getState().persist.status).toBe("conflict");
    actions.keepMine();
    expect(store.getState().persist).toMatchObject({ graphVersion: 7, status: "dirty", conflict: null });
    actions.markSaved({
      graphVersion: 8,
      updatedAt: AT,
      revision: sent.revision,
      viewRevision: sent.viewRevision,
    });
    expect(store.getState().persist.status).toBe("saved");
  });
});

describe("locked nodes (§7.9)", () => {
  /** A frame f with a prompt p in it, a generate g beside it, and a prompt q on its own. */
  const framed = () =>
    documentWith([
      node("f", { type: "frame", position: { x: 100, y: 50 }, size: { w: 640, h: 420 } }),
      node("p", { parentId: "f", position: { x: 10, y: 20 } }),
      node("g", { type: "image.generate", position: { x: 900, y: 0 } }),
      node("q", { position: { x: 0, y: 600 } }),
    ]);

  test("locking a selection is one undo step, and unlocking leaves no trace", () => {
    const store = createCanvasStore(detailOf(framed()));
    const { actions } = store.getState();
    const before = store.getState().doc;
    actions.apply(toggleLockOps(before, ["g", "q"]), { label: "lock" });
    expect(isLocked(store.getState().doc, "g")).toBe(true);
    expect(isLocked(store.getState().doc, "q")).toBe(true);
    expect(store.getState().history.past).toHaveLength(1);
    // Everything picked is locked, so the same key unlocks it.
    actions.apply(toggleLockOps(store.getState().doc, ["g", "q"]), { label: "lock" });
    expect(store.getState().doc.nodes.g).toEqual(before.nodes.g);
    actions.undo();
    actions.undo();
    expect(store.getState().doc).toEqual(before);
    // The saved document says it only while it's locked.
    actions.apply(toggleLockOps(store.getState().doc, ["g"]), { label: "lock" });
    const saved = store.getState().actions.snapshot().document;
    expect(canvasDocumentSchema.parse(saved).nodes.find((n) => n.id === "g")?.locked).toBe(true);
    expect("locked" in saved.nodes.find((n) => n.id === "q")!).toBe(false);
  });

  test("a locked frame locks what's in it; unlocking a node in it unlocks the frame", () => {
    const { slice } = fromDocument(framed());
    const locked = applyOps(slice, toggleLockOps(slice, ["f", "p"])).doc;
    // Picked with its frame, the node is locked by the frame alone.
    expect(locked.nodes.p!.locked).toBeUndefined();
    expect(lockedBy(locked, "p")).toBe("f");
    expect(unlockOps(locked, ["p"])).toEqual([{ op: "setLocked", id: "f", locked: false }]);
  });

  test("delete leaves locked nodes where they are and says which stayed", () => {
    const doc = documentWith([
      node("f", { type: "frame", position: { x: 100, y: 50 } }),
      node("p", { parentId: "f", position: { x: 10, y: 20 }, locked: true }),
      node("n", { parentId: "f", position: { x: 300, y: 20 } }),
      node("g", { type: "image.generate", locked: true }),
      node("q", { position: { x: 0, y: 600 } }),
    ]);
    const store = createCanvasStore(detailOf(doc));
    const { slice } = fromDocument(doc);
    expect(lockedToKeep(slice, ["f", "g", "q"], "with-contents")).toEqual(["p", "g"]);
    expect(stayedMessage(slice, nodeRegistry, ["g"])).toBe(
      "Generate is locked, so it stayed. Unlock it to delete it.",
    );
    expect(stayedMessage(slice, nodeRegistry, ["p", "g"])).toBe(
      "2 locked nodes stayed. Unlock them to delete them.",
    );
    store.getState().actions.deleteNodes(["f", "g", "q"]);
    const after = store.getState().doc;
    expect(after.order.sort()).toEqual(["g", "p"]);
    // Its frame went, so it's on the pane where it was on screen.
    expect(after.nodes.p).toMatchObject({ parentId: null, position: { x: 110, y: 70 } });
  });

  test("nothing in a locked frame is deleted, and a node in one says its frame is locked", () => {
    const { slice } = fromDocument(framed());
    const doc = applyOps(slice, [{ op: "setLocked", id: "f", locked: true }]).doc;
    expect(lockedToKeep(doc, ["p"], "with-contents")).toEqual(["p"]);
    expect(lockedToKeep(doc, ["f"], "with-contents")).toEqual(["f"]);
    expect(stayedMessage(doc, nodeRegistry, ["p"])).toBe(
      "Prompt is in a locked frame, so it stayed. Unlock the frame to delete it.",
    );
    const store = createCanvasStore(detailOf(framed()));
    store.getState().actions.apply([{ op: "setLocked", id: "f", locked: true }]);
    store.getState().actions.deleteNodes(["f", "p"]);
    expect(store.getState().doc.order).toEqual(["f", "p", "g", "q"]);
  });

  test("copies are never locked, and a copy of a node in a locked frame lands outside it", () => {
    const store = createCanvasStore(detailOf(framed()));
    const { actions } = store.getState();
    actions.apply([
      { op: "setLocked", id: "f", locked: true },
      { op: "setLocked", id: "g", locked: true },
    ]);
    const [copyOfP, copyOfG] = actions.duplicateNodes(["p", "g"]);
    const doc = store.getState().doc;
    expect(doc.nodes[copyOfP!]).toMatchObject({ parentId: null, position: { x: 134, y: 94 } });
    expect(isLocked(doc, copyOfP!)).toBe(false);
    expect(isLocked(doc, copyOfG!)).toBe(false);
    expect(extractFragment(doc, ["g"]).nodes[0]!.locked).toBeUndefined();
  });
});

describe("node registry", () => {
  const ctx: EngineContext = { models: [], model: () => undefined, defaultModel: null };
  const port = (spec: Partial<PortSpec> & Pick<PortSpec, "id" | "direction" | "type">): PortSpec => ({
    arity: "single",
    items: "one",
    required: false,
    ...spec,
  });
  const def = (
    type: CanvasNode["type"],
    group: "references" | "image" | "utilities",
    order: number,
    ports: PortSpec[],
  ) =>
    defineNode({
      type,
      typeVersion: 1,
      label: "app.nav.canvas",
      description: "app.nav.canvas",
      icon: Type,
      category: "utility",
      menu: { group, order },
      size: { w: 100, h: 100 },
      resizable: false,
      annotation: false,
      ports,
      defaults: () => ({}),
      parseParams: () => ({}),
      runnable: false,
      Component: () => null,
    });
  const registry = createNodeRegistry([
    def("prompt", "utilities", 0, [port({ id: "text", direction: "out", type: "text", items: "one" })]),
    def("image.generate", "image", 0, [
      port({ id: "prompt", direction: "in", type: "text" }),
      port({ id: "input_images", direction: "in", type: "image", arity: "multi" }),
      port({ id: "preset", direction: "in", type: "preset", hidden: true }),
      port({ id: "images", direction: "out", type: "image", items: "list" }),
    ]),
    def("image.upload", "references", 0, [
      port({ id: "images", direction: "out", type: "image", items: "list" }),
    ]),
  ]);

  test("groups the menu in catalogue order and filters it for a dropped connection", () => {
    expect(registry.menu(ctx).map((g) => g.group)).toEqual(["references", "image", "utilities"]);
    // A connection dragged out of an Upload node's images.
    const pending: PendingConnection = {
      nodeId: "u",
      handleId: "images",
      handleType: "source",
      portType: "image",
    };
    const fromImage = registry.menu(ctx, pending);
    expect(fromImage[0]).toMatchObject({ group: "connects" });
    expect(fromImage[0]!.items.map((d) => d.type)).toEqual(["image.generate"]);
    expect(registry.fittingPort("image.generate", pending)?.id).toBe("input_images");
    expect(registry.ports("image.generate", "in").map((p) => p.id)).toEqual(["prompt", "input_images"]);
  });

  test("spreads rail ports 36 apart around the middle", () => {
    expect(railOffsets(3, 400)).toEqual([164, 200, 236]);
    expect(railOffsets(1, 151)).toEqual([75.5]);
  });

  test("new nodes carry the type's defaults and a fresh id", () => {
    const made = registry.instantiate("image.upload", { position: { x: 5, y: 6 }, ctx });
    expect(made).toMatchObject({
      type: "image.upload",
      size: { w: 100, h: 100 },
      parentId: null,
      result: null,
    });
    expect(made.id).toMatch(/^n_[0-9a-z]{26}$/);
  });
});

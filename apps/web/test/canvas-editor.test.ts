// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { generateSpec } from "@openfield/canvas/nodes/generate/spec";
import { promptSpec } from "@openfield/canvas/nodes/prompt/spec";
import type { CanvasDetail, CanvasVersion } from "@openfield/core";
import type { CanvasDocument, CanvasEdge, CanvasNode } from "@openfield/core/canvas";
import { createAutosave, type SaveOutcome } from "../src/canvas/editor/autosave";
import {
  type CaptureShape,
  createCaptureScheduler,
  MIN_INTERVAL_MS,
  openingCapture,
  outlineChanged,
} from "../src/canvas/editor/capture-schedule";
import { CANVAS_TOOL_FLAGS, shownGroups, TOOL_MANIFEST } from "../src/canvas/editor/chrome/toolbar";
import { parseFragment, serializeFragment } from "../src/canvas/editor/clipboard";
import { findMatches } from "../src/canvas/editor/find";
import {
  ANNOTATION_EDGE_TYPE,
  createEdgeCache,
  createNodeCache,
  DATA_EDGE_TYPE,
  type FlowNodeInputs,
  FRAME_COLLAPSED_HEIGHT,
  UNKNOWN_NODE_SIZE,
  UNKNOWN_NODE_TYPE,
} from "../src/canvas/editor/flow/adapter";
import {
  alignOps,
  alignToNeighbours,
  distributeOps,
  dropOp,
  GROUP_PADDING,
  groupIntoFrameOps,
  type SizeOf,
  ungroupOps,
} from "../src/canvas/editor/geometry";
import { nextInWalk, walkOrder } from "../src/canvas/editor/keyboard-nav";
import { matchShortcut, shortcutSheet, toolKey } from "../src/canvas/editor/shortcuts";
import { groupVersions } from "../src/canvas/editor/versions/rows";
import { matchScore } from "../src/canvas/nodes/add-node-menu";
import type { NodeDefinition } from "../src/canvas/nodes/registry";
import {
  applyOps,
  CANVAS_FRAGMENT_KIND,
  createCanvasStore,
  type DocSlice,
  emptyDocument,
  extractFragment,
  fromDocument,
} from "../src/canvas/store";

const CANVAS_ID = "01K6BQ8000000000000000CNVS";
const AT = "2026-09-23T09:12:04.118Z";

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "note",
  typeVersion: 1,
  position: { x: 0, y: 0 },
  size: { w: 100, h: 100 },
  parentId: null,
  collapsed: false,
  title: null,
  params: {},
  presetLocks: [],
  result: null,
  ...extra,
});

const edge = (id: string, source: string, target: string, extra: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id,
  source,
  sourceHandle: "images",
  target,
  targetHandle: "input_images",
  kind: "data",
  ...extra,
});

const doc = (nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasDocument => ({
  ...emptyDocument(CANVAS_ID, "Mug campaign", AT),
  nodes,
  edges,
});

const slice = (nodes: CanvasNode[], edges: CanvasEdge[] = []): DocSlice =>
  fromDocument(doc(nodes, edges)).slice;

const detail = (d: CanvasDocument): CanvasDetail => ({
  id: CANVAS_ID,
  name: d.name,
  graph: d,
  graphVersion: 3,
  updatedAt: AT,
});

/** Sizes as React Flow would measure them: the saved size. */
const sizeFrom =
  (s: DocSlice): SizeOf =>
  (id) =>
    s.nodes[id]?.size;

const DEFS: Record<string, NodeDefinition> = {
  note: { type: "note", size: { w: 240, h: 240 } } as unknown as NodeDefinition,
  frame: { type: "frame", size: { w: 640, h: 420 } } as unknown as NodeDefinition,
  text: { type: "text", size: null } as unknown as NodeDefinition,
};

const inputs = (s: DocSlice, extra: Partial<FlowNodeInputs> = {}): FlowNodeInputs => ({
  doc: s,
  selection: { nodeIds: [], edgeIds: [] },
  readOnly: false,
  tool: "select",
  measured: new Map(),
  findHit: null,
  definition: (type) => DEFS[type],
  ...extra,
});

describe("flow adapter", () => {
  test("frames come before their nodes, sit under everything, and fold their nodes away", () => {
    const s = slice([
      node("child", { parentId: "f", position: { x: 20, y: 30 } }),
      node("f", { type: "frame", size: { w: 400, h: 300 }, collapsed: true }),
      node("text", { type: "text", size: undefined }),
    ]);
    const nodes = createNodeCache()(inputs(s));
    expect(nodes.map((n) => n.id)).toEqual(["f", "child", "text"]);
    const frame = nodes[0]!;
    expect(frame.zIndex).toBe(-1);
    expect(frame.height).toBe(FRAME_COLLAPSED_HEIGHT);
    expect(frame.width).toBe(400);
    expect(nodes[1]!.hidden).toBe(true);
    expect(nodes[1]!.parentId).toBe("f");
    // Sized by its content: React Flow measures it.
    expect(nodes[2]!.width).toBeUndefined();
    expect(nodes[2]!.deletable).toBe(false);
  });

  test("a type this build doesn't know renders the placeholder at a default size", () => {
    const s = slice([node("x", { type: "image.edit", size: undefined })]);
    const [flow] = createNodeCache()(inputs(s));
    expect(flow!.type).toBe(UNKNOWN_NODE_TYPE);
    expect(flow!.width).toBe(UNKNOWN_NODE_SIZE.w);
  });

  test("unchanged nodes keep their object, so React Flow skips them", () => {
    const s = slice([node("a"), node("b", { position: { x: 300, y: 0 } })]);
    const build = createNodeCache();
    const first = build(inputs(s));
    const moved = applyOps(s, [{ op: "moveNode", id: "b", position: { x: 310, y: 0 } }]).doc;
    const second = build(inputs(moved));
    expect(second[0]).toBe(first[0]!);
    expect(second[1]).not.toBe(first[1]!);
    const third = build(inputs(moved, { selection: { nodeIds: ["a"], edgeIds: [] } }));
    expect(third[0]!.selected).toBe(true);
    expect(third[1]).toBe(second[1]!);
  });

  test("the pan tool and a previewed version make nodes inert", () => {
    const s = slice([node("a")]);
    const [pan] = createNodeCache()(inputs(s, { tool: "pan" }));
    expect(pan!.draggable).toBe(false);
    const [preview] = createNodeCache()(inputs(s, { readOnly: true }));
    expect(preview!.selectable).toBe(false);
  });

  test("edges get their recipe, and image into mask is marked for the coercion glyph", () => {
    const s = slice(
      [node("a"), node("b")],
      [
        edge("e1", "a", "b"),
        edge("e2", "a", "b", { targetHandle: "mask" }),
        edge("e3", "a", "b", {
          sourceHandle: "arrow-source-right",
          targetHandle: "arrow-target-left",
          kind: "annotation",
        }),
      ],
    );
    const ports: Record<string, "image" | "mask"> = { images: "image", input_images: "image", mask: "mask" };
    const edges = createEdgeCache()({
      doc: s,
      selection: { nodeIds: [], edgeIds: ["e1"] },
      readOnly: false,
      portType: (_type, handle) => ports[handle],
    });
    expect(edges.map((e) => e.type)).toEqual([DATA_EDGE_TYPE, DATA_EDGE_TYPE, ANNOTATION_EDGE_TYPE]);
    expect(edges[0]!.selected).toBe(true);
    expect(edges.map((e) => e.data?.coerce)).toEqual([false, true, false]);
    expect(edges[2]!.reconnectable).toBe(false);
  });
});

describe("geometry", () => {
  const three = () =>
    slice([
      node("a", { position: { x: 0, y: 0 } }),
      node("b", { position: { x: 150, y: 40 }, size: { w: 50, h: 50 } }),
      node("c", { position: { x: 400, y: 10 } }),
    ]);

  test("align left and middle move boxes, not the ones already in line", () => {
    const s = three();
    expect(alignOps(s, ["a", "b", "c"], "left", sizeFrom(s))).toEqual([
      { op: "moveNode", id: "b", position: { x: 0, y: 40 } },
      { op: "moveNode", id: "c", position: { x: 0, y: 10 } },
    ]);
    const middle = alignOps(s, ["a", "b"], "middle", sizeFrom(s));
    // a spans the union (0..100), so only b moves to its middle.
    expect(middle).toEqual([{ op: "moveNode", id: "b", position: { x: 150, y: 25 } }]);
  });

  test("distribute keeps the ends and evens the gaps", () => {
    const s = three();
    // Boxes span 0..500 with 250 px of boxes: gaps of 125.
    expect(distributeOps(s, ["a", "b", "c"], "x", sizeFrom(s))).toEqual([
      { op: "moveNode", id: "b", position: { x: 225, y: 40 } },
    ]);
    expect(distributeOps(s, ["a", "b"], "x", sizeFrom(s))).toEqual([]);
  });

  test("group into frame wraps the selection with padding and moves it inside, as one change", () => {
    const s = three();
    const plan = groupIntoFrameOps(s, ["a", "b"], sizeFrom(s), (position, size, parentId) =>
      node("f", { type: "frame", position, size, parentId }),
    )!;
    const [add, ...moves] = plan.ops;
    expect(add).toMatchObject({
      op: "addNode",
      index: 0,
      node: { id: "f", position: { x: -GROUP_PADDING, y: -GROUP_PADDING }, size: { w: 264, h: 164 } },
    });
    expect(moves).toEqual([
      { op: "reparent", id: "a", parentId: "f", position: { x: 32, y: 32 } },
      { op: "reparent", id: "b", parentId: "f", position: { x: 182, y: 72 } },
    ]);
    const grouped = applyOps(s, plan.ops).doc;
    const back = applyOps(grouped, ungroupOps(grouped, ["f"])).doc;
    expect(back.nodes.a!.position).toEqual({ x: 0, y: 0 });
    expect(back.nodes.b).toMatchObject({ parentId: null, position: { x: 150, y: 40 } });
    expect(back.nodes.f).toBeUndefined();
  });

  test("a node dropped on a frame joins it; dragged out, it leaves", () => {
    const s = slice([
      node("f", { type: "frame", position: { x: 100, y: 100 }, size: { w: 400, h: 300 } }),
      node("a", { position: { x: 150, y: 150 }, size: { w: 50, h: 50 } }),
      node("inner", { parentId: "f", position: { x: 500, y: 10 }, size: { w: 50, h: 50 } }),
    ]);
    expect(dropOp(s, "a", sizeFrom(s))).toEqual({
      op: "reparent",
      id: "a",
      parentId: "f",
      position: { x: 50, y: 50 },
    });
    // Its centre is outside the frame now.
    expect(dropOp(s, "inner", sizeFrom(s))).toEqual({
      op: "reparent",
      id: "inner",
      parentId: null,
      position: { x: 600, y: 110 },
    });
    // A frame never drops into itself.
    expect(dropOp(s, "f", sizeFrom(s))).toBeNull();
  });
});

describe("alignment guides", () => {
  test("the nearest edge or centre within reach lines up, on each axis, with a line to draw", () => {
    const neighbour = { x: 0, y: 0, w: 100, h: 100 };
    const moving = { x: 203, y: 52, w: 100, h: 100 };
    const far = alignToNeighbours(moving, [neighbour], 4);
    // Too far across; its top is 2 below the neighbour's middle (50), within reach.
    expect(far).toMatchObject({ dx: 0, dy: -2 });
    expect(far.guides).toEqual([{ axis: "y", at: 50, from: 0, to: 303 }]);
    const near = alignToNeighbours({ ...moving, x: 102 }, [neighbour], 4);
    expect(near.dx).toBe(-2);
    expect(near.guides.map((g) => g.axis)).toEqual(["x", "y"]);
    expect(alignToNeighbours({ ...moving, y: 300 }, [neighbour], 4)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe("toolbar", () => {
  test("slots for tools that haven't shipped are in the manifest, flagged off, and draw nothing", () => {
    const flagged = TOOL_MANIFEST.flat().flatMap((tool) => (tool.flag ? [tool.flag as string] : []));
    expect(flagged.sort()).toEqual(Object.keys(CANVAS_TOOL_FLAGS).sort());
    expect(Object.values(CANVAS_TOOL_FLAGS).every((on) => !on)).toBe(true);
    expect(shownGroups().map((group) => group.map((tool) => tool.id))).toEqual([
      ["tool.select", "tool.pan"],
      ["tool.note", "tool.shape", "tool.text"],
      ["tool.frame"],
      ["find", "add"],
    ]);
  });
});

describe("clipboard", () => {
  test("a copied selection comes back whole, and junk comes back as nothing", () => {
    const s = slice(
      [node("f", { type: "frame" }), node("a", { parentId: "f", params: { text: "hi" } }), node("b")],
      [edge("e1", "a", "b")],
    );
    const text = serializeFragment(extractFragment(s, ["f", "b"]), CANVAS_ID);
    const back = parseFragment(text)!;
    expect(back.kind).toBe(CANVAS_FRAGMENT_KIND);
    expect(back.canvasId).toBe(CANVAS_ID);
    expect(back.nodes.map((n) => n.id)).toEqual(["f", "a", "b"]);
    expect(back.edges).toHaveLength(1);
    expect(parseFragment("not json")).toBeNull();
    expect(parseFragment(JSON.stringify({ kind: "other", nodes: [], edges: [] }))).toBeNull();
    expect(
      parseFragment(JSON.stringify({ kind: CANVAS_FRAGMENT_KIND, nodes: [{ id: 1 }], edges: [] })),
    ).toBeNull();
  });

  test("nodes whose frame didn't come along land at the top level, and stray edges are dropped", () => {
    const raw = {
      kind: CANVAS_FRAGMENT_KIND,
      nodes: [node("a", { parentId: "gone" })],
      edges: [edge("e1", "a", "missing")],
    };
    const back = parseFragment(JSON.stringify(raw))!;
    expect(back.nodes[0]!.parentId).toBeNull();
    expect(back.edges).toEqual([]);
  });
});

describe("shortcuts", () => {
  const key = (
    k: string,
    extra: Partial<{ code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
  ) => ({
    key: k,
    code: extra.code ?? "",
    metaKey: !!extra.meta,
    ctrlKey: !!extra.ctrl,
    shiftKey: !!extra.shift,
    altKey: !!extra.alt,
  });

  test("the sheet's keys do what it says, on a Mac and elsewhere", () => {
    expect(matchShortcut(key("z", { meta: true }), true)).toBe("undo");
    expect(matchShortcut(key("z", { meta: true, shift: true }), true)).toBe("redo");
    expect(matchShortcut(key("z", { ctrl: true }), false)).toBe("undo");
    expect(matchShortcut(key("z", { ctrl: true }), true)).toBeNull();
    expect(matchShortcut(key("Enter", { meta: true }), true)).toBe("run.node");
    expect(matchShortcut(key("Enter", { meta: true, shift: true }), true)).toBe("run.downstream");
    expect(matchShortcut(key("Enter", { meta: true, alt: true }), true)).toBe("run.all");
    expect(matchShortcut(key("!", { code: "Digit1", shift: true }), true)).toBe("zoom.fit");
    expect(matchShortcut(key("Backspace"), true)).toBe("delete");
    expect(matchShortcut(key("n"), true)).toBe("tool.note");
    expect(matchShortcut(key("f", { meta: true }), true)).toBe("find");
    expect(matchShortcut(key("?", { shift: true }), true)).toBe("help");
  });

  test("while typing, only the keys that make sense in a text field fire", () => {
    expect(matchShortcut(key("n"), true, true)).toBeNull();
    expect(matchShortcut(key("Backspace"), true, true)).toBeNull();
    expect(matchShortcut(key("s", { meta: true }), true, true)).toBe("save");
    expect(matchShortcut(key("Escape"), true, true)).toBe("escape");
  });
});

describe("autosave", () => {
  interface Timer {
    fn: () => void;
    at: number;
  }
  function harness(outcomes: SaveOutcome[]) {
    let now = 0;
    const timers = new Set<Timer>();
    const store = createCanvasStore(detail(doc([node("a")])), { now: () => now });
    const saves: unknown[] = [];
    const autosave = createAutosave(store, {
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { fn, at: now + ms };
        timers.add(timer);
        return timer;
      },
      clearTimer: (h) => timers.delete(h as Timer),
      save: async (body) => {
        saves.push(body);
        return outcomes.shift() ?? { kind: "saved", graphVersion: 4 + saves.length, updatedAt: AT };
      },
    });
    const advance = async (ms: number) => {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.fn();
      }
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    const move = (x: number) =>
      store.getState().actions.apply([{ op: "moveNode", id: "a", position: { x, y: 0 } }]);
    return { store, autosave, saves, advance, move };
  }

  test("saves 800 ms after the last change, with the version it started from", async () => {
    const h = harness([]);
    h.move(10);
    await h.advance(500);
    h.move(20);
    await h.advance(700);
    expect(h.saves).toHaveLength(0);
    await h.advance(100);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ graphVersion: 3 });
    expect(h.store.getState().persist).toMatchObject({ status: "saved", graphVersion: 5 });
  });

  test("keeps saving at least every 10 s while changes keep coming", async () => {
    const h = harness([]);
    for (let t = 0; t < 10_400; t += 400) {
      h.move(t);
      await h.advance(400);
    }
    expect(h.saves.length).toBeGreaterThanOrEqual(1);
  });

  test("a 409 shows the other copy and stops saving until Keep mine", async () => {
    const server = detail(doc([node("a"), node("b")]));
    const h = harness([{ kind: "conflict", server: { ...server, graphVersion: 9 } }]);
    h.move(10);
    await h.advance(800);
    expect(h.store.getState().persist.status).toBe("conflict");
    h.move(20);
    await h.advance(2000);
    expect(h.saves).toHaveLength(1);
    h.store.getState().actions.keepMine();
    await h.advance(800);
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1]).toMatchObject({ graphVersion: 9 });
    expect(h.store.getState().persist.status).toBe("saved");
  });

  test("a lost connection says so and tries again with backoff", async () => {
    const h = harness([{ kind: "retry" }, { kind: "retry" }]);
    h.move(10);
    await h.advance(800);
    expect(h.store.getState().persist.status).toBe("offline");
    await h.advance(1000);
    expect(h.saves).toHaveLength(2);
    await h.advance(1000);
    expect(h.saves).toHaveLength(2);
    await h.advance(1000);
    expect(h.saves).toHaveLength(3);
    expect(h.store.getState().persist.status).toBe("saved");
  });

  test("pans save lazily, and a rename goes along with the next save", async () => {
    const h = harness([]);
    h.store.getState().actions.setViewport({ x: 10, y: 0, zoom: 1 });
    await h.advance(1000);
    expect(h.saves).toHaveLength(0);
    await h.advance(1000);
    expect(h.saves).toHaveLength(1);
    h.store.getState().actions.apply([{ op: "setName", name: "Spring campaign" }]);
    await h.advance(800);
    expect(h.saves[1]).toMatchObject({ name: "Spring campaign" });
  });

  test("a save refused for good says why and waits for the next change, without retrying", async () => {
    const h = harness([{ kind: "failed", failure: "too_big" }]);
    h.move(10);
    await h.advance(800);
    expect(h.store.getState().persist).toMatchObject({ status: "failed", failure: "too_big" });
    await h.advance(60_000);
    expect(h.saves).toHaveLength(1);
    // A change (say, deleting what made it too big) tries again.
    h.move(20);
    await h.advance(800);
    expect(h.saves).toHaveLength(2);
    expect(h.store.getState().persist).toMatchObject({ status: "saved", failure: null });
  });

  test("flush saves at once and waits for the server", async () => {
    const h = harness([]);
    h.move(10);
    await h.autosave.flush();
    expect(h.saves).toHaveLength(1);
    expect(h.store.getState().persist.status).toBe("saved");
  });
});

describe("find", () => {
  test("titles, text and model names match, in reading order", () => {
    const s = slice([
      node("low", { position: { x: 0, y: 500 }, params: { text: "Lighthouse at dusk" } }),
      node("gen", { type: "image.generate", position: { x: 300, y: 0 }, params: { model: "google:nano" } }),
      node("titled", { position: { x: 0, y: 0 }, title: "Lighthouse notes" }),
    ]);
    const sources = {
      label: (type: string) => type,
      modelName: (key: string) => (key === "google:nano" ? "Nano Banana" : undefined),
    };
    expect(findMatches(s, "lighthouse", sources)).toEqual(["titled", "low"]);
    expect(findMatches(s, "banana", sources)).toEqual(["gen"]);
    expect(findMatches(s, "  ", sources)).toEqual([]);
  });
});

describe("version rows", () => {
  const version = (id: string, createdAt: string, extra: Partial<CanvasVersion> = {}): CanvasVersion => ({
    id,
    label: null,
    kind: "auto",
    createdAt,
    nodeCount: 3,
    edgeCount: 1,
    coverAssetId: null,
    ...extra,
  });

  test("the current canvas leads Today; then days, newest first, with names and reasons", () => {
    const now = new Date(2026, 8, 23, 12, 0);
    const groups = groupVersions(
      [
        version("old", new Date(2026, 8, 20, 9, 0).toISOString()),
        version("named", new Date(2026, 8, 23, 10, 51).toISOString(), {
          label: "Before new lighting",
          kind: "named",
        }),
        version("y", new Date(2026, 8, 22, 18, 25).toISOString(), {
          kind: "before_delete",
          nodeCount: 1,
          edgeCount: 0,
        }),
      ],
      { nodeCount: 7, edgeCount: 8, coverAssetId: null },
      now,
    );
    expect(groups.map((g) => g.label.length > 0)).toEqual([true, true, true]);
    expect(groups[0]!.rows.map((r) => r.title)).toEqual(["Current version", "Before new lighting"]);
    expect(groups[0]!.rows[0]!.meta).toBe("Now · 7 nodes · 8 connections");
    expect(groups[1]!.label).toBe("Yesterday");
    expect(groups[1]!.rows[0]!.meta).toBe("Before a big delete · 1 node · 0 connections");
    expect(groups[2]!.rows[0]!.meta).toBe("3 nodes · 1 connection");
  });
});

describe("keyboard walk", () => {
  test("Tab follows run order, skips folded frames' nodes, and lets go at the ends", () => {
    const s = slice(
      [
        node("gen", { type: "image.generate" }),
        node("prompt", { type: "prompt" }),
        node("f", { type: "frame", collapsed: true }),
        node("inside", { parentId: "f" }),
      ],
      [edge("e1", "prompt", "gen", { sourceHandle: "text", targetHandle: "prompt" })],
    );
    expect(walkOrder(s)).toEqual(["prompt", "f", "gen"]);
    expect(nextInWalk(s, null, 1)).toBe("prompt");
    expect(nextInWalk(s, "prompt", 1)).toBe("f");
    expect(nextInWalk(s, "gen", 1)).toBeNull();
    expect(nextInWalk(s, "prompt", -1)).toBeNull();
  });
});

describe("add node search", () => {
  test("a name match beats a node that only mentions the word", () => {
    // "Make images from a prompt" mentions it; Prompt is it.
    expect(matchScore(promptSpec, "prompt")).toBe(0);
    expect(matchScore(generateSpec, "prompt")).toBe(4);
    expect(matchScore(generateSpec, "gen")).toBe(1);
    expect(matchScore(generateSpec, "gnrt")).toBe(5);
    expect(matchScore(generateSpec, "zebra")).toBeNull();
  });
});

describe("key hints", () => {
  test("menus and the sheet name each platform's keys", () => {
    expect(toolKey("run.node", true)).toBe("⌘ enter");
    expect(toolKey("run.node", false)).toBe("Ctrl+enter");
    expect(toolKey("duplicate", false)).toBe("Ctrl+D");
    const rows = shortcutSheet(false)
      .flat()
      .flatMap((g) => g.rows);
    expect(rows.every((r) => !/[⌘⌥⇧]/.test(r.keys))).toBe(true);
    expect(rows.find((r) => r.label === "canvas.editor.shortcuts.nodeMenu")?.keys).toBe("Shift+F10");
  });

  test("⌥ with Run from here is still Run from here (it makes new images below too)", () => {
    const key = { key: "Enter", code: "Enter", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true };
    expect(matchShortcut(key, true)).toBe("run.downstream");
    expect(matchShortcut({ ...key, shiftKey: false }, true)).toBe("run.all");
  });
});

describe("preview capture", () => {
  test("only an outline change of a tenth or more counts", () => {
    const box = { x: 0, y: 0, w: 1000, h: 500 };
    expect(outlineChanged(null, box)).toBe(true);
    expect(outlineChanged(box, { ...box, w: 1050 })).toBe(false);
    expect(outlineChanged(box, { ...box, w: 1200 })).toBe(true);
    expect(outlineChanged(box, { ...box, y: 80 })).toBe(true);
  });

  function scheduler(initial: (CaptureShape & { at: number }) | null = null) {
    let clock = 1_000_000;
    let shape: CaptureShape = { bounds: { x: 0, y: 0, w: 1000, h: 500 }, count: 3, results: "g=" };
    const timers: { fn: () => void; at: number }[] = [];
    const log: string[] = [];
    const s = createCaptureScheduler({
      initial,
      shape: () => shape,
      start: (taken) => log.push(`start ${taken.results}`),
      idle: () => log.push("idle"),
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer = { fn, at: clock + ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: (h) => timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
    });
    return {
      s,
      log,
      set: (next: Partial<CaptureShape>) => {
        shape = { ...shape, ...next };
      },
      advance: (ms: number) => {
        clock += ms;
        for (const timer of timers.splice(0).filter((t) => t.at <= clock)) timer.fn();
      },
      pending: () => timers.length,
    };
  }

  test("results arriving are a reason for a new picture, a minute after the last", () => {
    const t = scheduler();
    t.s.request();
    t.s.finished(true);
    // Same outline, new images: waits out the minute, then takes it.
    t.set({ results: "g=done:A" });
    t.s.request();
    expect(t.log).toEqual(["start g="]);
    expect(t.pending()).toBe(1);
    t.advance(MIN_INTERVAL_MS);
    expect(t.log).toEqual(["start g=", "start g=done:A"]);
    t.s.finished(true);
    // Nothing new: nothing taken.
    t.s.request();
    expect(t.log.length).toBe(2);
  });

  test("leaving the editor takes a picture that was waiting, then lets go", () => {
    const t = scheduler();
    t.s.request();
    t.s.finished(true);
    t.set({ count: 7, bounds: { x: 0, y: 0, w: 2000, h: 900 } });
    t.s.request();
    expect(t.pending()).toBe(1);
    t.s.leave();
    expect(t.pending()).toBe(0);
    expect(t.log).toEqual(["start g=", "start g="]);
    t.s.finished(true);
    expect(t.log.at(-1)).toBe("idle");
  });

  test("a save during a picture is looked at once it's done; a failed one isn't retried after leaving", () => {
    const t = scheduler();
    t.s.request();
    t.set({ results: "g=failed:" });
    t.s.request();
    expect(t.log).toEqual(["start g="]);
    t.s.leave();
    t.s.finished(false);
    expect(t.log).toEqual(["start g=", "idle"]);
  });

  test("the picture the index has counts, unless results came in after it", () => {
    const opened = slice([node("n")]);
    const taken = "2026-09-24T10:00:00.000Z";
    expect(openingCapture(opened, null)).toBeNull();
    expect(openingCapture(opened, taken)?.at).toBe(Date.parse(taken));
    const result = {
      state: "done" as const,
      assetIds: [],
      jobSetId: null,
      jobSetIds: [],
      outputs: [],
      fingerprint: null,
      costUsd: null,
      ranAt: "2026-09-24T11:00:00.000Z",
      error: null,
    };
    expect(openingCapture(slice([node("n", { result })]), taken)).toBeNull();
  });
});

// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import {
  type CanvasEdit,
  type CanvasWireOp,
  canvasEditsSchema,
  canvasWireOpSchema,
} from "@openfield/core/canvas";
import { compileEdits, EditError } from "../src/edits/compile";
import { lockProblem } from "../src/edits/locks";
import { FRAME_INSET, nodeRect, PLACE_MARGIN, placeNode, type Rect } from "../src/edits/place";
import { fromWireOps, toWireOps } from "../src/edits/wire";
import { specRegistry } from "../src/nodes/specs";
import { absolutePosition } from "../src/store/graph";
import { applyOps, type CanvasOp, type DocSlice } from "../src/store/ops";
import { banana, counters, ctx, docOf, edge, node } from "./fixtures";

const compile = (
  doc: DocSlice,
  edits: CanvasEdit[],
  extra: Parameters<typeof compileEdits>[2] | object = {},
) => compileEdits(doc, canvasEditsSchema.parse(edits), { specs: specRegistry, ctx, ...counters(), ...extra });

function failure(run: () => unknown): EditError {
  try {
    run();
  } catch (error) {
    if (error instanceof EditError) return error;
    throw error;
  }
  throw new Error("Expected an EditError");
}

const rectsOverlap = (doc: DocSlice) => {
  const rects = doc.order.map((id) => nodeRect(doc, specRegistry, id)!);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
    }
  return false;
};

describe("compileEdits", () => {
  test("builds a prompt → generate chain from aliases, with defaults and a free place", () => {
    const base = docOf([node("n_old", "note", { position: { x: 0, y: 0 }, size: { w: 240, h: 240 } })]);
    const out = compile(base, [
      { op: "add_node", as: "p", type: "prompt", params: { text: "A lighthouse at dusk" } },
      { op: "add_node", as: "g", type: "image.generate", params: { batch: 2 } },
      { op: "connect", source: "p", target: "g" },
    ]);
    expect(out.aliases).toEqual({ p: "n_1", g: "n_2" });
    expect(out.ops.map((o) => o.op)).toEqual(["addNode", "addNode", "addEdge"]);
    const edge = Object.values(out.doc.edges)[0]!;
    // The one port that fits: Prompt's text into Generate's prompt.
    expect(edge).toMatchObject({
      source: "n_1",
      sourceHandle: "text",
      target: "n_2",
      targetHandle: "prompt",
    });
    // Generate starts from its type's defaults, then the settings given.
    expect(out.doc.params.n_2).toMatchObject({ model: banana.key, batch: 2, prompt: "" });
    expect(out.touched).toEqual(["n_1", "n_2"]);
    expect(rectsOverlap(out.doc)).toBe(false);
    // The generate node sits to the right of the prompt that feeds it.
    const prompt = nodeRect(out.doc, specRegistry, "n_1")!;
    const generate = nodeRect(out.doc, specRegistry, "n_2")!;
    expect(generate.x).toBeGreaterThan(prompt.x + prompt.w);
  });

  test("the ops replay to the same document", () => {
    const base = docOf([]);
    const out = compile(base, [
      { op: "add_node", as: "p", type: "prompt" },
      { op: "add_node", as: "g", type: "image.generate" },
      { op: "connect", source: "p", target: "g" },
      { op: "update_node", id: "g", params: { prompt: "long exposure" }, title: "Hero shot" },
      { op: "rename_canvas", name: "Lighthouse" },
    ]);
    expect(applyOps(base, out.ops).doc).toEqual(out.doc);
    expect(out.doc.name).toBe("Lighthouse");
    expect(out.doc.nodes.n_2!.title).toBe("Hero shot");
  });

  test("refuses the whole batch when one edit doesn't fit, naming the edit", () => {
    const base = docOf([]);
    const error = failure(() =>
      compile(base, [
        { op: "add_node", as: "p", type: "prompt" },
        { op: "connect", source: "p", target: "nope" },
      ]),
    );
    expect(error.index).toBe(1);
    expect(error.code).toBe("no_node");
    expect(error.message).toBe("There's no node nope on this canvas.");
  });

  test("checks settings against the node type", () => {
    const base = docOf([]);
    const typo = failure(() =>
      compile(base, [{ op: "add_node", type: "image.generate", params: { promt: "x" } }]),
    );
    expect(typo.code).toBe("bad_param");
    expect(typo.message).toContain("no setting called promt");
    expect(typo.message).toContain("prompt");
    const batch = failure(() =>
      compile(base, [{ op: "add_node", type: "image.generate", params: { batch: 12 } }]),
    );
    expect(batch.code).toBe("bad_param");
    const model = failure(() =>
      compile(base, [{ op: "add_node", type: "image.generate", params: { model: "google:nope" } }]),
    );
    expect(model.code).toBe("bad_model");
    const edit = failure(() => compile(base, [{ op: "add_node", type: "image.edit" }]));
    expect(edit.code).toBe("not_supported");
  });

  test("update_node merges settings and removes the ones set to null", () => {
    const base = docOf([
      node("n_g", "image.generate", { params: { model: banana.key, prompt: "a", batch: 3 } }),
    ]);
    const out = compile(base, [{ op: "update_node", id: "n_g", params: { prompt: "b", batch: null } }]);
    expect(out.doc.params.n_g).toEqual({ model: banana.key, prompt: "b" });
    const wire = toWireOps(out.ops);
    expect(wire).toEqual([{ op: "setParams", id: "n_g", patch: { prompt: "b" }, unset: ["batch"] }]);
  });

  test("a single input is replaced, and a multi input keeps the connection order", () => {
    const base = docOf(
      [
        node("n_p1", "prompt"),
        node("n_p2", "prompt"),
        node("n_u1", "image.upload"),
        node("n_u2", "image.upload"),
        node("n_g", "image.generate"),
      ],
      [edge("e_a", "n_p1", "text", "n_g", "prompt"), edge("e_b", "n_u1", "images", "n_g", "input_images")],
    );
    const out = compile(base, [
      { op: "connect", source: "n_p2", target: "n_g" },
      { op: "connect", source: "n_u2", target: "n_g" },
    ]);
    expect(out.ops[0]).toEqual({ op: "deleteEdge", id: "e_a" });
    const references = Object.values(out.doc.edges).filter((e) => e.targetHandle === "input_images");
    expect(references.map((e) => [e.source, e.order])).toEqual([
      ["n_u1", undefined],
      ["n_u2", 1],
    ]);
  });

  test("connecting again changes nothing, and loops and mismatches are refused", () => {
    const base = docOf(
      [node("n_p", "prompt"), node("n_g", "image.generate"), node("n_v", "image.variations")],
      [edge("e_1", "n_p", "text", "n_g", "prompt"), edge("e_2", "n_g", "images", "n_v", "image")],
    );
    expect(compile(base, [{ op: "connect", source: "n_p", target: "n_g" }]).ops).toEqual([]);
    const loop = failure(() =>
      compile(base, [{ op: "connect", source: "n_v", target: "n_g", targetHandle: "input_images" }]),
    );
    expect(loop.message).toBe("That would create a loop.");
    const mismatch = failure(() =>
      compile(base, [{ op: "connect", source: "n_g", target: "n_g", targetHandle: "prompt" }]),
    );
    expect(mismatch.code).toBe("cant_connect");
    const noPort = failure(() =>
      compile(base, [{ op: "connect", source: "n_p", target: "n_g", targetHandle: "x" }]),
    );
    expect(noPort.message).toContain("Its inputs: prompt, input_images");
  });

  test("arrows join annotation sides", () => {
    const base = docOf([node("n_a", "note"), node("n_b", "note")]);
    const out = compile(base, [{ op: "connect", source: "n_a", target: "n_b", kind: "annotation" }]);
    expect(Object.values(out.doc.edges)[0]).toMatchObject({
      kind: "annotation",
      sourceHandle: "arrow-source-right",
      targetHandle: "arrow-target-left",
    });
  });

  test("disconnect by id or by the nodes it joins", () => {
    const base = docOf(
      [node("n_p", "prompt"), node("n_g", "image.generate")],
      [edge("e_1", "n_p", "text", "n_g", "prompt")],
    );
    expect(compile(base, [{ op: "disconnect", edgeId: "e_1" }]).doc.edgeOrder).toEqual([]);
    expect(compile(base, [{ op: "disconnect", source: "n_p", target: "n_g" }]).doc.edgeOrder).toEqual([]);
    expect(failure(() => compile(base, [{ op: "disconnect", edgeId: "e_9" }])).code).toBe("no_edge");
    expect(failure(() => compile(base, [{ op: "disconnect" }])).code).toBe("bad_edit");
  });

  test("frames: add inside, move out, and removing one keeps its nodes where they show", () => {
    const base = docOf([
      node("n_f", "frame", { position: { x: 100, y: 100 }, size: { w: 640, h: 420 } }),
      node("n_in", "note", { parentId: "n_f", position: { x: 24, y: 48 }, size: { w: 240, h: 240 } }),
    ]);
    const added = compile(base, [{ op: "add_node", as: "t", type: "note", parentId: "n_f" }]);
    const t = added.aliases.t!;
    expect(added.doc.nodes[t]!.parentId).toBe("n_f");
    const inside = nodeRect(added.doc, specRegistry, t)!;
    expect(inside.x).toBeGreaterThanOrEqual(100);
    expect(inside.x + inside.w).toBeLessThanOrEqual(740);
    expect(rectsOverlap({ ...added.doc, order: added.doc.order.filter((id) => id !== "n_f") })).toBe(false);

    const moved = compile(base, [{ op: "move_node", id: "n_in", parentId: null }]);
    expect(moved.doc.nodes.n_in).toMatchObject({ parentId: null, position: { x: 124, y: 148 } });

    const removed = compile(base, [{ op: "remove_nodes", ids: ["n_f"] }]);
    expect(removed.doc.nodes.n_f).toBeUndefined();
    expect(removed.doc.nodes.n_in).toMatchObject({ parentId: null, position: { x: 124, y: 148 } });
    expect(removed.touched).toEqual([]);

    expect(failure(() => compile(base, [{ op: "move_node", id: "n_f", parentId: "n_in" }])).code).toBe(
      "not_frame",
    );
    expect(failure(() => compile(base, [{ op: "move_node", id: "n_f", parentId: "n_f" }])).code).toBe(
      "bad_edit",
    );
  });

  test("positions are canvas coordinates, inside a frame too", () => {
    const base = docOf([node("n_f", "frame", { position: { x: 100, y: 100 }, size: { w: 640, h: 420 } })]);
    const out = compile(base, [
      { op: "add_node", as: "n", type: "note", parentId: "n_f", position: { x: 300, y: 200 } },
    ]);
    const id = out.aliases.n!;
    expect(out.doc.nodes[id]!.position).toEqual({ x: 200, y: 100 });
    expect(absolutePosition(out.doc, id)).toEqual({ x: 300, y: 200 });
  });

  test("aliases can't repeat or shadow a node id", () => {
    const base = docOf([node("n_p", "prompt")]);
    expect(
      failure(() =>
        compile(base, [
          { op: "add_node", as: "a", type: "prompt" },
          { op: "add_node", as: "a", type: "prompt" },
        ]),
      ).code,
    ).toBe("bad_alias");
    expect(failure(() => compile(base, [{ op: "add_node", as: "n_p", type: "prompt" }])).code).toBe(
      "bad_alias",
    );
  });
});

describe("placeNode", () => {
  test("an empty canvas takes the node where the person last looked", () => {
    const at = placeNode(docOf([]), specRegistry, {
      size: { w: 200, h: 100 },
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(at).toEqual({ x: 624, y: 400 });
  });

  test("never lands on another node, however crowded", () => {
    let doc = docOf([]);
    for (let i = 0; i < 30; i++) {
      const at = placeNode(doc, specRegistry, { size: { w: 240, h: 240 }, near: i ? `n_${i - 1}` : null });
      doc = applyOps(doc, [
        { op: "addNode", node: node(`n_${i}`, "note", { position: at, size: { w: 240, h: 240 } }) },
      ]).doc;
    }
    expect(rectsOverlap(doc)).toBe(false);
    // And keeps its distance.
    const rects = doc.order.map((id) => nodeRect(doc, specRegistry, id)!);
    for (const a of rects)
      for (const b of rects) {
        if (a === b) continue;
        const apart =
          a.x >= b.x + b.w + PLACE_MARGIN ||
          b.x >= a.x + a.w + PLACE_MARGIN ||
          a.y >= b.y + b.h + PLACE_MARGIN ||
          b.y >= a.y + a.h + PLACE_MARGIN;
        expect(apart).toBe(true);
      }
  });
});

/** Every pair at least PLACE_MARGIN apart, by their real boxes. */
const allApart = (doc: DocSlice, ids = doc.order) => {
  const rects = ids.map((id) => nodeRect(doc, specRegistry, id, { ctx })!);
  return rects.every((a, i) =>
    rects.every(
      (b, j) =>
        i === j ||
        a.x >= b.x + b.w + PLACE_MARGIN ||
        b.x >= a.x + a.w + PLACE_MARGIN ||
        a.y >= b.y + b.h + PLACE_MARGIN ||
        b.y >= a.y + a.h + PLACE_MARGIN,
    ),
  );
};

/** Every node in the frame inside its insets. */
const holds = (doc: DocSlice, frameId: string) => {
  const frame = nodeRect(doc, specRegistry, frameId, { ctx })!;
  return doc.order
    .filter((id) => doc.nodes[id]!.parentId === frameId)
    .every((id) => {
      const r = nodeRect(doc, specRegistry, id, { ctx })!;
      return (
        r.x >= frame.x + FRAME_INSET.x &&
        r.y >= frame.y + FRAME_INSET.top &&
        r.x + r.w <= frame.x + frame.w - FRAME_INSET.x &&
        r.y + r.h <= frame.y + frame.h - FRAME_INSET.x
      );
    });
};

const tall = { model: banana.key, size: { kind: "aspect", ratio: "3:4" } };
const wide = { model: banana.key, size: { kind: "aspect", ratio: "16:9" } };

describe("real boxes", () => {
  test("an image card counts at its aspect ratio, then at its image's shape", () => {
    const doc = docOf([
      node("n_g", "image.generate", { params: tall, size: { w: 320, h: 320 } }),
      node("n_v", "image.variations", { params: { ...tall, strategy: "same-prompt", count: 4 } }),
      node("n_done", "image.generate", {
        params: tall,
        result: { state: "done", assetIds: ["a_wide"], fingerprint: null, ranAt: null } as never,
      }),
    ]);
    // The saved square is what a canvas opened before the card measured itself still says.
    expect(nodeRect(doc, specRegistry, "n_g")).toMatchObject({ w: 320, h: 320 });
    expect(nodeRect(doc, specRegistry, "n_g", { ctx })).toMatchObject({ w: 320, h: 426.67 });
    // Variations: its grid of four takes at 3:4.
    expect(nodeRect(doc, specRegistry, "n_v", { ctx })).toMatchObject({ w: 320, h: 426 });
    // Once it has an image, the image's shape, as the library knows it.
    const images = { a_wide: { w: 1600, h: 900 } };
    expect(nodeRect(doc, specRegistry, "n_done", { ctx, images })).toMatchObject({ w: 320, h: 180 });
  });

  test("a batch of image cards lands clear of each other at their real size", () => {
    const out = compile(docOf([]), [
      { op: "add_node", as: "p", type: "prompt", params: { text: "A lighthouse" } },
      { op: "add_node", as: "a", type: "image.generate", params: tall },
      { op: "add_node", as: "b", type: "image.generate", params: tall },
      { op: "add_node", as: "c", type: "image.variations", params: tall },
      { op: "add_node", as: "d", type: "image.generate", params: wide },
      { op: "connect", source: "p", target: "a" },
      { op: "connect", source: "p", target: "b" },
      { op: "connect", source: "p", target: "c" },
      { op: "connect", source: "p", target: "d" },
    ]);
    expect(allApart(out.doc)).toBe(true);
    // Each is saved at the box it shows, so a tab has nothing to correct.
    expect(out.doc.nodes[out.aliases.a!]!.size).toEqual({ w: 320, h: 426.67 });
    expect(out.doc.nodes[out.aliases.d!]!.size).toEqual({ w: 320, h: 180 });
    // All in a column beside the prompt, the tall ones' full height apart.
    const a = nodeRect(out.doc, specRegistry, out.aliases.a!, { ctx })!;
    const b = nodeRect(out.doc, specRegistry, out.aliases.b!, { ctx })!;
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + PLACE_MARGIN);
  });
});

describe("frames grow to hold what's in them", () => {
  const framed = (extra: Partial<Parameters<typeof node>[2]> = {}) =>
    docOf([
      node("n_f", "frame", { position: { x: 100, y: 100 }, size: { w: 640, h: 420 } }),
      node("n_a", "note", { parentId: "n_f", position: { x: 24, y: 48 }, size: { w: 240, h: 240 } }),
      node("n_b", "note", {
        parentId: "n_f",
        position: { x: 300, y: 48 },
        size: { w: 240, h: 240 },
        ...extra,
      }),
    ]);

  test("a node added to a full frame goes in, and the frame grows around it", () => {
    const base = docOf([
      node("n_f", "frame", { position: { x: 96, y: 96 }, size: { w: 400, h: 336 } }),
      node("n_in", "note", { parentId: "n_f", position: { x: 24, y: 48 }, size: { w: 240, h: 240 } }),
    ]);
    const out = compile(base, [
      { op: "add_node", as: "a", type: "note", parentId: "n_f" },
      { op: "add_node", as: "b", type: "image.generate", params: tall, parentId: "n_f" },
    ]);
    expect(holds(out.doc, "n_f")).toBe(true);
    expect(
      allApart(
        out.doc,
        out.doc.order.filter((id) => id !== "n_f"),
      ),
    ).toBe(true);
    // It grew where it was, down: one under the other, never wider, never moved.
    expect(absolutePosition(out.doc, out.aliases.a!)).toEqual({ x: 120, y: 408 });
    expect(absolutePosition(out.doc, out.aliases.b!)).toEqual({ x: 120, y: 672 });
    expect(nodeRect(out.doc, specRegistry, "n_f")).toEqual({ x: 96, y: 96, w: 400, h: 1027 });
    expect(out.touched).toContain("n_f");
  });

  test("a node moved left of and above its frame: the frame reaches out, nothing else moves", () => {
    const base = framed();
    const b = absolutePosition(base, "n_b");
    const out = compile(base, [{ op: "move_node", id: "n_a", position: { x: 0, y: 20 } }]);
    expect(absolutePosition(out.doc, "n_a")).toEqual({ x: 0, y: 20 });
    expect(absolutePosition(out.doc, "n_b")).toEqual(b);
    expect(nodeRect(out.doc, specRegistry, "n_f")).toEqual({ x: -24, y: -28, w: 764, h: 548 } satisfies Rect);
    expect(holds(out.doc, "n_f")).toBe(true);
    // As ops a tab replays: the frame's box, and what's in it shifted back.
    expect(out.ops.at(-1)).toEqual({
      op: "resizeNode",
      id: "n_f",
      size: { w: 764, h: 548 },
      position: { x: -24, y: -28 },
    });
  });

  test("frames never shrink, the one around a grown frame grows too, and locked nodes stay put", () => {
    const base = docOf([
      node("n_out", "frame", { position: { x: 0, y: 0 }, size: { w: 900, h: 700 } }),
      node("n_f", "frame", { parentId: "n_out", position: { x: 100, y: 100 }, size: { w: 640, h: 420 } }),
      node("n_a", "note", { parentId: "n_f", position: { x: 24, y: 48 }, size: { w: 240, h: 240 } }),
      node("n_l", "note", {
        parentId: "n_f",
        position: { x: 300, y: 48 },
        size: { w: 240, h: 240 },
        locked: true,
      }),
    ]);
    const small = compile(base, [{ op: "move_node", id: "n_a", position: { x: 130, y: 150 } }]);
    expect(nodeRect(small.doc, specRegistry, "n_f")).toMatchObject({ w: 640, h: 420 });

    const out = compile(base, [{ op: "move_node", id: "n_a", position: { x: -200, y: 150 } }]);
    expect(holds(out.doc, "n_f")).toBe(true);
    expect(holds(out.doc, "n_out")).toBe(true);
    expect(absolutePosition(out.doc, "n_l")).toEqual(absolutePosition(base, "n_l"));
    expect(lockProblem(base, out.doc, specRegistry)).toBeNull();
  });
});

describe("wire ops", () => {
  test("round-trip every op through JSON, removals included", () => {
    const ops: CanvasOp[] = [
      { op: "addNode", node: node("n_a", "note", { params: { text: "hi", tint: 0 } }) },
      { op: "setParams", id: "n_a", patch: { text: "there", tint: undefined } },
      { op: "moveNode", id: "n_a", position: { x: 10, y: 20 } },
      { op: "resizeNode", id: "n_a", size: undefined },
      { op: "setTitle", id: "n_a", title: null },
      { op: "setName", name: "Renamed" },
    ];
    const wire = JSON.parse(JSON.stringify(toWireOps(ops))) as CanvasWireOp[];
    const parsed = wire.map((op) => canvasWireOpSchema.parse(op));
    const back = fromWireOps(parsed);
    const base = docOf([]);
    expect(applyOps(base, back).doc).toEqual(applyOps(base, ops).doc);
    expect(applyOps(base, back).doc.params.n_a).toEqual({ text: "there" });
  });
});

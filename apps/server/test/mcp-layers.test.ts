import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { uploadResponseSchema } from "@openfield/core";
import { canvasDocumentSchema } from "@openfield/core/canvas";
import { getCanvas } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import { startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";
import { texture } from "./pixels";

// Layers nodes and Sketch & point through /mcp: an agent adds a Layers node, wires one of its
// layers into an Edit node, gives that node marks and runs it, under the same rules as any node.

let server: TestServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await server?.close();
  server = undefined;
});

const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const OPENAI = "openai:gpt-image-2";

// biome-ignore lint/suspicious/noExplicitAny: tool answers are free-form JSON; each test checks what it needs.
type Json = Record<string, any>;
const j = (r: { json: unknown }) => r.json as Json;

async function ready() {
  const s = await startTestServer({ fetch: createFakeFetch({ delayMs: 0 }) });
  server = s;
  for (const [provider, apiKey] of [
    ["byteplus", "ark-test-key"],
    ["openai", "sk-test-0123456789abcdefghijklmnop"],
  ] as const) {
    const res = await s.json(`/api/settings/keys/${provider}`, { method: "PUT", body: { apiKey } });
    if (res.status !== 200) throw new Error(`Saving the ${provider} key failed: ${JSON.stringify(res.body)}`);
  }
  await turnOnAgents(s);
  client = await connectAgent(s);
  return { s, c: client };
}

async function upload(s: TestServer): Promise<string> {
  const form = new FormData();
  form.append("file", new File([await texture(1024, 1024)], "photo"));
  const res = await s.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

/** Upload → Layers → Edit (Sketch & point) on `port`, built in one edit_canvas batch. */
async function build(c: Client, photo: string, port = "layer-2") {
  const made = j(await call(c, "create_canvas", { name: "Still life" }));
  const edited = await call(c, "edit_canvas", {
    canvas: made.canvasId,
    edits: [
      { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [photo] } },
      { op: "add_node", as: "l", type: "image.layers", params: { model: PRO } },
      { connect: "up.images", to: "l.image" },
      { op: "add_node", as: "e", type: "image.edit", params: { model: PRO, prompt: "make it blue" } },
      { connect: `l.${port}`, to: "e.image" },
    ],
  });
  expect(edited.isError).toBe(false);
  return {
    canvasId: made.canvasId as string,
    ...(j(edited).created as { up: string; l: string; e: string }),
  };
}

describe("Layers nodes", () => {
  test("list_node_types has the Layers node, its ports and settings", async () => {
    const { c } = await ready();
    const types = j(await call(c, "list_node_types")).types as Json[];
    const layers = types.find((t) => t.type === "image.layers")!;
    expect(layers.inputs).toEqual([{ port: "image", takes: "image", required: true }]);
    expect(layers.outputs[0]).toEqual({ port: "layer-16", gives: "image" });
    expect(layers.outputs.at(-1)).toEqual({ port: "base", gives: "image" });
    expect(layers.outputsNote).toContain('"layer-N"');
    expect(Object.keys(layers.settings)).toEqual(["model", "prompt", "size"]);
    expect(layers.limits).toEqual({ prompt: { maxChars: 4000 } });
    const edit = types.find((t) => t.type === "image.edit")!;
    expect(Object.keys(edit.settings)).toContain("marks");
  });

  test("edit_canvas wires a layer into an Edit node; a connection from it has to name the layer", async () => {
    const { s, c } = await ready();
    const photo = await upload(s);
    const { canvasId, l, e } = await build(c, photo);
    const doc = canvasDocumentSchema.parse(getCanvas(s.services.db, canvasId)!.graph);
    expect(doc.edges.find((x) => x.target === e)).toMatchObject({ source: l, sourceHandle: "layer-2" });

    const vague = await call(c, "edit_canvas", {
      canvas: canvasId,
      edits: [
        { op: "add_node", as: "e2", type: "image.edit", params: { model: PRO, mode: "sketch" } },
        { connect: l, to: "e2.image" },
      ],
    });
    expect(vague.isError).toBe(true);
    expect(vague.text).toContain("Say which one: layer-1 to layer-16, or base.");
  });

  test("run_canvas splits the image, and get_canvas lists its layers by name", async () => {
    const { s, c } = await ready();
    const photo = await upload(s);
    const { canvasId, l, e } = await build(c, photo);
    expect((await call(c, "set_node_marks", { canvas: canvasId, id: e, marks: null })).isError).toBe(false);
    const priced = j(await call(c, "run_canvas", { canvas: canvasId, dryRun: true }));
    // A split's price is a range: the model decides how many layers there are.
    expect(priced.runs).toEqual([l, e]);
    const ran = await call(c, "run_canvas", { canvas: canvasId, confirmCost: priced.price.usd });
    expect(ran.isError).toBe(false);
    expect(j(ran).status).toBe("succeeded");

    const read = j(await call(c, "get_canvas", { canvas: canvasId }));
    const node = read.nodes.find((n: Json) => n.id === l);
    expect(node.outputs.map((o: Json) => [o.port, o.name])).toEqual([
      ["layer-3", "Layer 3"],
      ["layer-2", "Layer 2"],
      ["layer-1", "Layer 1"],
      ["base", "Base"],
    ]);
    expect(node.outputs[1].description).toBe("Part 2 of the picture");
    expect(read.nodes.find((n: Json) => n.id === e).state).toBe("done");
  });
});

describe("set_node_marks", () => {
  const box = { kind: "box", from: { x: 0.1, y: 0.2 }, to: { x: 0.4, y: 0.6 }, material: "brushed steel" };

  test("puts an Edit node in Sketch & point with its marks, and takes them off", async () => {
    const { s, c } = await ready();
    const photo = await upload(s);
    const { canvasId, e } = await build(c, photo);
    const set = await call(c, "set_node_marks", { canvas: canvasId, id: e, marks: [box], keepRest: true });
    expect(set.isError).toBe(false);
    const read = j(await call(c, "get_canvas", { canvas: canvasId }));
    expect(read.nodes.find((n: Json) => n.id === e).params).toMatchObject({
      mode: "sketch",
      marks: [box],
      sketchKeepOriginal: true,
    });
    await call(c, "set_node_marks", { canvas: canvasId, id: e, marks: null });
    const cleared = j(await call(c, "get_canvas", { canvas: canvasId })).nodes.find((n: Json) => n.id === e);
    expect(cleared.params.mode).toBe("sketch");
    expect(cleared.params.marks).toBeUndefined();
  });

  test("refuses a model that can't read marks, marks off the image, and a locked node", async () => {
    const { s, c } = await ready();
    const photo = await upload(s);
    const { canvasId, e } = await build(c, photo);

    const off = await call(c, "set_node_marks", {
      canvas: canvasId,
      id: e,
      marks: [{ kind: "point", at: { x: 1.4, y: 0.2 } }],
    });
    expect(off.isError).toBe(true);

    await call(c, "update_node", { canvas: canvasId, id: e, params: { model: OPENAI } });
    const unable = await call(c, "set_node_marks", { canvas: canvasId, id: e, marks: [box] });
    expect(unable.isError).toBe(true);
    expect(unable.text).toContain("can't read marks");

    await call(c, "update_node", { canvas: canvasId, id: e, params: { model: PRO } });
    const detail = s.services.canvases.get(canvasId);
    s.services.canvases.save(canvasId, {
      graphVersion: detail.graphVersion,
      graph: {
        ...detail.graph,
        nodes: detail.graph.nodes.map((n) => (n.id === e ? { ...n, locked: true } : n)),
      },
    });
    const locked = await call(c, "set_node_marks", { canvas: canvasId, id: e, marks: [box] });
    expect(locked.isError).toBe(true);
    expect(locked.text).toContain("locked");
  });
});

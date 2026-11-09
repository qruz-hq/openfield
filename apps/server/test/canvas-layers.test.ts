import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileRun,
  fromDocument,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import { canvasRunResponseSchema, uploadResponseSchema } from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import { getAsset, getCanvas, getJobSet } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import { serverEngineContext } from "../src/canvas/engine-context";
import { finished, newCanvas } from "./canvas-helpers";
import { startTestServer, type TestServer } from "./helpers";
import { texture } from "./pixels";

// The Layers node and the Edit node's Sketch & point on a canvas run: a split's outputs are its
// layers, one per port, and an edit reads only the one it's wired to.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const tab = { kind: "tab" as const, tabId: "tab-layers01" };

async function ready(): Promise<TestServer> {
  const s = await startTestServer({ fetch: createFakeFetch({ delayMs: 0 }) });
  const res = await s.json("/api/settings/keys/byteplus", {
    method: "PUT",
    body: { apiKey: "ark-test-key" },
  });
  if (res.status !== 200) throw new Error(`Saving the key failed: ${JSON.stringify(res.body)}`);
  return s;
}

async function upload(bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new File([bytes], "photo"));
  const res = await server!.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

const savedDoc = (id: string): CanvasDocument =>
  canvasDocumentSchema.parse(getCanvas(server!.services.db, id)!.graph);

/** Posts the whole canvas as Run all does, compiled from the saved document. */
async function runAll(canvasId: string) {
  const ctx = serverEngineContext(server!.services);
  const { slice } = fromDocument(savedDoc(canvasId));
  const fingerprints = await resolveFingerprints(planFingerprints(slice, specRegistry, ctx), new Map());
  const outcome = compileRun({
    doc: slice,
    registry: specRegistry,
    ctx,
    fingerprints,
    request: { scope: "all", nodeIds: [] },
  });
  if (outcome.kind !== "plan") throw new Error(`Expected a plan, got ${outcome.kind}`);
  const res = await server!.json(`/api/canvases/${canvasId}/run`, {
    method: "POST",
    body: { scope: "all", nodeIds: [], plan: outcome.items.map((c) => c.item) },
  });
  expect(res.status).toBe(201);
  const run = canvasRunResponseSchema.parse(res.body);
  return { run, done: await finished(server!, run.runId!, 20_000) };
}

/** Upload → Layers, with an Edit in Sketch & point (no marks: the whole layer) reading `port`. */
async function layersCanvas(port: string, prompt = "") {
  const photo = await upload(await texture(1024, 1024));
  const canvas = await newCanvas(server!, { name: "Still life" });
  const { aliases } = server!.services.canvases.edit(
    canvas.id,
    [
      { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [photo] } },
      { op: "add_node", as: "l", type: "image.layers", params: { model: PRO, prompt } },
      { op: "connect", source: "up", target: "l", targetHandle: "image" },
      {
        op: "add_node",
        as: "e",
        type: "image.edit",
        params: { model: PRO, prompt: "make it blue", mode: "sketch" },
      },
      { op: "connect", source: "l", sourceHandle: port, target: "e", targetHandle: "image" },
    ],
    tab,
  );
  return { canvasId: canvas.id, photo, layers: aliases.l!, edit: aliases.e! };
}

describe("a Layers node's run", () => {
  test("files the base and its layers as its outputs, and an edit reads only its own layer", async () => {
    server = await ready();
    const { canvasId, photo, layers, edit } = await layersCanvas("layer-2");
    const { done } = await runAll(canvasId);
    expect(done.status).toBe("succeeded");

    const set = getJobSet(server.services.db, done.nodes.find((n) => n.nodeId === layers)!.jobSetIds[0]!)!;
    expect(set.op).toBe("decompose");
    expect(set.requestJson).toMatchObject({
      base: { assetId: photo },
      layers: { size: "auto" },
      source: "canvas",
    });

    const result = savedDoc(canvasId).nodes.find((n) => n.id === layers)!.result!;
    // The base first, then its layers top first.
    expect(result.outputs.map((o) => [o.layer?.role, o.layer?.zIndex])).toEqual([
      ["base", 0],
      ["layer", 3],
      ["layer", 2],
      ["layer", 1],
    ]);
    expect(result.outputs[2]!.layer).toMatchObject({ name: "Layer 2", description: "Part 2 of the picture" });

    const editSet = getJobSet(server.services.db, done.nodes.find((n) => n.nodeId === edit)!.jobSetIds[0]!)!;
    const second = result.outputs[2]!.assetId;
    expect((editSet.requestJson as { base: { assetId: string } }).base.assetId).toBe(second);
    expect(getAsset(server.services.db, second)!.opParams).toMatchObject({ layer: { zIndex: 2 } });
  });

  test("is reused when nothing changed, with its layers still on their ports", async () => {
    server = await ready();
    const { canvasId, layers, edit } = await layersCanvas("base");
    await runAll(canvasId);
    const before = savedDoc(canvasId).nodes.find((n) => n.id === layers)!.result!;
    // The edit changed; the split didn't.
    server.services.canvases.edit(
      canvasId,
      [{ op: "update_node", id: edit, params: { prompt: "make it red" } }],
      tab,
    );
    const { done } = await runAll(canvasId);
    expect(done.status).toBe("succeeded");
    expect(done.nodes.find((n) => n.nodeId === layers)!.state).toBe("cached");
    const after = savedDoc(canvasId).nodes.find((n) => n.id === layers)!.result!;
    expect(after.outputs).toEqual(before.outputs);
    const editSet = getJobSet(server.services.db, done.nodes.find((n) => n.nodeId === edit)!.jobSetIds[0]!)!;
    expect((editSet.requestJson as { base: { assetId: string } }).base.assetId).toBe(
      before.outputs[0]!.assetId,
    );
  });

  test("run again with fewer layers, what read a layer that's gone waits and says why", async () => {
    server = await ready();
    const { canvasId, layers, edit } = await layersCanvas("layer-3");
    await runAll(canvasId);
    server.services.canvases.edit(
      canvasId,
      [{ op: "update_node", id: layers, params: { prompt: "just the bottle #fake-layers:1" } }],
      tab,
    );
    const { done } = await runAll(canvasId);
    expect(done.nodes.find((n) => n.nodeId === layers)!.state).toBe("done");
    expect(done.nodes.find((n) => n.nodeId === edit)).toMatchObject({
      state: "blocked",
      blocked: "missing_input",
    });
    expect(done.nodes.find((n) => n.nodeId === edit)!.jobSetIds).toEqual([]);
    const doc = savedDoc(canvasId);
    // The link stays, for a later run that makes that layer again.
    expect(doc.edges.some((e) => e.source === layers && e.sourceHandle === "layer-3")).toBe(true);
    expect(doc.nodes.find((n) => n.id === layers)!.result!.outputs.map((o) => o.layer?.zIndex)).toEqual([
      0, 1,
    ]);
  });
});

describe("an Edit node in Sketch & point", () => {
  async function sketchCanvas(params: Record<string, unknown>) {
    const photo = await upload(await texture(640, 480));
    const canvas = await newCanvas(server!, { name: "Kettle" });
    const { aliases } = server!.services.canvases.edit(
      canvas.id,
      [
        { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [photo] } },
        {
          op: "add_node",
          as: "e",
          type: "image.edit",
          params: {
            model: PRO,
            prompt: "brushed steel",
            mode: "sketch",
            marks: [
              { kind: "box", from: { x: 0.5, y: 0.5 }, to: { x: 0.1, y: 0.1 }, material: "brushed steel" },
            ],
            ...params,
          },
        },
        { op: "connect", source: "up", target: "e", targetHandle: "image" },
      ],
      tab,
    );
    return { canvasId: canvas.id, photo, edit: aliases.e! };
  }

  test("sends its marks, corner first, with no mask while Keep the rest is off and no references", async () => {
    server = await ready();
    const { canvasId, edit } = await sketchCanvas({});
    // A reference wired in stays linked for painting again, but Sketch & point doesn't send it.
    const reference = await upload(await texture(320, 240));
    server.services.canvases.edit(
      canvasId,
      [
        { op: "add_node", as: "ref", type: "image.upload", params: { assetIds: [reference] } },
        { op: "connect", source: "ref", target: edit, targetHandle: "input_images" },
      ],
      tab,
    );
    const { done } = await runAll(canvasId);
    expect(done.status).toBe("succeeded");
    const set = getJobSet(server.services.db, done.nodes.find((n) => n.nodeId === edit)!.jobSetIds[0]!)!;
    const request = set.requestJson as { marks: unknown; mask?: unknown; references?: unknown };
    expect(request.marks).toEqual([
      { kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 }, material: "brushed steel" },
    ]);
    expect(request.mask).toBeUndefined();
    expect(request.references).toBeUndefined();
    expect(savedDoc(canvasId).edges.some((e) => e.target === edit && e.targetHandle === "input_images")).toBe(
      true,
    );
  });

  test("refuses marks on a reference image, since none are sent", async () => {
    server = await ready();
    const point = { kind: "point" as const, at: { x: 0.5, y: 0.5 } };
    await expect(sketchCanvas({ marks: [point, { ...point, image: 2 }] })).rejects.toThrow(
      /Mark 2 is on image 2/,
    );
  });

  test("keeping the rest, sends the marks' area as a mask saved for the image", async () => {
    server = await ready();
    const { canvasId, photo, edit } = await sketchCanvas({ sketchKeepOriginal: true });
    const { done } = await runAll(canvasId);
    expect(done.status).toBe("succeeded");
    const set = getJobSet(server.services.db, done.nodes.find((n) => n.nodeId === edit)!.jobSetIds[0]!)!;
    const request = set.requestJson as { mask: { assetId: string; composite: boolean } };
    expect(request.mask.composite).toBe(true);
    const mask = getAsset(server.services.db, request.mask.assetId)!;
    expect(mask).toMatchObject({ kind: "mask", parentAssetId: photo, width: 640, height: 480 });
  });

  test("ignores whatever is wired into its Mask input", async () => {
    server = await ready();
    const { canvasId } = await sketchCanvas({});
    const other = await upload(await texture(640, 480));
    const refused = () =>
      server!.services.canvases.edit(
        canvasId,
        [
          { op: "add_node", as: "m", type: "image.upload", params: { assetIds: [other] } },
          {
            op: "connect",
            source: "m",
            target: savedDoc(canvasId).nodes.find((n) => n.type === "image.edit")!.id,
            targetHandle: "mask",
          },
        ],
        tab,
      );
    expect(refused).toThrow();
  });
});

describe("a canvas with a Layers node, exported and imported", () => {
  test("brings every layer with its place in the stack, its links and its marks, still up to date", async () => {
    server = await ready();
    const a = server;
    const { canvasId, layers, edit } = await layersCanvas("layer-2");
    a.services.canvases.edit(
      canvasId,
      [
        {
          op: "update_node",
          id: edit,
          params: { marks: [{ kind: "point", at: { x: 0.5, y: 0.5 }, color: "#C8102E" }] },
        },
      ],
      tab,
    );
    await runAll(canvasId);
    const made = savedDoc(canvasId).nodes.find((n) => n.id === layers)!.result!;
    const res = await a.request(`/api/canvases/${canvasId}/export`);
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "openfield-layers-"));
    const file = join(dir, "still-life.ofcanvas.zip");
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));

    const b = await ready();
    try {
      const job = await b.services.archives.wait(
        b.services.archives.startImport({ path: file }, {}).jobId,
        10_000,
      );
      if (job?.result?.kind !== "import") throw new Error(`The import ${job?.state}`);
      const { canvasId: copy } = job.result;
      const doc = canvasDocumentSchema.parse(getCanvas(b.services.db, copy)!.graph);
      const split = doc.nodes.find((n) => n.type === "image.layers")!;
      expect(split.result!.outputs.map((o) => [o.assetId, o.layer?.zIndex, o.layer?.name])).toEqual(
        made.outputs.map((o) => [o.assetId, o.layer?.zIndex, o.layer?.name]),
      );
      // Each layer is a library image again, with where it sits.
      for (const o of made.outputs)
        expect(getAsset(b.services.db, o.assetId)!.opParams).toMatchObject({
          layer: { zIndex: o.layer!.zIndex },
        });
      const sketch = doc.nodes.find((n) => n.type === "image.edit")!;
      expect(doc.edges.find((e) => e.target === sketch.id)).toMatchObject({
        source: split.id,
        sourceHandle: "layer-2",
      });
      expect(sketch.params).toMatchObject({ mode: "sketch", marks: [{ kind: "point", color: "#C8102E" }] });
      const fresh = await b.services.canvasRuns.runScope(copy, { scope: "all", dryRun: true });
      expect(fresh.upToDate.sort()).toEqual([split.id, sketch.id].sort());
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
import {
  canvasRunResponseSchema,
  type JobSetAccepted,
  type LayerStackResponse,
  layerStackResponseSchema,
  newId,
  uploadResponseSchema,
} from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import { getAsset, getCanvas } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import { serverEngineContext } from "../src/canvas/engine-context";
import { ZipArchive } from "../src/files/unzip";
import { finished, newCanvas } from "./canvas-helpers";
import { completed, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";
import { texture } from "./pixels";

// Seedream 5.5 end to end on the BytePlus fake: more than 16 layers when asked, the words on a text
// layer stored with it and handed back by GET /api/layers, the zip export, MCP and a canvas node,
// and a canvas archive that brings the words back with the layers.

const V55 = "byteplus:dola-seedream-5-5-261028";
const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const tab = { kind: "tab" as const, tabId: "tab-seedream55" };

let server: TestServer | undefined;
let agent: Awaited<ReturnType<typeof connectAgent>> | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
  await server?.close();
  server = undefined;
});

async function start(): Promise<TestServer> {
  const s = await startTestServer({ fetch: createFakeFetch({ delayMs: 0 }) });
  const res = await s.json("/api/settings/keys/byteplus", {
    method: "PUT",
    body: { apiKey: "ark-test-key" },
  });
  if (res.status !== 200) throw new Error(`Saving the key failed: ${JSON.stringify(res.body)}`);
  return s;
}

async function upload(s: TestServer, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new File([bytes], "photo"));
  const res = await s.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

async function separated(s: TestServer, body: Record<string, unknown>) {
  const image = await upload(s, await texture(1024, 1024));
  const res = await s.json<JobSetAccepted>("/api/layers", {
    method: "POST",
    body: { idempotencyKey: newId(), model: V55, image, size: "1K", ...body },
  });
  expect(res.status).toBe(202);
  await completed(s, res.body.jobSet.id);
  const stack = await s.json<LayerStackResponse>(`/api/layers/${res.body.jobSet.id}`);
  expect(stack.status).toBe(200);
  return { runId: res.body.jobSet.id, stack: layerStackResponseSchema.parse(stack.body) };
}

describe("a 5.5 split", () => {
  test("makes more than 16 layers when asked, and the top one keeps the words on it", async () => {
    server = await start();
    const { stack } = await separated(server, { maxLayers: 20, prompt: "#fake-layers:20" });
    expect(stack.layers).toHaveLength(21);
    const top = stack.layers.at(-1)!;
    expect(top.zIndex).toBe(20);
    expect(top.text).toMatchObject({
      text: "Presented By :\nAnna Katrina Marchesi",
      lines: [
        {
          runs: [{ text: "Presented By :", style: { font: "Helvetica Neue", color: "#193366", bold: true } }],
        },
        { runs: [{ text: "Anna Katrina Marchesi", style: { color: "#46597E", bold: false } }] },
      ],
    });
    expect(top.text!.lines[0]!.box).toHaveLength(4);
    expect(stack.layers.filter((l) => l.text)).toHaveLength(1);
    // Stored with the layer's image, where the canvas and an archive read it back.
    expect(getAsset(server.services.db, top.asset.id)!.opParams).toMatchObject({
      layer: { text: { text: "Presented By :\nAnna Katrina Marchesi" } },
    });
  });

  test("16 layers at most unless told otherwise, and a number out of range is refused", async () => {
    server = await start();
    const { stack } = await separated(server, { prompt: "#fake-layers:40" });
    expect(stack.layers).toHaveLength(17);
    for (const maxLayers of [0, 100, 2.5]) {
      const image = await upload(server, await texture(1024, 1024));
      const res = await server.json("/api/layers", {
        method: "POST",
        body: { idempotencyKey: newId(), model: V55, image, maxLayers },
      });
      expect(res.status).toBe(400);
    }
  });

  test("the zip names sort in stack order and stack.json carries the words", async () => {
    server = await start();
    const { runId } = await separated(server, { maxLayers: 12, prompt: "#fake-layers:12" });
    const res = await server.request(`/api/layers/${runId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "zip" }),
    });
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "openfield-layers-"));
    try {
      const file = join(dir, "layers.zip");
      writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      const zip = await ZipArchive.open(file);
      const pngs = zip.entries.map((e) => e.name).filter((n) => n !== "flattened.png" && n.endsWith(".png"));
      expect(pngs).toHaveLength(13);
      expect(pngs[0]).toBe("00 Base.png");
      expect(pngs.at(-1)).toBe("12 Layer 12.png");
      expect([...pngs].sort()).toEqual(pngs);
      const json = JSON.parse(await new Response(await zip.open(zip.find("stack.json")!)).text());
      expect(json.layers.at(-1).text.text).toBe("Presented By :\nAnna Katrina Marchesi");
      expect(json.layers[0].text).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a PSD still has a layer each, as pixels", async () => {
    server = await start();
    const { runId } = await separated(server, { maxLayers: 20, prompt: "#fake-layers:20" });
    const res = await server.request(`/api/layers/${runId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "psd" }),
    });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("8BPS");
  });
});

describe("5.5 for agents", () => {
  async function connected() {
    server = await start();
    await turnOnAgents(server);
    agent = await connectAgent(server);
    return { s: server, c: agent };
  }

  test("list_models says 5.5 takes a number of layers and reads text", async () => {
    const { c } = await connected();
    const models = (await call(c, "list_models", {})).json.models as unknown as Record<string, unknown>[];
    expect(models.find((m) => m.key === V55)?.layers).toEqual({
      sizes: ["auto", "1K", "1.5K", "2K"],
      most: 99,
      choose: { min: 1, max: 99, default: 16 },
      text: true,
    });
  });

  test("separate_layers prices maxLayers, answers the words, and refuses the number on Pro", async () => {
    const { s, c } = await connected();
    const image = await upload(s, await texture(1024, 1024));
    // Auto keeps 1024 × 1024, at $0.020: 2 to 41 images, plus $0.008 for the image sent in.
    const priced = await call(c, "separate_layers", { image, model: V55, maxLayers: 40, dryRun: true });
    expect(priced.json).toMatchObject({ dryRun: true, price: { usd: 0.828, minUsd: 0.048 } });

    const made = await call(c, "separate_layers", {
      image,
      model: V55,
      maxLayers: 20,
      prompt: "#fake-layers:20",
      confirmCost: 0.428,
    });
    expect(made.isError).toBe(false);
    const layers = made.json.layers as unknown as { role: string; text?: { text: string } }[];
    expect(layers).toHaveLength(21);
    expect(layers.at(-1)?.text?.text).toBe("Presented By :\nAnna Katrina Marchesi");

    const refused = await call(c, "separate_layers", { image, model: PRO, maxLayers: 20, dryRun: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("decides how many layers");
  });
});

describe("a 5.5 Layers node", () => {
  const savedDoc = (id: string): CanvasDocument =>
    canvasDocumentSchema.parse(getCanvas(server!.services.db, id)!.graph);

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
      body: { scope: "all", nodeIds: [], plan: outcome.items.map((i) => i.item) },
    });
    expect(res.status).toBe(201);
    return finished(server!, canvasRunResponseSchema.parse(res.body).runId!, 20_000);
  }

  test("has a port per layer past 16, the words on its outputs, and keeps them through an archive", async () => {
    server = await start();
    const photo = await upload(server, await texture(1024, 1024));
    const canvas = await newCanvas(server, { name: "Poster" });
    const { aliases } = server.services.canvases.edit(
      canvas.id,
      [
        { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [photo] } },
        {
          op: "add_node",
          as: "l",
          type: "image.layers",
          params: { model: V55, prompt: "#fake-layers:20", maxLayers: 20 },
        },
        { op: "connect", source: "up", target: "l", targetHandle: "image" },
      ],
      tab,
    );
    // A number past 99 is refused with the limit named.
    expect(() =>
      server!.services.canvases.edit(
        canvas.id,
        [{ op: "update_node", id: aliases.l!, params: { maxLayers: 120 } }],
        tab,
      ),
    ).toThrow();
    await runAll(canvas.id);
    const result = savedDoc(canvas.id).nodes.find((n) => n.id === aliases.l)!.result!;
    expect(result.outputs).toHaveLength(21);
    const top = result.outputs.find((o) => o.layer?.zIndex === 20)!;
    expect(top.layer?.text).toEqual({
      text: "Presented By :\nAnna Katrina Marchesi",
      font: "Helvetica Neue",
      color: "#193366",
    });
    expect(result.outputs.filter((o) => o.layer?.text)).toHaveLength(1);

    const res = await server.request(`/api/canvases/${canvas.id}/export`);
    expect(res.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "openfield-layers-"));
    const file = join(dir, "poster.ofcanvas.zip");
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
    const b = await start();
    try {
      const job = await b.services.archives.wait(
        b.services.archives.startImport({ path: file }, {}).jobId,
        10_000,
      );
      if (job?.result?.kind !== "import") throw new Error(`The import ${job?.state}`);
      const doc = canvasDocumentSchema.parse(getCanvas(b.services.db, job.result.canvasId)!.graph);
      const split = doc.nodes.find((n) => n.type === "image.layers")!;
      expect(split.params).toMatchObject({ maxLayers: 20 });
      const copied = split.result!.outputs.find((o) => o.layer?.zIndex === 20)!;
      expect(copied.layer?.text).toEqual(top.layer?.text);
      expect(getAsset(b.services.db, copied.assetId)!.opParams).toMatchObject({
        layer: { zIndex: 20, text: { text: "Presented By :\nAnna Katrina Marchesi" } },
      });
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

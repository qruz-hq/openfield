import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FlattenResponse,
  type JobSetAccepted,
  type LayerStackResponse,
  layerStackResponseSchema,
  newId,
  type UploadResponse,
  uploadResponseSchema,
} from "@openfield/core";
import { assetsForJobSets, edgesInto, getJobSet, jobsOf } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import sharp from "sharp";
import { drawMarks, marksSvg } from "../src/files/marks";
import { packBits, writePsd } from "../src/files/psd";
import { ZipArchive } from "../src/files/unzip";
import { completed, generate, startTestServer, type TestServer } from "./helpers";
import { call, connectAgent, turnOnAgents } from "./mcp-helpers";
import { texture } from "./pixels";

// Seedream end to end on the BytePlus fake: related sets that come back short or with an image
// moderated, a layer separation filed as a base and its layers, and marks drawn onto an image.

const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const LITE = "byteplus:seedream-5-0-260128";
const FLASH = "byteplus:dola-seedream-5-0-flash-260915";

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

async function upload(s: TestServer, bytes: Uint8Array): Promise<UploadResponse["asset"]> {
  const form = new FormData();
  form.append("file", new File([bytes], "photo"));
  const res = await s.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset;
}

const usageOf = (s: TestServer, jobSetId: string) =>
  s.services.db.$client
    .query<{ batch_index: number; outcome: string; cost_usd: number | null }, [string]>(
      "SELECT batch_index, outcome, cost_usd FROM usage_log WHERE job_set_id = ? ORDER BY batch_index",
    )
    .all(jobSetId);

describe("related sets", () => {
  test("one image moderated: the rest land, that one fails on its own", async () => {
    server = await start();
    const run = await generate(server, {
      model: LITE,
      prompt: "Four seasons of one tree #fake:batch_partial",
      batch: 3,
      providerOptions: { relatedSet: true },
    });
    await completed(server, run.jobSet.id);
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(jobs[1]?.errorCode).toBe("content_refused");
    expect(assetsForJobSets(server.services.db, [run.jobSet.id])).toHaveLength(2);
    expect(usageOf(server, run.jobSet.id).map((u) => u.outcome)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
  });

  test("a set that comes back short fails the images it didn't make", async () => {
    server = await start();
    const run = await generate(server, {
      model: LITE,
      prompt: "A comic strip of a cat #fake:no_image",
      batch: 3,
      providerOptions: { relatedSet: true },
    });
    await completed(server, run.jobSet.id);
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded", "failed"]);
    expect(jobs[2]?.errorReason).toContain("fewer images");
  });
});

describe("layer separation", () => {
  test("a base and its layers, each a library image derived from the one separated", async () => {
    server = await start();
    const source = await upload(server, await texture(1024, 1024));
    const res = await server.json<{ jobSet: { id: string } }>("/api/edit", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: PRO,
        op: "decompose",
        prompt: "",
        base: { assetId: source.id, role: "base" },
        layers: { size: "1K" },
        size: { kind: "aspect", ratio: "auto" },
        batch: 1,
        source: "detail_editor",
      },
    });
    expect(res.status).toBe(202);
    await completed(server, res.body.jobSet.id);
    const db = server.services.db;
    expect(getJobSet(db, res.body.jobSet.id)?.status).toBe("succeeded");
    const assets = assetsForJobSets(db, [res.body.jobSet.id]);
    const roles = assets.map((a) => (a.opParams as { layer?: { role: string; zIndex: number } }).layer);
    expect(roles.map((l) => l?.role).sort()).toEqual(["base", "layer", "layer", "layer"]);
    expect(assets.every((a) => a.parentAssetId === source.id && a.op === "decompose")).toBe(true);
    expect(assets.every((a) => a.rootAssetId === source.rootAssetId)).toBe(true);
    const edges = edgesInto(
      db,
      assets.map((a) => a.id),
    );
    expect(edges.filter((e) => e.relation === "derived" && e.parentAssetId === source.id)).toHaveLength(4);
    const layer = assets.find((a) => (a.opParams as { layer?: { role: string } }).layer?.role === "layer")!;
    expect(layer.mime).toBe("image/png");
    expect((layer.opParams as { layer: { box: number[]; name: string } }).layer).toMatchObject({
      box: expect.any(Array),
      name: "Layer 1",
    });
    // One usage row for the whole separation.
    expect(usageOf(server, res.body.jobSet.id).map((u) => u.outcome)).toEqual(["succeeded"]);
  });

  test("an image too small to separate is refused before anything is sent", async () => {
    server = await start();
    const source = await upload(server, await texture(400, 400));
    const res = await server.json<{ error: { userMessage?: string; field?: string } }>("/api/edit", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: PRO,
        op: "decompose",
        prompt: "",
        base: { assetId: source.id, role: "base" },
        size: { kind: "aspect", ratio: "auto" },
        batch: 1,
        source: "detail_editor",
      },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("512");
  });

  test("a model that can't separate layers says so", async () => {
    server = await start();
    const source = await upload(server, await texture(1024, 1024));
    const res = await server.json("/api/edit", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: LITE,
        op: "decompose",
        prompt: "",
        base: { assetId: source.id, role: "base" },
        size: { kind: "aspect", ratio: "auto" },
        batch: 1,
        source: "detail_editor",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("marks", () => {
  test("an edit with points and a circle lands", async () => {
    server = await start();
    const source = await upload(server, await texture(1024, 1024));
    const res = await server.json<{ jobSet: { id: string } }>("/api/edit", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: PRO,
        op: "edit",
        prompt: "Tidy the desk",
        base: { assetId: source.id, role: "base" },
        marks: [
          { kind: "point", at: { x: 0.25, y: 0.5 }, note: "Put a mug here" },
          { kind: "circle", from: { x: 0.6, y: 0.6 }, to: { x: 0.9, y: 0.9 }, note: "Remove this" },
        ],
        size: { kind: "aspect", ratio: "1:1" },
        batch: 1,
        source: "detail_editor",
      },
    });
    expect(res.status).toBe(202);
    await completed(server, res.body.jobSet.id);
    expect(getJobSet(server.services.db, res.body.jobSet.id)?.status).toBe("succeeded");
  });

  test("shapes are drawn on the upright image, in its own format", async () => {
    const white = new Uint8Array(
      await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } })
        .jpeg()
        .toBuffer(),
    );
    const drawn = await drawMarks(
      { assetId: "a", mimeType: "image/jpeg", width: 200, height: 100, bytes: white },
      [
        {
          kind: "stroke",
          points: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
          ],
          color: "#FF2D2D",
          width: 0.1,
        },
      ],
    );
    expect([drawn.mimeType, drawn.width, drawn.height]).toEqual(["image/jpeg", 200, 100]);
    const { data } = await sharp(drawn.bytes).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Array.from(data.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3));
    const [r, g, b] = at(100, 50);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(90);
    expect(b).toBeLessThan(90);
    expect(at(100, 5).every((v) => v > 240)).toBe(true);
  });

  test("with nothing to draw, an upright image comes back untouched and a turned one upright", async () => {
    const upright = new Uint8Array(
      await sharp({ create: { width: 40, height: 20, channels: 3, background: "#336699" } })
        .jpeg()
        .toBuffer(),
    );
    const same = await drawMarks(
      { assetId: "a", mimeType: "image/jpeg", width: 40, height: 20, bytes: upright },
      [],
    );
    expect(same.bytes).toBe(upright);
    // Stored 40x20 but shown turned a quarter (EXIF 6): sent as the 20x40 it looks like.
    const turned = new Uint8Array(await sharp(upright).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    const fixed = await drawMarks(
      { assetId: "b", mimeType: "image/jpeg", width: 40, height: 20, bytes: turned },
      [],
    );
    expect([fixed.width, fixed.height, fixed.mimeType]).toEqual([20, 40, "image/jpeg"]);
  });

  test("the SVG has one shape per mark, at the image's pixels", () => {
    const svg = marksSvg(
      [
        {
          kind: "circle",
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.5 },
          ],
          color: "#2D7BFF",
          width: 0.01,
        },
        {
          kind: "arrow",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          color: "#22C55E",
          width: 0.01,
        },
      ],
      1000,
      500,
    );
    expect(svg).toContain('<ellipse cx="300" cy="150" rx="200" ry="100"');
    expect(svg).toContain('<line x1="0" y1="0" x2="1000" y2="500"');
    expect(svg).toContain("<polygon");
  });
});

/** A separation of a fresh 1024x1024 upload, through POST /api/layers, finished. */
async function separated(s: TestServer) {
  const source = await upload(s, await texture(1024, 1024));
  const res = await s.json<JobSetAccepted>("/api/layers", {
    method: "POST",
    body: { idempotencyKey: newId(), model: PRO, image: source.id, size: "1K" },
  });
  expect(res.status).toBe(202);
  await completed(s, res.body.jobSet.id);
  const stack = await s.json<LayerStackResponse>(`/api/layers/${res.body.jobSet.id}`);
  expect(stack.status).toBe(200);
  return { source, runId: res.body.jobSet.id, stack: layerStackResponseSchema.parse(stack.body) };
}

/** Enough of a PSD reader to check what writePsd wrote. */
function readPsd(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const take = (n: number) => {
    at += n;
    return at - n;
  };
  const u16 = () => view.getUint16(take(2));
  const i16 = () => view.getInt16(take(2));
  const u32 = () => view.getUint32(take(4));
  const i32 = () => view.getInt32(take(4));
  const ascii = (n: number) => {
    const from = take(n);
    return String.fromCharCode(...bytes.subarray(from, from + n));
  };
  const skipSection = () => {
    const length = u32();
    at += length;
  };
  const signature = ascii(4);
  const version = u16();
  at += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  const depth = u16();
  const mode = u16();
  skipSection();
  skipSection();
  const layerAndMaskEnd = u32() + at;
  const layerInfoEnd = u32() + at;
  const count = Math.abs(i16());
  const layers: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    name: string;
    lengths: number[];
  }[] = [];
  for (let i = 0; i < count; i++) {
    const [top, left, bottom, right] = [i32(), i32(), i32(), i32()];
    const lengths: number[] = [];
    const n = u16();
    for (let k = 0; k < n; k++) {
      i16();
      lengths.push(u32());
    }
    expect(ascii(4)).toBe("8BIM");
    ascii(4);
    at += 4;
    const extraEnd = u32() + at;
    skipSection();
    skipSection();
    const nameLength = bytes[at]!;
    let name = ascii(nameLength + 1).slice(1);
    // The Pascal string is padded to a multiple of 4, its length byte included.
    at += (4 - ((nameLength + 1) % 4)) % 4;
    while (at < extraEnd) {
      expect(ascii(4)).toBe("8BIM");
      const key = ascii(4);
      const end = u32() + at;
      if (key === "luni") {
        const units = u32();
        name = String.fromCharCode(...Array.from({ length: units }, () => u16()));
      }
      at = end;
    }
    at = extraEnd;
    layers.push({ top, left, bottom, right, name, lengths });
  }
  // The first layer's alpha channel, unpacked.
  const first = layers[0]!;
  const rows = first.bottom - first.top;
  const cols = first.right - first.left;
  expect(u16()).toBe(1);
  const counts = Array.from({ length: rows }, () => u16());
  const alpha: number[] = [];
  for (const length of counts) {
    const end = at + length;
    while (at < end) {
      const n = view.getInt8(at++);
      if (n >= 0) for (let k = 0; k <= n; k++) alpha.push(bytes[at++]!);
      else {
        const v = bytes[at++]!;
        for (let k = 0; k < 1 - n; k++) alpha.push(v);
      }
    }
  }
  expect(alpha).toHaveLength(rows * cols);
  expect(layerInfoEnd).toBeLessThanOrEqual(layerAndMaskEnd);
  return { signature, version, channels, width, height, depth, mode, layers, alpha };
}

describe("layer stacks", () => {
  test("POST /api/layers separates an image and GET answers its stack, base first", async () => {
    server = await start();
    const { source, stack } = await separated(server);
    expect(stack.source?.id).toBe(source.id);
    expect(stack.canvas).toEqual({ width: 1024, height: 1024 });
    expect(stack.layers.map((l) => [l.role, l.zIndex])).toEqual([
      ["base", 0],
      ["layer", 1],
      ["layer", 2],
      ["layer", 3],
    ]);
    expect(stack.layers[0]?.box).toEqual([0, 0, 1024, 1024]);
    expect(stack.layers[1]?.name).toBe("Layer 1");
  });

  test("an unknown run has no stack", async () => {
    server = await start();
    const res = await server.json(`/api/layers/${newId()}`);
    expect(res.status).toBe(404);
  });

  test("flatten puts the stack together into a new library image beside the base", async () => {
    server = await start();
    const { stack, runId } = await separated(server);
    const res = await server.json<FlattenResponse>(`/api/layers/${runId}/flatten`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(201);
    const flat = res.body.asset;
    expect([flat.width, flat.height, flat.mime, flat.op]).toEqual([1024, 1024, "image/png", "overlay"]);
    expect(flat.parentAssetId).toBe(stack.layers[0]!.asset.id);
    expect(flat.generative).toBe(false);
    expect(flat.providerId).toBe("local");
  });

  test("flatten takes the stack in a new order, with layers hidden or swapped for an edit", async () => {
    server = await start();
    const { stack, runId } = await separated(server);
    const [base, one, two] = stack.layers;
    const hidden = await server.json<FlattenResponse>(`/api/layers/${runId}/flatten`, {
      method: "POST",
      body: {
        layers: [
          { assetId: base!.asset.id },
          { assetId: two!.asset.id },
          { assetId: one!.asset.id, visible: false },
        ],
      },
    });
    expect(hidden.status).toBe(201);
    const entries = (hidden.body.asset.opParams as { layers: { entries: { assetId: string }[] } }).layers
      .entries;
    expect(entries.map((e) => e.assetId)).toEqual([base!.asset.id, two!.asset.id]);

    // An image from elsewhere needs a box of its own.
    const stranger = await upload(server, await texture(64, 64));
    const refused = await server.json(`/api/layers/${runId}/flatten`, {
      method: "POST",
      body: { layers: [{ assetId: stranger.id }] },
    });
    expect(refused.status).toBe(400);
    const placed = await server.json<FlattenResponse>(`/api/layers/${runId}/flatten`, {
      method: "POST",
      body: { layers: [{ assetId: base!.asset.id }, { assetId: stranger.id, box: [10, 10, 74, 74] }] },
    });
    expect(placed.status).toBe(201);
  });

  test("export as a zip: each layer as a PNG, the flattened picture and stack.json", async () => {
    server = await start();
    const { stack, runId } = await separated(server);
    const res = await server.request(`/api/layers/${runId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "zip" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(".zip");
    const dir = mkdtempSync(join(tmpdir(), "openfield-layers-"));
    try {
      const file = join(dir, "layers.zip");
      writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      const zip = await ZipArchive.open(file);
      expect(zip.entries.map((e) => e.name)).toEqual([
        "00 Base.png",
        "01 Layer 1.png",
        "02 Layer 2.png",
        "03 Layer 3.png",
        "flattened.png",
        "stack.json",
      ]);
      const json = JSON.parse(await new Response(await zip.open(zip.find("stack.json")!)).text());
      expect(json.canvas).toEqual(stack.canvas);
      expect(json.layers[1].box).toEqual(stack.layers[1]!.box);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("export as a PSD: one layer each at its box, bottom first, with names", async () => {
    server = await start();
    const { stack, runId } = await separated(server);
    const res = await server.request(`/api/layers/${runId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "psd" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/vnd.adobe.photoshop");
    const psd = readPsd(new Uint8Array(await res.arrayBuffer()));
    expect([psd.signature, psd.version, psd.channels, psd.depth, psd.mode]).toEqual(["8BPS", 1, 4, 8, 3]);
    expect([psd.width, psd.height]).toEqual([1024, 1024]);
    expect(psd.layers.map((l) => l.name)).toEqual(["Base", "Layer 1", "Layer 2", "Layer 3"]);
    const box = stack.layers[2]!.box;
    expect([psd.layers[2]!.left, psd.layers[2]!.top, psd.layers[2]!.right, psd.layers[2]!.bottom]).toEqual(
      box,
    );
    // The base is opaque all over.
    expect(psd.alpha.every((a) => a === 255)).toBe(true);
  });
});

describe("the PSD writer", () => {
  test("PackBits packs runs and literals and unpacks to the same row", () => {
    const row = Uint8Array.from([0, 0, 0, 0, 1, 2, 3, 7, 7, ...Array(300).fill(9)]);
    const packed = packBits(row);
    const out: number[] = [];
    for (let i = 0; i < packed.length; ) {
      const n = packed[i]! > 127 ? packed[i]! - 256 : packed[i]!;
      i++;
      if (n >= 0) for (let k = 0; k <= n; k++) out.push(packed[i++]!);
      else {
        const v = packed[i++]!;
        for (let k = 0; k < 1 - n; k++) out.push(v);
      }
    }
    expect(out).toEqual(Array.from(row));
    expect(packed.length).toBeLessThan(20);
  });

  test("a name past ASCII rides in full as unicode, and transparency comes through", () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.set([255, 0, 0, 0], 0);
    rgba.set([255, 0, 0, 128], 4);
    rgba.set([255, 0, 0, 255], 8);
    rgba.set([255, 0, 0, 255], 12);
    const bytes = writePsd({
      width: 4,
      height: 4,
      layers: [{ name: "Tasse à café", left: 1, top: 1, width: 2, height: 2, rgba }],
      composite: new Uint8Array(4 * 4 * 4),
    });
    const psd = readPsd(bytes);
    expect(psd.layers[0]?.name).toBe("Tasse à café");
    expect([psd.layers[0]!.left, psd.layers[0]!.top, psd.layers[0]!.right, psd.layers[0]!.bottom]).toEqual([
      1, 1, 3, 3,
    ]);
    expect(psd.alpha).toEqual([0, 128, 255, 255]);
  });
});

describe("agents", () => {
  async function connected() {
    server = await start();
    await turnOnAgents(server);
    agent = await connectAgent(server);
    return { s: server, c: agent };
  }

  test("list_models says which models take marks, separate layers or make related sets", async () => {
    const { c } = await connected();
    const listed = await call(c, "list_models", {});
    const models = listed.json.models as unknown as Record<string, unknown>[];
    const pro = models.find((m) => m.key === PRO)!;
    expect(pro.marks).toEqual(["point", "box", "circle", "stroke", "arrow"]);
    expect(pro.layers).toEqual({ sizes: ["auto", "1K", "1.5K", "2K"], most: 16 });
    expect(pro.can).toContain("separate an image into layers (separate_layers)");
    expect(models.find((m) => m.key === LITE)?.relatedSet).toBe(true);
    expect(pro.relatedSet).toBeUndefined();
  });

  test("separate_layers prices the range first, then answers the stack", async () => {
    const { s, c } = await connected();
    const source = await upload(s, await texture(1024, 1024));
    const priced = await call(c, "separate_layers", { image: source.id, model: PRO, dryRun: true });
    expect(priced.json).toMatchObject({ dryRun: true, price: { usd: 0.765, minUsd: 0.045 } });

    const made = await call(c, "separate_layers", { image: source.id, model: PRO, confirmCost: 0.765 });
    expect(made.isError).toBe(false);
    expect(made.json.status).toBe("succeeded");
    const layers = made.json.layers as unknown as { role: string; name?: string; box: number[] }[];
    expect(layers.map((l) => l.role)).toEqual(["base", "layer", "layer", "layer"]);
    expect(layers[1]?.name).toBe("Layer 1");
    // The run's image is the base, never one of its layers.
    const images = made.json.images as unknown as { assetId: string }[];
    expect(images).toHaveLength(1);
    expect(images[0]?.assetId).toBe((layers[0] as unknown as { assetId: string }).assetId);
  });

  test("Fast is only ever called Fast, and costs what Standard does", async () => {
    const { s, c } = await connected();
    const standard = await call(c, "estimate", { model: PRO, prompt: "A lighthouse" });
    expect(standard.json.speed).toBe("Standard");
    const set = await s.json("/api/providers/byteplus/settings", {
      method: "PATCH",
      body: { values: { speed: "priority" } },
    });
    expect(set.status).toBe(200);

    const models = (await call(c, "list_models", {})).json.models as unknown as Record<string, unknown>[];
    expect(models.find((m) => m.key === PRO)?.speed).toBe("Fast");
    // Flash has no Fast, so it runs at Standard.
    expect(models.find((m) => m.key === FLASH)?.speed).toBe("Standard");
    const fast = await call(c, "estimate", { model: PRO, prompt: "A lighthouse" });
    expect(fast.json.speed).toBe("Fast");
    expect(fast.json.price).toMatchObject({ usd: 0.09, basis: "1 × $0.09 (2K, Fast)" });
    expect(standard.json.price).toMatchObject({ usd: 0.09 });

    const made = await call(c, "generate_image", { model: PRO, prompt: "A lighthouse", confirmCost: 1 });
    expect(made.json.status).toBe("succeeded");
    expect(made.json.speed).toBe("Fast");
    const runId = made.json.runId as unknown as string;
    expect(getJobSet(s.services.db, runId)?.speed).toBe("priority");
    expect(usageOf(s, runId)[0]?.cost_usd).toBe((standard.json.price as unknown as { usd: number }).usd);
    const settings = await call(c, "get_settings", {});
    expect(JSON.stringify(settings.json)).not.toContain("Priority");
    expect(JSON.stringify(settings.json)).toContain("Fast");
  });

  test("separate_layers refuses a model that can't", async () => {
    const { s, c } = await connected();
    const source = await upload(s, await texture(1024, 1024));
    const refused = await call(c, "separate_layers", { image: source.id, model: LITE });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("can't separate layers");
  });

  test("generate_image takes marks on an edit", async () => {
    const { s, c } = await connected();
    const source = await upload(s, await texture(1024, 1024));
    const made = await call(c, "generate_image", {
      model: PRO,
      prompt: "Make the marked cup blue",
      edit: { image: source.id, marks: [{ kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.5 } }] },
      confirmCost: 1,
    });
    expect(made.isError).toBe(false);
    expect(made.json.status).toBe("succeeded");
    const run = getJobSet(s.services.db, made.json.runId as unknown as string)!;
    expect(run.requestJson.marks).toMatchObject([
      { kind: "box", from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.5 } },
    ]);
  });
});

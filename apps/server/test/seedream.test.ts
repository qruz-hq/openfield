import { afterEach, describe, expect, test } from "bun:test";
import { newId, type UploadResponse, uploadResponseSchema } from "@openfield/core";
import { assetsForJobSets, edgesInto, getJobSet, jobsOf } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import sharp from "sharp";
import { drawMarks, marksSvg } from "../src/files/marks";
import { completed, generate, startTestServer, type TestServer } from "./helpers";
import { texture } from "./pixels";

// Seedream end to end on the BytePlus fake: related sets that come back short or with an image
// moderated, a layer separation filed as a base and its layers, and marks drawn onto an image.

const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const LITE = "byteplus:seedream-5-0-260128";

let server: TestServer | undefined;
afterEach(async () => {
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

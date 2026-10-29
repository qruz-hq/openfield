import { afterEach, describe, expect, test } from "bun:test";
import {
  compileRun,
  fromDocument,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import { canvasDetailSchema, canvasRunResponseSchema, newId, uploadResponseSchema } from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import { assetsForJobSets, getAsset, getCanvas, getJobSet } from "@openfield/db";
import { serverEngineContext } from "../src/canvas/engine-context";
import { call, finished, image, item, MODEL, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { keptOutside, quarterMask, texture, whiteQuarter } from "./pixels";

// The Edit node on a canvas run (§7.7, §0.9): the server binds the image and the mask the node
// sends with its keep-the-rest settings, and the result keeps the original outside the mask,
// exactly as an edit from the detail view does.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const OPENAI = "openai:gpt-image-2";
const tab = { kind: "tab" as const, tabId: "tab-edit0001" };

async function ready(): Promise<TestServer> {
  const s = await startTestServer();
  await saveKey(s);
  const res = await s.json("/api/settings/keys/openai", {
    method: "PUT",
    body: { apiKey: "sk-test-0123456789abcdefghijklmnop" },
  });
  if (res.status !== 200) throw new Error(`Saving the OpenAI key failed: ${JSON.stringify(res.body)}`);
  return s;
}

async function upload(bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new File([bytes], "photo"));
  const res = await server!.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

/** A saved mask for `baseId`, transparent (the area to change) in its top-left quarter. */
async function paint(baseId: string, width: number, height: number): Promise<string> {
  const form = new FormData();
  form.append("mask", new File([await quarterMask(width, height)], "mask.png"));
  form.append("baseAssetId", baseId);
  const res = await server!.request("/api/masks", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

const savedDoc = (id: string): CanvasDocument =>
  canvasDocumentSchema.parse(getCanvas(server!.services.db, id)!.graph);

const fileOf = (id: string) => server!.services.ingest.fileOf(getAsset(server!.services.db, id)!.path);

/** Upload → Edit, with the mask painted in the node, saved the way the editor saves it. */
async function editCanvas(params: Record<string, unknown> = {}) {
  const base = await upload(await texture(640, 480));
  const mask = await paint(base, 640, 480);
  const canvas = await newCanvas(server!, { name: "Door" });
  const { aliases } = server!.services.canvases.edit(
    canvas.id,
    [
      { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [base] } },
      {
        op: "add_node",
        as: "e",
        type: "image.edit",
        params: { model: OPENAI, prompt: "a red door", maskAssetId: mask, maskFor: base, ...params },
      },
      { op: "connect", source: "up", target: "e", targetHandle: "image" },
    ],
    tab,
  );
  return { canvasId: canvas.id, base, mask, edit: aliases.e! };
}

/** Posts the whole canvas as the editor's Run all does: compiled from the saved document. */
async function post(canvasId: string) {
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

/** Runs the whole canvas to the end. The Edit node's one job set and its result. */
async function runAll(canvasId: string, edit: string) {
  const { run, done } = await post(canvasId);
  expect(done.status).toBe("succeeded");
  const jobSetId = run.jobSets.find((j) => j.nodeId === edit)!.jobSetId;
  const [made] = assetsForJobSets(server!.services.db, [jobSetId]);
  const result = savedDoc(canvasId).nodes.find((n) => n.id === edit)!.result!;
  return { set: getJobSet(server!.services.db, jobSetId)!, made: made!, result };
}

/** Nothing past expand plus feather (`reach`) took any of the edit, and the area to change did. */
async function expectKept(baseId: string, resultId: string, reach = 4 + 8) {
  const kept = await keptOutside(fileOf(baseId), fileOf(resultId), reach);
  expect(kept).toMatchObject({ sameShape: true, outside: 0 });
  expect(kept.inside).toBeGreaterThan(kept.quarter * 0.9);
}

const upToDate = async (canvasId: string) =>
  (await server!.services.canvasRuns.runScope(canvasId, { scope: "all", dryRun: true })).upToDate;

describe("an Edit node's run", () => {
  test("sends the painted mask with its settings and keeps the original outside it", async () => {
    server = await ready();
    const { canvasId, base, mask, edit } = await editCanvas();
    const { set, made, result } = await runAll(canvasId, edit);

    expect(set.op).toBe("inpaint");
    expect(set.requestJson).toMatchObject({
      base: { assetId: base, role: "base" },
      mask: { assetId: mask, composite: true, expandPx: 4, featherPx: 8 },
      source: "canvas",
    });
    expect(made).toMatchObject({
      kind: "edited",
      width: 640,
      height: 480,
      parentAssetId: base,
      maskAssetId: mask,
      opParams: { edit: { composite: { applied: true, expandPx: 4, featherPx: 8 } } },
    });
    await expectKept(base, made.id);

    expect(result.assetIds).toEqual([made.id]);
    expect(result.inputs).toEqual([base, mask].sort());
    // What it read is what it holds now, so it isn't run again.
    expect(await upToDate(canvasId)).toContain(edit);
  });

  test("its own grow and soften settings reach the composite", async () => {
    server = await ready();
    const { canvasId, base, edit } = await editCanvas({ expandPx: 0, featherPx: 16 });
    const { set, made } = await runAll(canvasId, edit);
    expect(set.requestJson.mask).toMatchObject({ composite: true, expandPx: 0, featherPx: 16 });
    expect(made.opParams).toMatchObject({
      edit: { composite: { applied: true, expandPx: 0, featherPx: 16 } },
    });
    await expectKept(base, made.id, 16);
  });

  test("with Keep the rest off, the model's own result is kept as it came", async () => {
    server = await ready();
    const { canvasId, mask, edit } = await editCanvas({ keepOriginal: false });
    const { set, made } = await runAll(canvasId, edit);
    expect(set.requestJson.mask).toEqual({ assetId: mask, composite: false, expandPx: 4, featherPx: 8 });
    expect(made.opParams).toMatchObject({ edit: { composite: { applied: false, reason: "off" } } });
  });
});

describe("an image wired into the Mask input", () => {
  /** Upload → Edit's image, and another Upload → Edit's mask: no mask painted in the node. */
  async function wiredCanvas(maskImage: Uint8Array) {
    const base = await upload(await texture(640, 480));
    const source = await upload(maskImage);
    const canvas = await newCanvas(server!, { name: "Wired" });
    const { aliases } = server!.services.canvases.edit(
      canvas.id,
      [
        { op: "add_node", as: "up", type: "image.upload", params: { assetIds: [base] } },
        { op: "add_node", as: "m", type: "image.upload", params: { assetIds: [source] } },
        { op: "add_node", as: "e", type: "image.edit", params: { model: OPENAI, prompt: "a red door" } },
        { op: "connect", source: "up", target: "e", targetHandle: "image" },
        { op: "connect", source: "m", target: "e", targetHandle: "mask" },
      ],
      tab,
    );
    return { canvasId: canvas.id, base, source, edit: aliases.e! };
  }

  test("goes as a mask saved for the image, white changing, and the rest is kept", async () => {
    server = await ready();
    const { canvasId, base, source, edit } = await wiredCanvas(await whiteQuarter(640, 480));
    const { set, made, result } = await runAll(canvasId, edit);

    const maskId = set.requestJson.mask!.assetId;
    expect(maskId).not.toBe(source);
    expect(getAsset(server.services.db, maskId)).toMatchObject({
      kind: "mask",
      parentAssetId: base,
      width: 640,
      height: 480,
    });
    expect(set.op).toBe("inpaint");
    expect(made).toMatchObject({ kind: "edited", parentAssetId: base, maskAssetId: maskId });
    await expectKept(base, made.id);

    // The node read the image it was given, so it's up to date with it.
    expect(result.inputs).toEqual([base, source].sort());
    expect(await upToDate(canvasId)).toContain(edit);
  });

  test("an image of another size isn't sent, and says why", async () => {
    server = await ready();
    const { canvasId, edit } = await wiredCanvas(await whiteQuarter(320, 240));
    const { run, done } = await post(canvasId);
    expect(done.status).toBe("failed");
    expect(run.jobSets).toEqual([]);
    expect(done.nodes.find((n) => n.nodeId === edit)).toMatchObject({
      state: "failed",
      error: { code: "invalid_request", reason: expect.stringContaining("320 × 240") },
    });
  });
});

describe("a mask painted on another image", () => {
  test("waits, without sending anything, when an earlier node makes a new image in the same run", async () => {
    server = await ready();
    const canvas = await newCanvas(server, { name: "Chain" });
    const { aliases } = server.services.canvases.edit(
      canvas.id,
      [
        {
          op: "add_node",
          as: "g",
          type: "image.generate",
          params: { model: MODEL, prompt: "A lighthouse at dusk", batch: 1 },
        },
        { op: "add_node", as: "e", type: "image.edit", params: { model: OPENAI, prompt: "a red door" } },
        { op: "connect", source: "g", target: "e", targetHandle: "image" },
      ],
      tab,
    );
    const [gen, edit] = [aliases.g!, aliases.e!];
    // Generate makes the image first; the Edit node has no mask yet, so it isn't sent.
    const first = await server.services.canvasRuns.runScope(canvas.id, { scope: "all" });
    expect(first.planned).toEqual([gen]);
    expect((await finished(server, first.runId!)).status).toBe("succeeded");
    const [painted] = savedDoc(canvas.id).nodes.find((n) => n.id === gen)!.result!.assetIds;
    const { width, height } = getAsset(server.services.db, painted!)!;
    const mask = await paint(painted!, width, height);
    server.services.canvases.edit(
      canvas.id,
      [
        { op: "update_node", id: edit, params: { maskAssetId: mask, maskFor: painted } },
        // A new prompt, so Generate makes another image before the edit is sent.
        { op: "update_node", id: gen, params: { prompt: "A lighthouse at dawn" } },
      ],
      tab,
    );

    const { run, done } = await post(canvas.id);
    // Planned with the image Generate had, the edit fits until Generate makes a new one.
    expect(run.nodes.map((n) => [n.nodeId, n.blocked])).toEqual([
      [gen, null],
      [edit, null],
    ]);
    expect(done.nodes.find((n) => n.nodeId === gen)!.assetIds).not.toContain(painted);
    expect(done.nodes.find((n) => n.nodeId === edit)).toMatchObject({
      state: "blocked",
      blocked: "mask_stale",
      jobSetIds: [],
    });
    expect(run.jobSets.map((j) => j.nodeId)).toEqual([gen]);
  });

  test("sent over another image of the same size, is refused before anything is spent", async () => {
    server = await ready();
    const painted = await upload(await texture(640, 480));
    const other = await upload(await image("png", { width: 640, height: 480 }));
    const canvas = await newCanvas(server);
    const mask = await paint(painted, 640, 480);
    const asset = (assetId: string) => ({ kind: "asset" as const, assetId });
    const plan = [
      item("n_edit", {
        type: "image.edit",
        model: OPENAI,
        inputs: [
          { port: "image", to: "base", arity: "single", values: [asset(other)] },
          { port: "mask", to: "mask", arity: "single", values: [asset(mask)] },
        ],
        calls: [call({ model: OPENAI, op: "inpaint", size: { kind: "auto" } })],
      }),
    ];
    const res = await server.json(`/api/canvases/${canvas.id}/run`, {
      method: "POST",
      body: { scope: "node", nodeIds: ["n_edit"], plan, dryRun: true },
    });
    expect(res.status).toBe(200);
    expect(canvasRunResponseSchema.parse(res.body)).toMatchObject({
      jobs: 0,
      nodes: [{ nodeId: "n_edit", jobs: 0, blocked: "mask_stale" }],
    });
  });
});

describe("a painted mask the library doesn't have", () => {
  test("can't be given to a node, and one deleted since shows as missing and isn't sent", async () => {
    server = await ready();
    const { canvasId, mask, edit } = await editCanvas();
    const nowhere = newId();
    expect(() =>
      server!.services.canvases.edit(
        canvasId,
        [{ op: "update_node", id: edit, params: { maskAssetId: nowhere } }],
        tab,
      ),
    ).toThrow(`No asset ${nowhere}`);

    server.services.library.trash([mask]);
    const detail = canvasDetailSchema.parse((await server.json(`/api/canvases/${canvasId}`)).body);
    expect(detail.missingAssetIds).toEqual([mask]);
    const dry = await server.services.canvasRuns.runScope(canvasId, { scope: "all", dryRun: true });
    expect(dry.nodes).toEqual([expect.objectContaining({ nodeId: edit, jobs: 0, blocked: "missing_asset" })]);
  });
});

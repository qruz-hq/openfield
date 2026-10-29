import { afterEach, describe, expect, test } from "bun:test";
import {
  compileRun,
  fromDocument,
  planFingerprints,
  resolveFingerprints,
  specRegistry,
} from "@openfield/canvas";
import { canvasRunResponseSchema, uploadResponseSchema } from "@openfield/core";
import { type CanvasDocument, canvasDocumentSchema } from "@openfield/core/canvas";
import { assetsForJobSets, getAsset, getCanvas, getJobSet } from "@openfield/db";
import { serverEngineContext } from "../src/canvas/engine-context";
import { finished, newCanvas } from "./canvas-helpers";
import { saveKey, startTestServer, type TestServer } from "./helpers";
import { keptOutside, quarterMask, texture } from "./pixels";

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

/**
 * Runs the whole canvas to the end as the editor does: compiled from the saved document, then
 * posted. The Edit node's one job set and its result.
 */
async function runAll(canvasId: string, edit: string) {
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
  expect((await finished(server!, run.runId!, 20_000)).status).toBe("succeeded");
  const jobSetId = run.jobSets.find((j) => j.nodeId === edit)!.jobSetId;
  const [made] = assetsForJobSets(server!.services.db, [jobSetId]);
  const result = savedDoc(canvasId).nodes.find((n) => n.id === edit)!.result!;
  return { set: getJobSet(server!.services.db, jobSetId)!, made: made!, result };
}

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
    // Nothing past expand plus feather takes any of the edit; the area to change does.
    const kept = await keptOutside(fileOf(base), fileOf(made.id), 4 + 8);
    expect(kept).toMatchObject({ sameShape: true, outside: 0 });
    expect(kept.inside).toBeGreaterThan(kept.quarter * 0.9);

    expect(result.assetIds).toEqual([made.id]);
    expect(result.inputs).toEqual([base, mask].sort());
    // What it read is what it holds now, so it isn't run again.
    const again = await server.services.canvasRuns.runScope(canvasId, { scope: "all", dryRun: true });
    expect(again.upToDate).toContain(edit);
  });

  test("its own grow and soften settings reach the composite", async () => {
    server = await ready();
    const { canvasId, base, edit } = await editCanvas({ expandPx: 0, featherPx: 16 });
    const { set, made } = await runAll(canvasId, edit);
    expect(set.requestJson.mask).toMatchObject({ composite: true, expandPx: 0, featherPx: 16 });
    expect(made.opParams).toMatchObject({
      edit: { composite: { applied: true, expandPx: 0, featherPx: 16 } },
    });
    expect(await keptOutside(fileOf(base), fileOf(made.id), 16)).toMatchObject({
      sameShape: true,
      outside: 0,
    });
  });

  test("with Keep the rest off, the model's own result is kept as it came", async () => {
    server = await ready();
    const { canvasId, mask, edit } = await editCanvas({ keepOriginal: false });
    const { set, made } = await runAll(canvasId, edit);
    expect(set.requestJson.mask).toEqual({ assetId: mask, composite: false, expandPx: 4, featherPx: 8 });
    expect(made.opParams).toMatchObject({ edit: { composite: { applied: false, reason: "off" } } });
  });
});

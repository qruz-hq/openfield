import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  assetsListResponseSchema,
  editOpParamsSchema,
  errorEnvelopeSchema,
  FIX_MODEL,
  FIX_ORIGINAL,
  fixesToRgba,
  jobSetAcceptedSchema,
  type KeepRestApplyResponse,
  type KeepRestState,
  keepRestApplyResponseSchema,
  keepRestSaveResponseSchema,
  keepRestStateSchema,
  newId,
  type UploadResponse,
  uploadResponseSchema,
} from "@openfield/core";
import { assetsForJobSets, getAsset, libraryStats } from "@openfield/db";
import sharp from "sharp";
import { completed, saveKey, startTestServer, type TestServer } from "./helpers";
import { quarterMask, texture } from "./pixels";

// Keep the rest after the run (§0.9): an edit keeps the model's own result hidden, can be made
// again with other settings in place and for free, and can save that result as an image of its
// own. The fake model draws a gradient that has nothing to do with the base, so these tests write
// a result of their own over the stored one: the base with a patch changed, as a model would.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const OPENAI = "openai:gpt-image-2";
const W = 640;
const H = 480;

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

async function upload(bytes: Uint8Array): Promise<UploadResponse["asset"]> {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], "photo"));
  const res = await server!.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset;
}

/** A masked edit of a textured base, run to the end: the top-left quarter may change. */
async function maskedEdit(mask: Record<string, unknown> = {}) {
  const baseBytes = await texture(W, H, { cell: 4 });
  const base = await upload(baseBytes);
  const form = new FormData();
  form.append("mask", new File([(await quarterMask(W, H)) as Uint8Array<ArrayBuffer>], "mask.png"));
  form.append("baseAssetId", base.id);
  const maskRes = await server!.request("/api/masks", { method: "POST", body: form });
  const maskId = uploadResponseSchema.parse(await maskRes.json()).asset.id;
  const res = await server!.json("/api/edit", {
    method: "POST",
    body: {
      idempotencyKey: newId(),
      model: OPENAI,
      op: "inpaint",
      prompt: "a red door",
      size: { kind: "auto" },
      batch: 1,
      source: "detail_editor",
      base: { assetId: base.id, role: "base" },
      mask: { assetId: maskId, ...mask },
    },
  });
  const run = jobSetAcceptedSchema.parse(res.body);
  expect((await completed(server!, run.jobSet.id)).status).toBe("succeeded");
  const [made] = assetsForJobSets(server!.services.db, [run.jobSet.id]);
  return { base, baseBytes, maskId, edit: made!, jobSetId: run.jobSet.id };
}

const RED = [220, 30, 30];
const BLUE = [30, 40, 220];
/** Inside the mask, and spilling 40 px out of it to the right. */
const PATCH = { x: 100, y: 80, w: 260, h: 120 };
/** A clear change far from the mask. */
const FAR = { x: 480, y: 340, w: 80, h: 80 };

/**
 * What a model sends back: the base with a red patch that spills out of the mask, a blue square
 * far from it, and a little grain everywhere, as a re-encode leaves.
 */
async function modelLike(baseBytes: Uint8Array): Promise<Uint8Array> {
  const { data } = await sharp(baseBytes).raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(data);
  let s = 7;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    out[i] = Math.max(0, Math.min(255, out[i]! + ((s >>> 29) - 3)));
  }
  const paint = (box: typeof PATCH, rgb: number[]) => {
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++) out.set(rgb, (y * W + x) * 3);
  };
  paint(PATCH, RED);
  paint(FAR, BLUE);
  return new Uint8Array(
    await sharp(out, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

/** Writes this over the edit's stored model result, as if the model had sent it. */
async function storeResult(editId: string, png: Uint8Array) {
  const row = getAsset(server!.services.db, editId)!;
  await Bun.write(server!.services.ingest.fileOf(row.resultPath!), png);
}

async function pixelsOf(input: string | Uint8Array) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    at: (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)),
    info,
  };
}

const db = () => server!.services.db;

const fileOfRow = (id: string) =>
  server!.services.ingest.fileOf(getAsset(server!.services.db, id, { includeDeleted: true })!.path);

async function state(id: string): Promise<KeepRestState> {
  const res = await server!.json(`/api/assets/${id}/keep-rest`);
  expect(res.status).toBe(200);
  return keepRestStateSchema.parse(res.body);
}

async function apply(id: string, body: Record<string, unknown>) {
  return server!.json<KeepRestApplyResponse>(`/api/assets/${id}/keep-rest`, { method: "POST", body });
}

/** A fix layer: `value` (FIX_MODEL or FIX_ORIGINAL) over the box, no opinion elsewhere. */
async function fixesPng(box: typeof PATCH, value: number, width = W, height = H) {
  const fixes = new Uint8Array(width * height);
  for (let y = box.y; y < box.y + box.h; y++) fixes.fill(value, y * width + box.x, y * width + box.x + box.w);
  return new Uint8Array(
    await sharp(fixesToRgba(fixes), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

async function applyFixes(id: string, settings: Record<string, unknown>, png: Uint8Array) {
  const form = new FormData();
  form.append("settings", JSON.stringify(settings));
  form.append("fixes", new File([png as Uint8Array<ArrayBuffer>], "fixes.png"));
  return server!.request(`/api/assets/${id}/keep-rest`, { method: "POST", body: form });
}

describe("the model's own result", () => {
  test("is kept hidden with a masked edit, counted in the library, and fetchable in full", async () => {
    server = await ready();
    const { base, edit, maskId } = await maskedEdit();
    expect(edit.resultPath).toBeTruthy();
    expect(edit.resultPath).not.toBe(edit.path);
    expect(existsSync(server.services.ingest.fileOf(edit.resultPath!))).toBe(true);
    expect(editOpParamsSchema.parse(edit.opParams?.edit).keepRest).toMatchObject({
      mode: "smart",
      sensitivity: 50,
      start: "mask",
      revision: 0,
      stored: true,
    });

    // Never in the feed: the edit is the only new image there.
    const list = assetsListResponseSchema.parse((await server.json("/api/assets?limit=50")).body);
    expect(list.items.map((a: { id: string }) => a.id).sort()).toEqual([base.id, edit.id].sort());
    const stats = libraryStats(server.services.db);
    expect(stats.bytes).toBeGreaterThanOrEqual(base.bytes + edit.bytes + edit.resultBytes!);

    const s = await state(edit.id);
    expect(s).toMatchObject({
      available: true,
      keep: true,
      mode: "smart",
      sensitivity: 50,
      expandPx: 4,
      featherPx: 8,
      start: "mask",
      // A gradient against a texture: nothing lines up, so the mask alone decided.
      fellBack: "no_match",
      note: "Kept by your mask only: the new image didn't line up with the original.",
      mask: { assetId: maskId },
      base: { assetId: base.id, width: W, height: H },
      lineUp: { dx: 0, dy: 0, scaleX: 1, scaleY: 1 },
      // As the fake model drew it: another size, which the kept version was stretched from.
      modelResult: { width: 768, height: 573, mime: "image/png", savedAs: null },
      revision: 0,
    });
    for (const url of [s.base!.url, s.mask!.url, s.modelResult!.url, s.modelResult!.fittedUrl, s.areaUrl!]) {
      const res = await server.request(url);
      expect(res.status, url).toBe(200);
      const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
      const size = url === s.modelResult!.url ? [768, 573] : [W, H];
      expect([meta.width, meta.height], url).toEqual(size);
    }
    const original = await server.request(s.modelResult!.url);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(
      new Uint8Array(await Bun.file(server.services.ingest.fileOf(edit.resultPath!)).arrayBuffer()),
    );
  }, 30_000);

  test("is the edit's own file when Keep the rest was off, and goes when the edit is purged", async () => {
    server = await ready();
    const { edit } = await maskedEdit({ composite: false });
    expect(edit.resultPath).toBe(edit.path);
    expect((await state(edit.id)).keep).toBe(false);

    const file = server.services.ingest.fileOf(edit.path);
    expect((await server.json(`/api/assets/${edit.id}?hard=1`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(file)).toBe(false);
  }, 30_000);

  test("stays through the Trash and goes with its image on purge", async () => {
    server = await ready();
    const { edit } = await maskedEdit();
    const result = server.services.ingest.fileOf(edit.resultPath!);
    const kept = server.services.ingest.fileOf(edit.path);
    await server.json(`/api/assets/${edit.id}`, { method: "DELETE" });

    const trashed = await state(edit.id);
    expect(trashed).toMatchObject({ available: false, unavailable: "in_trash" });
    expect((await apply(edit.id, { sensitivity: 60 })).status).toBe(409);
    // The Trash still shows what was decided.
    expect((await server.request(`/files/keep-rest-area/${edit.id}`)).status).toBe(200);
    expect(existsSync(result)).toBe(true);

    await server.json("/api/assets/bulk", { method: "POST", body: { action: "restore", ids: [edit.id] } });
    expect((await state(edit.id)).available).toBe(true);

    await server.json(`/api/assets/${edit.id}?hard=1`, { method: "DELETE" });
    expect([existsSync(result), existsSync(kept)]).toEqual([false, false]);
    expect((await server.request(`/files/model-result/${edit.id}`)).status).toBe(404);
  }, 30_000);
});

describe("adjusting an edit in place", () => {
  test("grows into what spilled, keeps clear changes far away, and puts back the rest", async () => {
    server = await ready();
    const { baseBytes, edit } = await maskedEdit();
    await storeResult(edit.id, await modelLike(baseBytes));
    const events = server.events.length;

    const res = await apply(edit.id, {});
    expect(res.status).toBe(200);
    const out = keepRestApplyResponseSchema.parse(res.body);
    expect(out.changed).toBe(true);
    expect(out.state).toMatchObject({ keep: true, mode: "smart", revision: 1, fellBack: null });
    expect(out.state.lineUp!.confidence).toBeGreaterThan(0.3);
    expect(Math.abs(out.state.lineUp!.dx)).toBeLessThan(0.5);
    // The file changed in place, so its URLs changed with it.
    expect(out.asset.fileUrl).toMatch(/\?v=[0-9a-f]{12}$/);
    expect(out.asset.thumbUrl).toMatch(/&v=[0-9a-f]{12}$/);
    for (const url of [out.asset.fileUrl, out.asset.thumbUrl])
      expect((await server.request(url)).status, url).toBe(200);
    expect(out.asset.sha256).not.toBe(edit.sha256);
    const afterPath = getAsset(server.services.db, edit.id)!.path;
    expect(server.events.slice(events).some((e) => e.event === "asset.updated")).toBe(true);
    // The old kept file went; the model's result stays.
    expect(existsSync(server.services.ingest.fileOf(edit.path))).toBe(false);
    expect(existsSync(server.services.ingest.fileOf(edit.resultPath!))).toBe(true);

    const base = await pixelsOf(baseBytes);
    const made = await pixelsOf(fileOfRow(edit.id));
    // In the mask, and where it spilled out of it.
    expect(made.at(200, 140)).toEqual(RED);
    expect(made.at(350, 140)).toEqual(RED);
    // A clear change far from the mask.
    expect(made.at(520, 380)).toEqual(BLUE);
    // Unchanged, inside the mask and out: the original's own values, grain and all undone.
    expect(made.at(40, 30)).toEqual(base.at(40, 30));
    expect(made.at(600, 60)).toEqual(base.at(600, 60));
    expect(made.at(200, 400)).toEqual(base.at(200, 400));

    // The same settings again decide the same picture: nothing is rewritten.
    const again = keepRestApplyResponseSchema.parse((await apply(edit.id, {})).body);
    expect(again.changed).toBe(false);
    expect(again.asset.sha256).toBe(out.asset.sha256);
    expect(getAsset(server.services.db, edit.id)!.path).toBe(afterPath);
  }, 30_000);

  test("the mask alone keeps only the mask; the area map follows the settings asked", async () => {
    server = await ready();
    const { baseBytes, edit } = await maskedEdit();
    await storeResult(edit.id, await modelLike(baseBytes));

    const area = async (q: string) =>
      pixelsOf(
        new Uint8Array(await (await server!.request(`/files/keep-rest-area/${edit.id}${q}`)).arrayBuffer()),
      );
    const smart = await area("");
    const maskOnly = await area("?mode=mask");
    expect(smart.at(350, 140)[0]).toBe(255);
    expect(maskOnly.at(350, 140)[0]).toBe(0);
    expect(maskOnly.at(200, 140)[0]).toBe(255);
    // Nothing applied yet.
    expect((await state(edit.id)).revision).toBe(0);

    const out = keepRestApplyResponseSchema.parse((await apply(edit.id, { mode: "mask" })).body);
    expect(out.state).toMatchObject({ mode: "mask", fellBack: null, revision: 1 });
    const base = await pixelsOf(baseBytes);
    const made = await pixelsOf(fileOfRow(edit.id));
    expect(made.at(350, 140)).toEqual(base.at(350, 140));
    expect(made.at(520, 380)).toEqual(base.at(520, 380));
    // Inside the mask the model's grain stays, as it always did with the mask alone.
    expect(made.at(200, 140)).toEqual(RED);
  }, 30_000);

  test("fixes paint the model or the original back, are kept, and can be cleared", async () => {
    server = await ready();
    const { baseBytes, edit } = await maskedEdit();
    await storeResult(edit.id, await modelLike(baseBytes));
    const base = await pixelsOf(baseBytes);

    // The original over the far square, the model over an untouched corner of the picture.
    const corner = { x: 560, y: 20, w: 60, h: 60 };
    const layer = new Uint8Array(W * H);
    for (let y = FAR.y; y < FAR.y + FAR.h; y++)
      layer.fill(FIX_ORIGINAL, y * W + FAR.x, y * W + FAR.x + FAR.w);
    for (let y = corner.y; y < corner.y + corner.h; y++)
      layer.fill(FIX_MODEL, y * W + corner.x, y * W + corner.x + corner.w);
    const png = new Uint8Array(
      await sharp(fixesToRgba(layer), { raw: { width: W, height: H, channels: 4 } })
        .png()
        .toBuffer(),
    );

    const res = await applyFixes(edit.id, { sensitivity: 50 }, png);
    expect(res.status).toBe(200);
    const out = keepRestApplyResponseSchema.parse(await res.json());
    expect(out.state.fixesUrl).toBeTruthy();
    let made = await pixelsOf(fileOfRow(edit.id));
    expect(made.at(520, 380)).toEqual(base.at(520, 380));
    expect(made.at(590, 50)).not.toEqual(base.at(590, 50));
    expect(made.at(200, 140)).toEqual(RED);

    const fixesRes = await server.request(out.state.fixesUrl!);
    expect(fixesRes.status).toBe(200);
    const fixesFile = server.services.ingest.fileOf(getAsset(server.services.db, edit.id)!.fixesPath!);

    // Kept for the next change of settings.
    const next = keepRestApplyResponseSchema.parse((await apply(edit.id, { sensitivity: 40 })).body);
    expect(next.state.fixesUrl).toBeTruthy();
    made = await pixelsOf(fileOfRow(edit.id));
    expect(made.at(520, 380)).toEqual(base.at(520, 380));

    const cleared = keepRestApplyResponseSchema.parse((await apply(edit.id, { fixes: "clear" })).body);
    expect(cleared.state.fixesUrl).toBeNull();
    expect(existsSync(fixesFile)).toBe(false);
    made = await pixelsOf(fileOfRow(edit.id));
    expect(made.at(520, 380)).toEqual(BLUE);
  }, 30_000);

  test("refuses to turn off in place, fixes of another size, and settings out of range", async () => {
    server = await ready();
    const { edit } = await maskedEdit();
    const off = await apply(edit.id, { keep: false });
    expect(off.status).toBe(400);
    expect(errorEnvelopeSchema.parse(off.body).error.userMessage).toBe(
      "To keep the model's whole result, save it as a new image.",
    );
    const wrong = await applyFixes(
      edit.id,
      {},
      await fixesPng({ x: 0, y: 0, w: 10, h: 10 }, FIX_MODEL, 320, 240),
    );
    expect(wrong.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await wrong.json()).error.userMessage).toContain("320 × 240");
    expect((await apply(edit.id, { sensitivity: 101 })).status).toBe(400);
    // None of that changed anything.
    expect(getAsset(server.services.db, edit.id)!.sha256).toBe(edit.sha256);
  }, 30_000);

  test("an edit made with Keep the rest off can be turned on after", async () => {
    server = await ready();
    const { baseBytes, edit } = await maskedEdit({ composite: false });
    // The stored result is the edit's own file, so write one at the base's size over both.
    await storeResult(edit.id, await modelLike(baseBytes));
    const out = keepRestApplyResponseSchema.parse((await apply(edit.id, { keep: true })).body);
    expect(out.state).toMatchObject({ keep: true, revision: 1 });
    const row = getAsset(server.services.db, edit.id)!;
    expect(row.path).not.toBe(row.resultPath);
    // Filed at the model's size; now the original's, as a PNG.
    expect(edit.width).toBe(768);
    expect(row).toMatchObject({ width: W, height: H, mime: "image/png" });
    expect(out.asset).toMatchObject({ width: W, height: H, mime: "image/png" });
    // The model's result, which was the edit's file, stays.
    expect(existsSync(server.services.ingest.fileOf(row.resultPath!))).toBe(true);
    const made = await pixelsOf(fileOfRow(edit.id));
    const base = await pixelsOf(baseBytes);
    expect(made.at(200, 400)).toEqual(base.at(200, 400));
  }, 30_000);
});

describe("a Sketch & point edit", () => {
  test("starts from the area its marks cover, off until it's turned on", async () => {
    server = await ready();
    const { baseBytes, edit } = await maskedEdit({ composite: false });
    // As Sketch & point files it: marks and no mask, Keep the rest off, the result as it came.
    const marks = [{ kind: "box", from: { x: 100 / W, y: 80 / H }, to: { x: 360 / W, y: 200 / H } }];
    const record = editOpParamsSchema.parse(edit.opParams?.edit);
    db()
      .$client.query("UPDATE assets SET mask_asset_id = NULL, params = ?, op_params = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...edit.params, mask: undefined, marks }),
        JSON.stringify({
          ...edit.opParams,
          edit: { ...record, keepRest: { ...record.keepRest, start: "marks" } },
        }),
        edit.id,
      );
    await storeResult(edit.id, await modelLike(baseBytes));
    expect(await state(edit.id)).toMatchObject({
      available: true,
      keep: false,
      start: "marks",
      mask: null,
      marks,
    });

    const out = keepRestApplyResponseSchema.parse((await apply(edit.id, { keep: true })).body);
    expect(out.state).toMatchObject({ keep: true, start: "marks", revision: 1 });
    expect(getAsset(db(), edit.id)).toMatchObject({ width: W, height: H, mime: "image/png" });
    const base = await pixelsOf(baseBytes);
    const made = await pixelsOf(fileOfRow(edit.id));
    expect(made.at(200, 140)).toEqual(RED);
    expect(made.at(520, 380)).toEqual(BLUE);
    expect(made.at(200, 400)).toEqual(base.at(200, 400));
  }, 30_000);
});

describe("saving the model's result as a new image", () => {
  test("adds it to the library once, beside the original, and it outlives the edit", async () => {
    server = await ready();
    const { base, edit } = await maskedEdit();
    const res = await server.json(`/api/assets/${edit.id}/keep-rest/save`, { method: "POST" });
    expect(res.status).toBe(201);
    const saved = keepRestSaveResponseSchema.parse(res.body);
    expect(saved.existing).toBe(false);
    expect(saved.asset).toMatchObject({
      kind: "edited",
      parentAssetId: base.id,
      rootAssetId: base.rootAssetId,
      costUsd: null,
      width: 768,
      height: 573,
    });
    const row = getAsset(server.services.db, saved.asset.id)!;
    expect(row.path).toBe(edit.resultPath!);
    expect(row.jobId).toBeNull();
    expect(row.resultPath).toBeNull();

    const again = await server.json(`/api/assets/${edit.id}/keep-rest/save`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(keepRestSaveResponseSchema.parse(again.body)).toMatchObject({
      existing: true,
      asset: { id: saved.asset.id },
    });

    expect((await state(edit.id)).modelResult!.savedAs).toBe(saved.asset.id);
    expect(await state(saved.asset.id)).toMatchObject({
      available: false,
      unavailable: "saved_result",
      note: "This is the model's own result, saved as an image of its own.",
    });
    const list = assetsListResponseSchema.parse((await server.json("/api/assets?limit=50")).body);
    expect(list.items.map((a: { id: string }) => a.id)).toContain(saved.asset.id);

    // Purging the edit leaves the saved image's file alone.
    await server.json(`/api/assets/${edit.id}?hard=1`, { method: "DELETE" });
    expect(existsSync(server.services.ingest.fileOf(row.path))).toBe(true);
    expect((await server.request(`/files/asset/${saved.asset.id}`)).status).toBe(200);
  }, 30_000);
});

describe("an edit that can't be adjusted", () => {
  test("says why, in plain words, and refuses changes", async () => {
    server = await ready();
    const { base, edit } = await maskedEdit();
    // As an edit made before the model's result was kept.
    const { db } = server.services;
    const before = editOpParamsSchema.parse(edit.opParams?.edit);
    const { keepRest: _k, ...old } = before;
    db.$client
      .query("UPDATE assets SET op_params = ?, result_path = NULL, result_bytes = NULL WHERE id = ?")
      .run(JSON.stringify({ ...edit.opParams, edit: old }), edit.id);
    expect(await state(edit.id)).toMatchObject({
      available: false,
      unavailable: "not_stored",
      note: "This edit was made before the model's result was kept.",
      modelResult: null,
      areaUrl: null,
    });
    const refused = await apply(edit.id, { sensitivity: 60 });
    expect(refused.status).toBe(409);
    expect(errorEnvelopeSchema.parse(refused.body).error.userMessage).toBe(
      "This edit was made before the model's result was kept.",
    );
    expect((await server.json(`/api/assets/${edit.id}/keep-rest/save`, { method: "POST" })).status).toBe(409);

    expect(await state(base.id)).toMatchObject({ available: false, unavailable: "not_an_edit" });
    expect((await server.json(`/api/assets/01JAAAAAAAAAAAAAAAAAAAAAAA/keep-rest`)).status).toBe(404);
  }, 30_000);
});

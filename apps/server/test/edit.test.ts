import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  assetDetailResponseSchema,
  type CostEstimate,
  editOpParamsSchema,
  errorEnvelopeSchema,
  jobSetAcceptedSchema,
  newId,
  type UploadResponse,
  uploadResponseSchema,
} from "@openfield/core";
import { assetsForJobSets, getAsset, getJobSet, jobsOf } from "@openfield/db";
import { createFakeFetch } from "@openfield/providers/server";
import sharp from "sharp";
import { completed, saveKey, startTestServer, type TestServer, waitFor } from "./helpers";
import { keptOutside, quarterMask, texture } from "./pixels";

// POST /api/edit (§0.6): every op but generate, in the generate body. An edit's base and mask are
// checked before the job set exists, an edit that leaves its size open asks for the base's, and
// the estimate route prices it the way the run will.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const OPENAI = "openai:gpt-image-2";
const NANO_BANANA = "google:gemini-3.1-flash-image";

async function ready(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const s = await startTestServer(opts);
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
  form.append("file", new File([bytes], "photo"));
  const res = await server!.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset;
}

const photo = async (width: number, height: number, format: "png" | "jpeg" = "png") =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#3a6ea5" } })
      [format]()
      .toBuffer(),
  );

/** A saved mask for `baseId`, transparent in its top-left quarter. */
async function mask(baseId: string, width: number, height: number): Promise<string> {
  const form = new FormData();
  form.append("mask", new File([await quarterMask(width, height)], "mask.png"));
  form.append("baseAssetId", baseId);
  const res = await server!.request("/api/masks", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset.id;
}

function editBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: newId(),
    model: OPENAI,
    op: "inpaint",
    prompt: "a red door",
    size: { kind: "auto" },
    batch: 1,
    source: "detail_editor",
    ...overrides,
  };
}

const edit = (overrides: Record<string, unknown> = {}) =>
  server!.json("/api/edit", { method: "POST", body: editBody(overrides) });

const jobSets = () =>
  (server!.services.db.$client.query("SELECT count(*) AS n FROM job_sets").get() as { n: number }).n;

describe("POST /api/edit", () => {
  test("a masked edit starts at once and asks for the base's own size", async () => {
    server = await ready();
    const base = await upload(await photo(1920, 1080));
    const maskId = await mask(base.id, 1920, 1080);
    const res = await edit({ base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } });
    expect(res.status).toBe(202);
    const accepted = jobSetAcceptedSchema.parse(res.body);
    const set = getJobSet(server.services.db, accepted.jobSet.id)!;
    expect(set.op).toBe("inpaint");
    // OpenAI takes multiples of 16, so 1080 rounds to the nearest legal height.
    expect(set.requestJson).toMatchObject({
      op: "inpaint",
      size: { width: 1920, height: 1088 },
      resolution: "2K",
      mask: { assetId: maskId },
    });
    await completed(server, accepted.jobSet.id);
  });

  test("a size the request chose stays; a model that takes shapes gets the base's nearest", async () => {
    server = await ready();
    const base = await upload(await photo(1920, 1080));
    const chosen = jobSetAcceptedSchema.parse(
      (
        await edit({
          op: "edit",
          base: { assetId: base.id, role: "base" },
          size: { kind: "aspect", ratio: "1:1" },
          resolution: "1K",
        })
      ).body,
    );
    expect(getJobSet(server.services.db, chosen.jobSet.id)!.requestJson).toMatchObject({
      size: { aspect: "1:1" },
      resolution: "1K",
    });

    const maskId = await mask(base.id, 1920, 1080);
    const banana = jobSetAcceptedSchema.parse(
      (
        await edit({
          model: NANO_BANANA,
          op: "edit",
          base: { assetId: base.id, role: "base" },
          mask: { assetId: maskId },
        })
      ).body,
    );
    expect(getJobSet(server.services.db, banana.jobSet.id)!.requestJson).toMatchObject({
      op: "edit",
      size: { aspect: "16:9" },
      resolution: "2K",
      mask: { assetId: maskId },
    });
    await completed(server, chosen.jobSet.id);
    await completed(server, banana.jobSet.id);
  });

  test("a base or mask that can't be used is refused before anything is made", async () => {
    server = await ready();
    const base = await upload(await photo(640, 480));
    const other = await upload(await photo(480, 640));
    const maskId = await mask(base.id, 640, 480);
    const onBase = { base: { assetId: base.id, role: "base" } };
    const refusal = async (overrides: Record<string, unknown>) => {
      const res = await edit(overrides);
      expect(res.status).toBe(400);
      return errorEnvelopeSchema.parse(res.body).error;
    };

    expect(await refusal({ ...onBase, mask: { assetId: newId() } })).toMatchObject({
      field: "mask",
      userMessage: "This mask isn't saved anymore. Paint the area to change again.",
    });
    // An image, even one the right size, isn't a saved mask.
    const lookalike = await upload(await photo(640, 480, "jpeg"));
    expect(await refusal({ ...onBase, mask: { assetId: lookalike.id } })).toMatchObject({
      field: "mask",
      userMessage: "This is an image, not a saved mask. Save the mask first, then try again.",
    });
    expect(
      await refusal({ base: { assetId: other.id, role: "base" }, mask: { assetId: maskId } }),
    ).toMatchObject({
      field: "mask",
      userMessage:
        "This mask is 640 × 480 and the image is 480 × 640. Draw the mask over the image itself, then try again.",
    });
    expect(await refusal({ base: { assetId: newId(), role: "base" } })).toMatchObject({
      field: "base",
      userMessage: "This image isn't in your library anymore.",
    });
    expect(await refusal({ base: { assetId: maskId, role: "base" }, op: "edit" })).toMatchObject({
      field: "base",
      userMessage: "Only images can be edited with a mask.",
    });
    expect(await refusal({ ...onBase, op: "inpaint" })).toMatchObject({ field: "mask" });
    expect(await refusal({ ...onBase, mask: { assetId: maskId, invert: true } })).toMatchObject({
      field: "mask",
    });

    const asGenerate = await server.json("/api/edit", { method: "POST", body: editBody({ op: "generate" }) });
    expect(errorEnvelopeSchema.parse(asGenerate.body).error.field).toBe("op");
    expect(jobSets()).toBe(0);
  });

  test("with approximate area edits turned off, a model without a mask input is refused", async () => {
    server = await ready();
    const patched = await server.json("/api/settings", {
      method: "PATCH",
      body: { regionalFallback: false },
    });
    expect(patched.status).toBe(200);
    const base = await upload(await photo(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const asked = { base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } };
    const res = await edit({ model: NANO_BANANA, op: "edit", ...asked });
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
      code: "capability_unsupported",
      field: "mask",
      userMessage:
        "Nano Banana 2 can only edit the whole image. Choose another model, or allow approximate area edits in Settings.",
    });
    expect(jobSets()).toBe(0);
    // A model that takes the mask itself is unaffected.
    const inpaint = jobSetAcceptedSchema.parse((await edit(asked)).body);
    await completed(server, inpaint.jobSet.id);
  });

  test("a photo saved on its side can't be edited with a mask yet", async () => {
    server = await ready();
    const upright = await upload(await photo(640, 480, "jpeg"));
    const maskId = await mask(upright.id, 640, 480);
    const sideways = await upload(
      new Uint8Array(
        await sharp({ create: { width: 640, height: 480, channels: 3, background: "#a53a6e" } })
          .withMetadata({ orientation: 6 })
          .jpeg()
          .toBuffer(),
      ),
    );
    const res = await edit({ base: { assetId: sideways.id, role: "base" }, mask: { assetId: maskId } });
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
      field: "base",
      userMessage:
        "This photo is saved on its side, so it can't be edited with a mask yet. Save an upright copy, add it to your library and try again.",
    });
    expect(jobSets()).toBe(0);
    // Without a mask it's a whole-image edit, and nothing has to line up.
    expect((await edit({ op: "edit", base: { assetId: sideways.id, role: "base" } })).status).toBe(202);
  });

  test("a masked edit of an image past the pixel limit is refused before anything is made", async () => {
    server = await ready();
    const base = await upload(await photo(640, 480));
    const maskId = await mask(base.id, 640, 480);
    server.services.db.$client.run("UPDATE assets SET width = 10000, height = 6000 WHERE id = ?", [base.id]);
    const res = await edit({ base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } });
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
      field: "base",
      userMessage:
        "This image is 10,000 × 6,000, too large to edit with a mask. Masked edits take images up to 50 megapixels.",
    });
    expect(jobSets()).toBe(0);
    // Without a mask there's no composite to make, so the size is the model's to judge.
    const whole = jobSetAcceptedSchema.parse(
      (await edit({ op: "edit", base: { assetId: base.id, role: "base" } })).body,
    );
    await completed(server, whole.jobSet.id);
  });

  test("an image larger than the model takes is refused before anything is made", async () => {
    server = await ready();
    const base = await upload(await photo(640, 480));
    const maskId = await mask(base.id, 640, 480);
    // As a 4K composite can come out: past Nano Banana's 20 MB, within OpenAI's 50 MB.
    server.services.db.$client.run("UPDATE assets SET bytes = 30000000 WHERE id = ?", [base.id]);
    const asked = { op: "edit", base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } };
    const res = await edit({ model: NANO_BANANA, ...asked });
    expect(res.status).toBe(413);
    expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
      code: "payload_too_large",
      field: "base",
      userMessage: "This image is too large for Nano Banana 2. The limit is 20 MB.",
    });
    const asRef = await server.json("/api/generate", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: NANO_BANANA,
        op: "generate",
        prompt: "a red door",
        size: { kind: "auto" },
        batch: 1,
        source: "composer",
        references: [{ assetId: base.id, role: "subject" }],
      },
    });
    expect(asRef.status).toBe(413);
    expect(errorEnvelopeSchema.parse(asRef.body).error.field).toBe("references");
    expect(jobSets()).toBe(0);
    const openai = jobSetAcceptedSchema.parse((await edit(asked)).body);
    await completed(server, openai.jobSet.id);
  });

  test("a saved mask can't be sent as a reference image", async () => {
    server = await ready();
    const base = await upload(await photo(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const res = await server.json("/api/generate", {
      method: "POST",
      body: {
        idempotencyKey: newId(),
        model: NANO_BANANA,
        op: "generate",
        prompt: "a red door",
        size: { kind: "auto" },
        batch: 1,
        source: "composer",
        references: [{ assetId: maskId, role: "subject" }],
      },
    });
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(res.body).error).toMatchObject({
      field: "references",
      userMessage: "This is a mask, not an image. Choose an image instead.",
    });
    const asEditRef = await edit({
      base: { assetId: base.id, role: "base" },
      mask: { assetId: maskId },
      references: [{ assetId: maskId, role: "style" }],
    });
    expect(errorEnvelopeSchema.parse(asEditRef.body).error.field).toBe("references");
    expect(jobSets()).toBe(0);
  });

  test("the estimate route prices an edit as the run does, its base at its own size", async () => {
    server = await ready();
    // Small enough that OpenAI counts it as fewer input tokens than an image of unknown size.
    const base = await upload(await photo(512, 512));
    const maskId = await mask(base.id, 512, 512);
    const asked = { base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } };
    const priced = await server.json<CostEstimate>("/api/models/openai/gpt-image-2/estimate", {
      method: "POST",
      body: { op: "inpaint", prompt: "a red door", batch: 2, ...asked },
    });
    expect(priced.status).toBe(200);
    const run = jobSetAcceptedSchema.parse((await edit({ ...asked, batch: 2 })).body);
    expect(run.jobSet.costEstimateUsd).toBe(priced.body.max);

    // The same edit with a base of unknown size could cost more.
    const unknownBase = await server.json<CostEstimate>("/api/models/openai/gpt-image-2/estimate", {
      method: "POST",
      body: {
        op: "inpaint",
        prompt: "a red door",
        batch: 2,
        size: { kind: "pixels", width: 816, height: 816 },
        resolution: "1K",
        base: { assetId: newId(), role: "base" },
      },
    });
    expect(unknownBase.body.max).toBeGreaterThan(priced.body.max);
    await completed(server, run.jobSet.id);
  });

  test("an edit that leaves its size open is priced at the tier the run asks for", async () => {
    server = await ready();
    // Nano Banana prices by tier, and a 1920 × 1080 base asks for 2K, not the usual 1K.
    const base = await upload(await photo(1920, 1080));
    const maskId = await mask(base.id, 1920, 1080);
    const asked = { op: "edit", base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } };
    const priced = await server.json<CostEstimate>("/api/models/google/gemini-3.1-flash-image/estimate", {
      method: "POST",
      body: { prompt: "a red door", batch: 1, ...asked },
    });
    const at1K = await server.json<CostEstimate>("/api/models/google/gemini-3.1-flash-image/estimate", {
      method: "POST",
      body: { prompt: "a red door", batch: 1, ...asked, resolution: "1K" },
    });
    expect(priced.body.max).toBeGreaterThan(at1K.body.max);
    const run = jobSetAcceptedSchema.parse((await edit({ model: NANO_BANANA, ...asked })).body);
    expect(run.jobSet.costEstimateUsd).toBe(priced.body.max);
    await completed(server, run.jobSet.id);
  });

  test("an edit without a mask keeps the model's usual tier, whatever the base's size", async () => {
    server = await ready();
    const base = await upload(await photo(3000, 2000));
    const onBase = { base: { assetId: base.id, role: "base" } };
    const plain = jobSetAcceptedSchema.parse(
      (await edit({ model: NANO_BANANA, op: "edit", ...onBase })).body,
    );
    // Nothing is laid back over the base, so there's no reason to pay for 4K.
    expect(getJobSet(server.services.db, plain.jobSet.id)!.requestJson).toMatchObject({
      size: { aspect: "3:2" },
      resolution: "1K",
    });
    const maskId = await mask(base.id, 3000, 2000);
    const masked = jobSetAcceptedSchema.parse(
      (await edit({ model: NANO_BANANA, op: "edit", ...onBase, mask: { assetId: maskId } })).body,
    );
    expect(getJobSet(server.services.db, masked.jobSet.id)!.requestJson).toMatchObject({
      size: { aspect: "3:2" },
      resolution: "4K",
    });
    expect(masked.jobSet.costEstimateUsd!).toBeGreaterThan(plain.jobSet.costEstimateUsd!);
    await completed(server, plain.jobSet.id);
    await completed(server, masked.jobSet.id);
  });

  test("a tier the edit asks for is the size sent and the size priced", async () => {
    server = await ready();
    const base = await upload(await photo(3840, 2160));
    const maskId = await mask(base.id, 3840, 2160);
    const asked = {
      base: { assetId: base.id, role: "base" },
      mask: { assetId: maskId },
      resolution: "1K",
      quality: "medium",
    };
    const priced = await server.json<CostEstimate>("/api/models/openai/gpt-image-2/estimate", {
      method: "POST",
      body: { op: "inpaint", prompt: "a red door", batch: 1, ...asked },
    });
    const run = jobSetAcceptedSchema.parse((await edit(asked)).body);
    // Sent at 1K in the base's shape, not at 3840 × 2160 under a 1K price.
    expect(getJobSet(server.services.db, run.jobSet.id)!.requestJson).toMatchObject({
      size: { width: 1088, height: 608 },
      resolution: "1K",
    });
    expect(run.jobSet.costEstimateUsd).toBe(priced.body.max);
    await completed(server, run.jobSet.id);

    // An exact size asked for outright is priced at that size too.
    const large = jobSetAcceptedSchema.parse(
      (
        await server.json("/api/generate", {
          method: "POST",
          body: {
            idempotencyKey: newId(),
            model: OPENAI,
            op: "generate",
            prompt: "a red door",
            size: { kind: "pixels", width: 3840, height: 2160 },
            resolution: "1K",
            quality: "medium",
            batch: 1,
            source: "api",
          },
        })
      ).body,
    );
    expect(large.jobSet.costEstimateUsd!).toBeGreaterThan(0.1);
    await completed(server, large.jobSet.id);
  });

  test("a masked edit keeps its base's shape: a size of another shape is refused", async () => {
    server = await ready();
    const base = await upload(await photo(1920, 1080));
    const maskId = await mask(base.id, 1920, 1080);
    const asked = { base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } };
    const square = await edit({ ...asked, size: { kind: "aspect", ratio: "1:1" } });
    expect(square.status).toBe(400);
    expect(errorEnvelopeSchema.parse(square.body).error).toMatchObject({
      field: "size",
      userMessage:
        "An edit with a mask keeps the image's own shape, so the edit lines up with it. Leave the aspect ratio on Auto.",
    });
    const tall = await edit({ ...asked, size: { kind: "pixels", width: 1088, height: 1920 } });
    expect(errorEnvelopeSchema.parse(tall.body).error.field).toBe("size");
    expect(jobSets()).toBe(0);

    // The base's own shape is fine, snapped to the model's grid or not, and so is any shape when
    // the model's whole result is kept.
    for (const overrides of [
      { size: { kind: "aspect", ratio: "16:9" } },
      { size: { kind: "pixels", width: 1920, height: 1088 } },
      { size: { kind: "aspect", ratio: "1:1" }, mask: { assetId: maskId, composite: false } },
    ]) {
      const res = await edit({ ...asked, ...overrides });
      expect({ overrides, status: res.status }).toEqual({ overrides, status: 202 });
      await completed(server, jobSetAcceptedSchema.parse(res.body).jobSet.id);
    }
  });
});

describe("the edited image's detail", () => {
  test("names the mask it was made with, even once the mask is in the Trash", async () => {
    server = await ready();
    const base = await upload(await photo(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const run = jobSetAcceptedSchema.parse(
      (await edit({ base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } })).body,
    );
    await completed(server, run.jobSet.id);
    const [made] = assetsForJobSets(server.services.db, [run.jobSet.id]);
    const detail = async (id: string) =>
      assetDetailResponseSchema.parse((await server!.json(`/api/assets/${id}`)).body);

    const edited = await detail(made!.id);
    expect(edited.asset.maskAssetId).toBe(maskId);
    expect(edited.mask).toMatchObject({ id: maskId, kind: "mask", parentAssetId: base.id, width: 640 });
    expect(edited.lineage.ancestors.map((a) => a.id)).toEqual([base.id]);
    expect((await detail(base.id)).mask).toBeNull();

    expect((await server.json(`/api/assets/${maskId}`, { method: "DELETE" })).status).toBe(200);
    const later = await detail(made!.id);
    expect(later.mask?.id).toBe(maskId);
    expect(later.mask?.deletedAt).not.toBeNull();
    expect(later.mask?.fileUrl).toBe(`/files/asset/${maskId}?trash=1`);
  });
});

describe("a masked edit's result", () => {
  /**
   * The base's and the result's decoded pixels, compared around the mask's top-left quarter:
   * nothing farther than `reach` (expand plus feather) takes any of the edit.
   */
  async function expectKept(baseId: string, resultId: string, reach = 12) {
    const file = (id: string) => server!.services.ingest.fileOf(getAsset(server!.services.db, id)!.path);
    const kept = await keptOutside(file(baseId), file(resultId), reach);
    expect(kept).toMatchObject({ sameShape: true, outside: 0 });
    expect(kept.inside).toBeGreaterThan(kept.quarter * 0.9);
  }

  /** A masked edit of `base` with the request's own size left open, run to the end. */
  async function editedWith(
    base: { id: string; width: number; height: number },
    overrides: Record<string, unknown> = {},
    composite: Record<string, unknown> = {},
  ) {
    const maskId = await mask(base.id, base.width, base.height);
    const asked = { base: { assetId: base.id, role: "base" }, mask: { assetId: maskId, ...composite } };
    const run = jobSetAcceptedSchema.parse((await edit({ ...asked, ...overrides })).body);
    // Up to 4096 × 4096, decoding and compositing takes several seconds on a CI runner.
    expect((await completed(server!, run.jobSet.id, 45_000)).status).toBe("succeeded");
    const [made] = assetsForJobSets(server!.services.db, [run.jobSet.id]);
    return { maskId, made: made!, request: getJobSet(server!.services.db, run.jobSet.id)!.requestJson };
  }

  test("keeps the original outside the mask, at the base's size", async () => {
    server = await ready();
    const base = await upload(await texture(1920, 1080));
    const maskId = await mask(base.id, 1920, 1080);
    const run = jobSetAcceptedSchema.parse(
      (await edit({ base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } })).body,
    );
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    const [made] = assetsForJobSets(server.services.db, [run.jobSet.id]);
    // The fake draws OpenAI's 1920 × 1088 at most 768 wide; the composite scales it to the base.
    expect(made).toMatchObject({
      kind: "edited",
      width: 1920,
      height: 1080,
      mime: "image/png",
      parentAssetId: base.id,
      maskAssetId: maskId,
      approximate: false,
      approximateReason: null,
      opParams: {
        edit: {
          composite: { applied: true, expandPx: 4, featherPx: 8, resizedFrom: { width: 768, height: 435 } },
        },
      },
    });
    await expectKept(base.id, made!.id);
    // Usage records what the company made, not the composite.
    const usage = server.services.db.$client.query("SELECT size FROM usage_log").get() as { size: string };
    expect(usage.size).toBe("768x435");
  });

  test("on a model without a mask input, edits the whole image and still keeps the rest", async () => {
    server = await ready();
    const base = await upload(await texture(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const run = jobSetAcceptedSchema.parse(
      (
        await edit({
          model: NANO_BANANA,
          op: "edit",
          base: { assetId: base.id, role: "base" },
          mask: { assetId: maskId, featherPx: 0, expandPx: 12 },
        })
      ).body,
    );
    await completed(server, run.jobSet.id);
    const [made] = assetsForJobSets(server.services.db, [run.jobSet.id]);
    expect(made).toMatchObject({
      kind: "edited",
      op: "edit",
      width: 640,
      height: 480,
      approximate: true,
      approximateReason: "whole_image",
      opParams: {
        edit: { composite: { applied: true, expandPx: 12, featherPx: 0 }, fallback: "whole_image" },
      },
    });
    await expectKept(base.id, made!.id);
  });

  test("keeps the original outside the mask at Batch speed too", async () => {
    const clock = { now: Date.now() };
    server = await ready({
      fetch: createFakeFetch({ delayMs: 0, now: () => clock.now }),
      queue: { batchPollMs: 15 },
    });
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "batch" } },
    });
    const base = await upload(await texture(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const run = jobSetAcceptedSchema.parse(
      (
        await edit({
          model: NANO_BANANA,
          op: "edit",
          base: { assetId: base.id, role: "base" },
          mask: { assetId: maskId },
        })
      ).body,
    );
    expect(run.jobSet.speed).toBe("batch");
    await waitFor(() => jobsOf(server!.services.db, run.jobSet.id).every((j) => j.status === "queued"));
    clock.now += 2_000;
    await waitFor(() => jobsOf(server!.services.db, run.jobSet.id).every((j) => j.status === "running"));
    clock.now += 10_000;
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    const [made] = assetsForJobSets(server.services.db, [run.jobSet.id]);
    expect(made).toMatchObject({
      width: 640,
      height: 480,
      approximate: true,
      opParams: { edit: { composite: { applied: true }, fallback: "whole_image" } },
    });
    await expectKept(base.id, made!.id);
  });

  test("keeps the original outside the mask at 3840 × 2160", async () => {
    server = await ready();
    const base = await upload(await texture(3840, 2160));
    const { maskId, made, request } = await editedWith(base);
    // 3840 × 2160 is OpenAI's largest size, so the model is asked for exactly the base's.
    expect(request).toMatchObject({ size: { width: 3840, height: 2160 }, resolution: "4K" });
    expect(made).toMatchObject({
      kind: "edited",
      width: 3840,
      height: 2160,
      parentAssetId: base.id,
      maskAssetId: maskId,
      opParams: { edit: { composite: { applied: true, resizedFrom: { width: 768, height: 432 } } } },
    });
    await expectKept(base.id, made.id);
  }, 60_000);

  test("keeps a JPEG's decoded pixels outside the mask, saved as a PNG", async () => {
    server = await ready();
    const base = await upload(await texture(1920, 1080, { format: "jpeg" }));
    expect(base.mime).toBe("image/jpeg");
    const { made } = await editedWith(base);
    expect(made).toMatchObject({ mime: "image/png", width: 1920, height: 1080 });
    await expectKept(base.id, made.id);
  }, 30_000);

  test("a 4096 × 4096 base on Nano Banana asks for 4K and keeps the rest", async () => {
    server = await ready();
    const base = await upload(await texture(4096, 4096, { cell: 2 }));
    const { made, request } = await editedWith(base, { model: NANO_BANANA, op: "edit" });
    expect(request).toMatchObject({ op: "edit", size: { aspect: "1:1" }, resolution: "4K" });
    expect(made).toMatchObject({
      width: 4096,
      height: 4096,
      approximate: true,
      approximateReason: "whole_image",
      opParams: {
        edit: {
          composite: { applied: true, resizedFrom: { width: 768, height: 768 } },
          fallback: "whole_image",
        },
      },
    });
    await expectKept(base.id, made.id);
  }, 60_000);

  test("a result far smaller than the base is scaled up to it", async () => {
    server = await ready({ fetch: createFakeFetch({ delayMs: 0, maxEdge: 64 }) });
    const base = await upload(await texture(1920, 1080));
    const { made } = await editedWith(base);
    expect(made).toMatchObject({
      width: 1920,
      height: 1080,
      opParams: { edit: { composite: { applied: true, resizedFrom: { width: 64, height: 36 } } } },
    });
    await expectKept(base.id, made.id);
  }, 30_000);

  test("with composite off, the model's own result is stored as it came", async () => {
    server = await ready();
    const base = await upload(await texture(1920, 1080));
    const { maskId, made, request } = await editedWith(base, {}, { composite: false });
    expect(request.mask).toEqual({ assetId: maskId, composite: false, expandPx: 4, featherPx: 8 });
    expect(made).toMatchObject({
      kind: "edited",
      maskAssetId: maskId,
      width: 768,
      height: 435,
      approximate: false,
      opParams: { edit: { composite: { applied: false, reason: "off", expandPx: 4, featherPx: 8 } } },
    });
    expect(editOpParamsSchema.parse(made.opParams?.edit).composite).not.toHaveProperty("resizedFrom");
    const stored = await sharp(server.services.ingest.fileOf(made.path)).metadata();
    expect([stored.width, stored.height]).toEqual([768, 435]);
  });

  test("a cancel that wins while the composite is made leaves no file behind", async () => {
    server = await ready();
    const base = await upload(await texture(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const outcomes = server.services.runner.outcomes;
    const composite = outcomes.composite.bind(outcomes);
    const files: string[] = [];
    outcomes.composite = async (call, staged) => {
      const kept = await composite(call, staged);
      files.push(
        server!.services.ingest.fileOf(staged.path),
        server!.services.ingest.fileOf(kept.staged.path),
      );
      // The person cancels just as the composite is done.
      await server!.request(`/api/job-sets/${call.jobSetId}/cancel`, { method: "POST" });
      return kept;
    };
    const run = jobSetAcceptedSchema.parse(
      (await edit({ base: { assetId: base.id, role: "base" }, mask: { assetId: maskId } })).body,
    );
    expect((await completed(server, run.jobSet.id)).status).toBe("canceled");
    expect(assetsForJobSets(server.services.db, [run.jobSet.id])).toEqual([]);
    expect(files).toHaveLength(2);
    expect(files.filter((f) => existsSync(f))).toEqual([]);
  });

  test("a mask deleted for good mid-run still files the result, and can't be run again", async () => {
    server = await ready();
    const base = await upload(await texture(640, 480));
    const maskId = await mask(base.id, 640, 480);
    const outcomes = server.services.runner.outcomes;
    const composite = outcomes.composite.bind(outcomes);
    outcomes.composite = async (call, staged) => {
      // Emptied from the Trash while the model was at work.
      const purged = await server!.request(`/api/assets/${maskId}?hard=1`, { method: "DELETE" });
      expect(purged.status).toBe(200);
      return composite(call, staged);
    };
    const run = jobSetAcceptedSchema.parse(
      (
        await edit({
          model: NANO_BANANA,
          op: "edit",
          base: { assetId: base.id, role: "base" },
          mask: { assetId: maskId },
        })
      ).body,
    );
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    const [made] = assetsForJobSets(server.services.db, [run.jobSet.id]);
    expect(made).toMatchObject({
      maskAssetId: null,
      opParams: { edit: { composite: { applied: false, reason: "failed" }, fallback: "whole_image" } },
    });
    const usage = server.services.db.$client.query("SELECT count(*) AS n FROM usage_log").get() as {
      n: number;
    };
    expect(usage.n).toBe(1);

    // Recreate would pay a model that never reads the mask for a run that can't keep the rest.
    const again = await server.json(`/api/job-sets/${run.jobSet.id}/recreate`, { method: "POST" });
    expect(again.status).toBe(400);
    expect(errorEnvelopeSchema.parse(again.body).error).toMatchObject({
      field: "mask",
      userMessage: "This mask isn't saved anymore. Paint the area to change again.",
    });
    expect(jobSets()).toBe(1);
  });
});

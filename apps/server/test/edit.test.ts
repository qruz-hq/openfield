import { afterEach, describe, expect, test } from "bun:test";
import {
  type CostEstimate,
  errorEnvelopeSchema,
  jobSetAcceptedSchema,
  newId,
  type UploadResponse,
  uploadResponseSchema,
} from "@openfield/core";
import { getJobSet } from "@openfield/db";
import sharp from "sharp";
import { completed, saveKey, startTestServer, type TestServer } from "./helpers";

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
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) rgba[(y * width + x) * 4 + 3] = 0;
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("mask", new File([png], "mask.png"));
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
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  assetDetailResponseSchema,
  assetsListResponseSchema,
  errorEnvelopeSchema,
  librarySummaryResponseSchema,
  MASK_MAX_PIXELS,
  UPLOAD_MAX_BYTES,
  uploadResponseSchema,
} from "@openfield/core";
import { getAsset } from "@openfield/db";
import sharp from "sharp";
import { image } from "./canvas-helpers";
import { startTestServer, type TestServer } from "./helpers";

// POST /api/masks (§0.9): a mask is saved once, for one image, as a black RGBA PNG at that image's
// exact size, transparent where the edit may change it. It never shows up as an image of its own.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (box: Box, x: number, y: number) =>
  x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;

/** Transparent inside the box, opaque outside, in a colour the mask should ignore. */
async function holeMask(width: number, height: number, box: Box): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba.set([200, 40, 90, inside(box, x, y) ? 0 : 255], i);
    }
  }
  return new Uint8Array(
    await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

/** White inside the box, black outside, no transparency. */
async function whiteOnBlack(width: number, height: number, box: Box, format: "png" | "jpeg" = "png") {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      if (inside(box, x, y)) rgb.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  const made = sharp(rgb, { raw: { width, height, channels: 3 } });
  return new Uint8Array(await (format === "png" ? made.png() : made.jpeg({ quality: 90 })).toBuffer());
}

async function uploadImage(bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new File([bytes], "photo"));
  const res = await server!.request("/api/uploads", { method: "POST", body: form });
  return uploadResponseSchema.parse(await res.json()).asset;
}

function saveMask(bytes: Uint8Array | null, baseAssetId: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  if (bytes) form.append("mask", new File([bytes], "mask.png"));
  form.append("baseAssetId", baseAssetId);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return server!.request("/api/masks", { method: "POST", body: form });
}

/** The saved mask's alpha, one value per pixel, and its PNG colour type. */
async function storedMask(fileUrl: string) {
  const bytes = new Uint8Array(await (await server!.request(fileUrl)).arrayBuffer());
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(info.width * info.height);
  let colour = 0;
  for (let p = 0; p < alpha.length; p++) {
    alpha[p] = data[p * info.channels + info.channels - 1]!;
    for (let c = 0; c < 3; c++) colour = Math.max(colour, data[p * info.channels + c]!);
  }
  return { alpha, width: info.width, channels: info.channels, colour, colourType: bytes[25] };
}

const error = async (res: Response) => errorEnvelopeSchema.parse(await res.json()).error;

const BOX: Box = { x: 100, y: 50, w: 60, h: 40 };

describe("masks", () => {
  test("a painted mask is saved for its image, black, transparent only where it changes", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    const res = await saveMask(await holeMask(300, 200, BOX), base.id);
    expect(res.status).toBe(201);
    const { asset, duplicate } = uploadResponseSchema.parse(await res.json());
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({
      kind: "mask",
      mime: "image/png",
      width: 300,
      height: 200,
      generative: false,
      parentAssetId: base.id,
      rootAssetId: base.rootAssetId,
    });
    expect(getAsset(server.services.db, asset.id)!.path).toMatch(/^uploads\//);

    const stored = await storedMask(asset.fileUrl);
    // RGBA, so every model that takes a mask reads its alpha.
    expect(stored.colourType).toBe(6);
    expect(stored.channels).toBe(4);
    expect(stored.colour).toBe(0);
    for (let p = 0; p < stored.alpha.length; p++) {
      const x = p % stored.width;
      const y = Math.floor(p / stored.width);
      if (stored.alpha[p] !== (inside(BOX, x, y) ? 0 : 255)) throw new Error(`Pixel ${x},${y} is wrong`);
    }
  });

  test("a mask is never an image of its own: not in the library, its counts, or what the image made", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    const { asset } = uploadResponseSchema.parse(
      await (await saveMask(await holeMask(300, 200, BOX), base.id)).json(),
    );
    const list = async (query: string) =>
      assetsListResponseSchema.parse((await server!.json(`/api/assets${query}`)).body).items.map((a) => a.id);
    expect(await list("")).toEqual([base.id]);
    expect(await list("?kind=mask")).toEqual([]);
    expect(await list("?q=mask")).toEqual([]);
    const summary = librarySummaryResponseSchema.parse((await server.json("/api/library/summary")).body);
    expect(summary.counts.all).toBe(1);

    const detail = assetDetailResponseSchema.parse((await server.json(`/api/assets/${base.id}`)).body);
    expect(detail.lineage.children).toEqual([]);
    // Its own detail still answers, with the image it was drawn on.
    const own = assetDetailResponseSchema.parse((await server.json(`/api/assets/${asset.id}`)).body);
    expect(own.lineage.ancestors.map((a) => a.id)).toEqual([base.id]);
  });

  test("an opaque black and white image is read by brightness, white for change", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    const painted = uploadResponseSchema.parse(
      await (await saveMask(await holeMask(300, 200, BOX), base.id)).json(),
    );
    // The same area in black and white saves as the very same mask.
    const res = await saveMask(await whiteOnBlack(300, 200, BOX), base.id);
    expect(res.status).toBe(200);
    expect(uploadResponseSchema.parse(await res.json())).toMatchObject({
      duplicate: true,
      asset: { id: painted.asset.id },
    });

    // A JPEG's soft edges and noise still give a clean mask.
    const fromJpeg = uploadResponseSchema.parse(
      await (await saveMask(await whiteOnBlack(300, 200, BOX, "jpeg"), base.id)).json(),
    );
    const stored = await storedMask(fromJpeg.asset.fileUrl);
    expect(new Set(stored.alpha)).toEqual(new Set([0, 255]));
    expect(stored.alpha[(BOX.y + 20) * 300 + BOX.x + 30]).toBe(0);
    expect(stored.alpha[10 * 300 + 10]).toBe(255);
  });

  test("invert is baked into the saved mask", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    const res = await saveMask(await holeMask(300, 200, BOX), base.id, { invert: "true" });
    expect(res.status).toBe(201);
    const { asset } = uploadResponseSchema.parse(await res.json());
    const stored = await storedMask(asset.fileUrl);
    expect(stored.alpha[(BOX.y + 20) * 300 + BOX.x + 30]).toBe(255);
    expect(stored.alpha[10 * 300 + 10]).toBe(0);
  });

  test("the same mask for another image of the same size is that image's own, sharing the file", async () => {
    server = await startTestServer();
    const first = await uploadImage(await image("png", { width: 300, height: 200, background: "#112233" }));
    const second = await uploadImage(await image("png", { width: 300, height: 200, background: "#445566" }));
    const bytes = await holeMask(300, 200, BOX);
    const a = uploadResponseSchema.parse(await (await saveMask(bytes, first.id)).json());
    const b = uploadResponseSchema.parse(await (await saveMask(bytes, second.id)).json());
    expect(b.asset.id).not.toBe(a.asset.id);
    expect(b.asset.parentAssetId).toBe(second.id);
    const { db } = server.services;
    expect(getAsset(db, b.asset.id)!.path).toBe(getAsset(db, a.asset.id)!.path);
  });

  test("a mask that doesn't fit its image, or marks nothing, is refused with our copy", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));

    const wrongSize = await saveMask(await holeMask(200, 300, BOX), base.id);
    expect(wrongSize.status).toBe(400);
    expect(await error(wrongSize)).toMatchObject({
      code: "bad_request",
      field: "mask",
      userMessage:
        "This mask is 200 × 300 and the image is 300 × 200. Draw the mask over the image itself, then try again.",
    });

    const empty = await saveMask(await holeMask(300, 200, { x: 0, y: 0, w: 0, h: 0 }), base.id);
    expect(empty.status).toBe(400);
    expect(await error(empty)).toMatchObject({
      field: "mask",
      userMessage: "Paint the area to change first.",
    });
    const black = await saveMask(await whiteOnBlack(300, 200, { x: 0, y: 0, w: 0, h: 0 }), base.id);
    expect((await error(black)).field).toBe("mask");

    const text = await saveMask(new TextEncoder().encode("not an image"), base.id);
    expect(text.status).toBe(400);
    expect(await error(text)).toMatchObject({
      field: "mask",
      userMessage: "This mask can't be used. Try a PNG.",
    });

    const missing = await saveMask(null, base.id);
    expect(missing.status).toBe(400);
    expect((await error(missing)).field).toBe("mask");

    const tooBig = await saveMask(new Uint8Array(UPLOAD_MAX_BYTES + 1), base.id);
    expect(tooBig.status).toBe(413);
    expect(await error(tooBig)).toMatchObject({ code: "payload_too_large", field: "mask" });

    const all = await server.json("/api/assets");
    expect(assetsListResponseSchema.parse(all.body).items).toHaveLength(1);
  });

  test("the image must be one in the library, and not a mask itself", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    const bytes = await holeMask(300, 200, BOX);

    const unknown = await saveMask(bytes, "01K6BQ8A1C4D7E9F0000000000");
    expect(unknown.status).toBe(400);
    expect(await error(unknown)).toMatchObject({
      field: "baseAssetId",
      userMessage: "This image isn't in your library anymore.",
    });

    const mask = uploadResponseSchema.parse(await (await saveMask(bytes, base.id)).json()).asset;
    const onMask = await saveMask(bytes, mask.id);
    expect(onMask.status).toBe(400);
    expect(await error(onMask)).toMatchObject({
      field: "baseAssetId",
      userMessage: "Only images can be edited with a mask.",
    });

    const notAnId = await saveMask(bytes, "nope");
    expect((await error(notAnId)).field).toBe("baseAssetId");
  });

  test("a photo saved on its side can't take a mask yet", async () => {
    server = await startTestServer();
    // Stored 300 × 200, shown 200 × 300.
    const sideways = new Uint8Array(
      await sharp({ create: { width: 300, height: 200, channels: 3, background: "#3a6ea5" } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    const base = await uploadImage(sideways);
    const res = await saveMask(await holeMask(300, 200, BOX), base.id);
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({
      field: "baseAssetId",
      userMessage:
        "This photo is saved on its side, so it can't be edited with a mask yet. Save an upright copy, add it to your library and try again.",
    });

    // Turned by its maker's own flag only: an upright JPEG is fine.
    const upright = await uploadImage(
      await image("jpeg", { width: 300, height: 200, background: "#a53a6e" }),
    );
    expect((await saveMask(await holeMask(300, 200, BOX), upright.id)).status).toBe(201);
  });

  test("an image past the masked edit limit can't take a mask", async () => {
    server = await startTestServer();
    const base = await uploadImage(await image("png", { width: 300, height: 200 }));
    // Stands in for a 60 megapixel photo, so the test doesn't have to make one.
    server.services.db.$client.run("UPDATE assets SET width = 10000, height = 6000 WHERE id = ?", [base.id]);
    const res = await saveMask(await holeMask(300, 200, BOX), base.id);
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({
      field: "baseAssetId",
      userMessage:
        "This image is 10,000 × 6,000, too large to edit with a mask. Masked edits take images up to 50 megapixels.",
    });
    expect(MASK_MAX_PIXELS).toBe(50_000_000);
  });
});

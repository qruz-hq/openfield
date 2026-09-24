import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorEnvelopeSchema, UPLOAD_MAX_BYTES, uploadResponseSchema } from "@openfield/core";
import { feedPage, getAsset } from "@openfield/db";
import { canConvertHeic, shrinkPng } from "../src/files/heic";
import { image } from "./canvas-helpers";
import { ORIGIN, startTestServer, type TestServer } from "./helpers";

// POST /api/uploads (M1-07): the type from the bytes, a size limit, dedupe on sha256, the same
// ingest path as provider output, and the same guards as every other route.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function upload(
  bytes: Uint8Array | string,
  name = "photo.png",
  init: { session?: boolean; origin?: string } = {},
) {
  const form = new FormData();
  form.append("file", new File([bytes], name));
  return server!.request("/api/uploads", {
    method: "POST",
    body: form,
    ...(init.session === false && { session: false }),
    ...(init.origin && { headers: { origin: init.origin } }),
  });
}

describe("uploads", () => {
  test("an image lands in uploads/ as its own asset, with a thumbnail", async () => {
    server = await startTestServer();
    const res = await upload(await image("png", { width: 300, height: 200 }));
    expect(res.status).toBe(201);
    const { asset, duplicate } = uploadResponseSchema.parse(await res.json());
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({
      kind: "uploaded",
      mime: "image/png",
      width: 300,
      height: 200,
      generative: false,
    });
    const row = getAsset(server.services.db, asset.id)!;
    expect(row.path).toMatch(/^uploads\/\d{4}\/\d{2}\/\d{2}\/.+\.png$/);
    expect(existsSync(join(server.home, row.path))).toBe(true);
    const thumb = await server.request(asset.thumbUrl);
    expect(thumb.status).toBe(200);
  });

  test("JPEG and WebP are taken; the file name counts for nothing", async () => {
    server = await startTestServer();
    const jpeg = uploadResponseSchema.parse(await (await upload(await image("jpeg"), "x.png")).json());
    expect(jpeg.asset.mime).toBe("image/jpeg");
    const webp = uploadResponseSchema.parse(await (await upload(await image("webp"), "x.jpg")).json());
    expect(webp.asset.mime).toBe("image/webp");
  });

  test("the same bytes twice give back the first image", async () => {
    server = await startTestServer();
    const bytes = await image("png", { background: "#aa3355" });
    const first = uploadResponseSchema.parse(await (await upload(bytes)).json());
    const again = await upload(bytes, "copy.png");
    expect(again.status).toBe(200);
    const second = uploadResponseSchema.parse(await again.json());
    expect(second).toMatchObject({ duplicate: true, asset: { id: first.asset.id } });
  });

  test("bytes matching an image made here come back as an upload of their own, sharing the file", async () => {
    server = await startTestServer();
    const bytes = await image("png", { background: "#3355aa" });
    const first = uploadResponseSchema.parse(await (await upload(bytes)).json());
    const { db } = server.services;
    db.$client.run("UPDATE assets SET kind = 'generated' WHERE id = ?", [first.asset.id]);
    const again = await upload(bytes, "same.png");
    expect(again.status).toBe(200);
    const second = uploadResponseSchema.parse(await again.json());
    expect(second.duplicate).toBe(true);
    expect(second.asset.id).not.toBe(first.asset.id);
    expect(second.asset.kind).toBe("uploaded");
    expect(getAsset(db, second.asset.id)!.path).toBe(getAsset(db, first.asset.id)!.path);
  });

  test("anything that isn't a JPEG, PNG, WebP or HEIC is refused with our copy", async () => {
    server = await startTestServer();
    const res = await upload("just some text", "notes.png");
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await res.json()).error).toMatchObject({
      code: "bad_request",
      field: "file",
      userMessage: "This file can't be used. Try a JPG, PNG, WebP or HEIC image.",
    });

    const empty = await server.request("/api/uploads", { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await empty.json()).error.field).toBe("file");
  });

  test("a damaged HEIC is refused, and blamed on the file only when a converter could have read it", async () => {
    server = await startTestServer();
    // A HEIC header with nothing a decoder could read behind it.
    const heic = new Uint8Array(64);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    const res = await upload(heic, "IMG_0001.HEIC");
    expect(res.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await res.json()).error.userMessage).toBe(
      canConvertHeic()
        ? "This file can't be used. Try a JPG, PNG, WebP or HEIC image."
        : "This computer can't open HEIC files. Save it as JPEG or PNG and try again.",
    );
  });

  test("a PNG past the limit is made smaller until it fits", async () => {
    const noisy = new Uint8Array(300 * 300 * 3).map(() => Math.floor(Math.random() * 256));
    const sharp = (await import("sharp")).default;
    const png = new Uint8Array(
      await sharp(noisy, { raw: { width: 300, height: 300, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const limit = Math.floor(png.byteLength / 3);
    const small = await shrinkPng(png, limit);
    expect(small).not.toBeNull();
    expect(small!.byteLength).toBeLessThanOrEqual(limit);
    const meta = await sharp(small!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBeLessThan(300);
    expect(await shrinkPng(png, png.byteLength)).toBe(png);
  });

  // sips makes a real HEVC-coded HEIC, the kind an iPhone takes; elsewhere there's no way to make one.
  test.skipIf(process.platform !== "darwin")("a real HEIC photo becomes a PNG in the library", async () => {
    server = await startTestServer();
    const dir = mkdtempSync(join(tmpdir(), "openfield-heic-"));
    try {
      writeFileSync(join(dir, "in.png"), await image("png", { width: 40, height: 30 }));
      const made = Bun.spawnSync([
        "/usr/bin/sips",
        "-s",
        "format",
        "heic",
        join(dir, "in.png"),
        "--out",
        join(dir, "in.heic"),
      ]);
      expect(made.exitCode).toBe(0);
      const heic = readFileSync(join(dir, "in.heic"));
      expect(new TextDecoder().decode(heic.subarray(4, 12))).toBe("ftypheic");
      const res = await upload(heic, "IMG_0002.HEIC");
      expect(res.status).toBe(201);
      const { asset } = uploadResponseSchema.parse(await res.json());
      expect(asset).toMatchObject({ mime: "image/png", width: 40, height: 30 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an image cut off after its header, or one that says it has no pixels, is refused", async () => {
    server = await startTestServer();
    const whole = await image("png", { width: 64, height: 64 });
    const cut = whole.subarray(0, 40);
    const zero = new Uint8Array(whole);
    new DataView(zero.buffer).setUint32(16, 0);
    for (const bytes of [cut, zero]) {
      const res = await upload(bytes, "broken.png");
      expect(res.status).toBe(400);
      expect(errorEnvelopeSchema.parse(await res.json()).error.userMessage).toBe(
        "This file can't be used. Try a JPG, PNG, WebP or HEIC image.",
      );
    }
  });

  test("a body past the upload limit still says how big an image can be", async () => {
    server = await startTestServer();
    const res = await upload(new Uint8Array(UPLOAD_MAX_BYTES + 200 * 1024));
    expect(res.status).toBe(413);
    expect(errorEnvelopeSchema.parse(await res.json()).error.userMessage).toBe(
      "This image is over 20 MB. Try a smaller one.",
    );
  });

  test("an image over the limit is refused, and nothing is kept", async () => {
    server = await startTestServer();
    const files = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : []);
    const uploads = join(server.home, "uploads");
    const tmp = server.services.paths.tmp;
    const before = { uploads: files(uploads).length, tmp: files(tmp).length };
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1);
    big.set(await image(), 0);
    const res = await upload(big);
    expect(res.status).toBe(413);
    expect(errorEnvelopeSchema.parse(await res.json()).error).toMatchObject({
      code: "payload_too_large",
      userMessage: "This image is over 20 MB. Try a smaller one.",
    });
    expect(files(uploads).length).toBe(before.uploads);
    expect(files(tmp).length).toBe(before.tmp);
    expect(feedPage(server.services.db, { kind: "uploaded" }).items).toEqual([]);
  });

  test("the guards apply: no session, or another site, is turned away", async () => {
    server = await startTestServer();
    const bytes = await image();
    expect((await upload(bytes, "a.png", { session: false })).status).toBe(403);
    expect((await upload(bytes, "a.png", { origin: "https://example.com" })).status).toBe(403);
    expect((await upload(bytes, "a.png", { origin: ORIGIN })).status).toBe(201);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type StatsResponse, sha256Hex } from "@openfield/core";
import { feedPage, getAsset, insertAsset } from "@openfield/db";
import sharp from "sharp";
import { VIDEO_WITH_SOUND } from "../../../packages/providers/src/byteplus/__fixtures__/media";
import { probeImage } from "../src/files/probe";
import { completed, generate, saveKey, startTestServer, type TestServer } from "./helpers";

// §8.5.1 and §8.5.2: one ingest path, originals untouched, thumbnails from sharp or the originals.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const png = async (width: number, height: number, background = "#3a6ea5") =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer(),
  );

const streamOf = (bytes: Uint8Array, chunk = 1000) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });

describe("ingest of a video", () => {
  const mp4 = new Uint8Array(Buffer.from(VIDEO_WITH_SOUND, "base64"));

  /** The same file with its moov box moved after the media, as some encoders write it. */
  function moovLast(bytes: Uint8Array): Uint8Array {
    const boxes: { type: string; start: number; size: number }[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.length; ) {
      const size = view.getUint32(at);
      boxes.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, size });
      at += size;
    }
    const order = [...boxes.filter((b) => b.type !== "moov"), ...boxes.filter((b) => b.type === "moov")];
    return new Uint8Array(order.flatMap((b) => [...bytes.subarray(b.start, b.start + b.size)]));
  }

  test("a model's MP4 lands as a video with its size, length and sound", async () => {
    server = await startTestServer();
    const staged = await server.services.ingest.stage(streamOf(mp4), { video: true });
    expect(staged.path).toMatch(new RegExp(`^assets/\\d{4}/\\d{2}/\\d{2}/${staged.assetId}\\.mp4$`));
    expect(staged).toMatchObject({
      mime: "video/mp4",
      width: 64,
      height: 36,
      durationMs: 1000,
      hasAudio: true,
    });
    expect(new Uint8Array(readFileSync(join(server.home, staged.path)))).toEqual(mp4);
  });

  test("a moov kept after the media is still read, from the file on disk", async () => {
    server = await startTestServer();
    const staged = await server.services.ingest.stage(streamOf(moovLast(mp4)), { video: true });
    expect(staged).toMatchObject({ mime: "video/mp4", durationMs: 1000 });
  });

  test("a video is never taken where only images belong, such as an upload", async () => {
    server = await startTestServer();
    await expect(server.services.ingest.stage(streamOf(mp4))).rejects.toMatchObject({
      code: "provider_error",
    });
    const form = new FormData();
    form.append("file", new File([mp4], "clip.png"));
    const res = await server.request("/api/uploads", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });
});

describe("ingest", () => {
  test("streams, hashes, probes and places the file under assets/YYYY/MM/DD", async () => {
    server = await startTestServer();
    const image = await png(300, 200);
    const staged = await server.services.ingest.stage(streamOf(image));

    expect(staged.path).toMatch(new RegExp(`^assets/\\d{4}/\\d{2}/\\d{2}/${staged.assetId}\\.png$`));
    expect([staged.mime, staged.width, staged.height, staged.bytes]).toEqual([
      "image/png",
      300,
      200,
      image.byteLength,
    ]);
    expect(staged.sha256).toBe(await sha256Hex(image));
    // Stored exactly as it came: no re-encode.
    expect(new Uint8Array(readFileSync(join(server.home, staged.path)))).toEqual(image);
    expect(readdirSync(join(server.home, "tmp")).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  test("identical bytes already in the library reuse that file", async () => {
    server = await startTestServer();
    const image = await png(64, 64);
    const first = await server.services.ingest.stage(streamOf(image));
    insertAsset(server.services.db, {
      id: first.assetId,
      kind: "uploaded",
      path: first.path,
      mime: first.mime,
      width: first.width,
      height: first.height,
      bytes: first.bytes,
      sha256: first.sha256,
    });
    const second = await server.services.ingest.stage(streamOf(image));
    expect(second.duplicate).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.assetId).not.toBe(first.assetId);
    server.services.ingest.discard(second);
    expect(existsSync(join(server.home, first.path))).toBe(true);
  });

  test("anything that isn't an image is refused and cleaned up", async () => {
    server = await startTestServer();
    const text = new TextEncoder().encode("definitely not a png");
    await expect(server.services.ingest.stage(streamOf(text))).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(readdirSync(join(server.home, "tmp")).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(readdirSync(join(server.home, "assets"))).toEqual([]);
  });

  test("the probe reads PNG, JPEG and WebP headers", async () => {
    expect(probeImage(await png(3, 5))).toEqual({ mime: "image/png", width: 3, height: 5 });
    const base = sharp({ create: { width: 40, height: 30, channels: 3, background: "#123456" } });
    expect(probeImage(await base.clone().jpeg().toBuffer())).toEqual({
      mime: "image/jpeg",
      width: 40,
      height: 30,
    });
    expect(probeImage(await base.clone().webp().toBuffer())).toEqual({
      mime: "image/webp",
      width: 40,
      height: 30,
    });
    expect(probeImage(await base.clone().webp({ lossless: true }).toBuffer())).toEqual({
      mime: "image/webp",
      width: 40,
      height: 30,
    });
  });
});

describe("generate to library", () => {
  test("a run writes the file, the row and the feed thumbnail", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server, { batch: 2 });
    await completed(server, run.jobSet.id);
    await server.services.thumbs.idle();

    const items = feedPage(server.services.db).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      const row = getAsset(server.services.db, item.id)!;
      expect(row).toMatchObject({
        kind: "generated",
        op: "generate",
        jobSetId: run.jobSet.id,
        rootAssetId: row.id,
      });
      expect(existsSync(join(server.home, row.path))).toBe(true);
      expect(existsSync(join(server.home, "thumbs", row.sha256.slice(0, 2), `${row.sha256}@h456.webp`))).toBe(
        true,
      );
    }
    const outputs = server.events.filter((e) => e.event === "job.output");
    expect(outputs).toHaveLength(2);
  });
});

describe("thumbnails", () => {
  test("rounds up to a rung, caps dpr 2 at the original, and makes each file once", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    const asset = feedPage(server.services.db).items[0]!;

    const results = await Promise.all(
      Array.from({ length: 6 }, () => server!.request(`/files/thumb/${asset.id}?h=300&dpr=2`)),
    );
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("etag")).toBe(`"${asset.sha256}@h360@2x"`);
    }
    const meta = await sharp(Buffer.from(await results[0]!.arrayBuffer())).metadata();
    // Rung 360 at dpr 2 wants 720 px; the 768 px fake original allows it.
    expect(meta.height).toBe(Math.min(720, asset.height));
    const dir = join(server.home, "thumbs", asset.sha256.slice(0, 2));
    expect(readdirSync(dir).filter((f) => f.includes("@h360@2x"))).toHaveLength(1);

    const again = await server.request(`/files/thumb/${asset.id}?h=300&dpr=2`, {
      headers: { "if-none-match": `"${asset.sha256}@h360@2x"` },
    });
    expect(again.status).toBe(304);
    expect((await server.request(`/files/thumb/${asset.id}?h=99999`)).status).toBe(400);
  });

  test("without sharp, the original is served uncached and settings says so", async () => {
    server = await startTestServer({ thumbnails: "off" });
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    const asset = feedPage(server.services.db).items[0]!;

    const res = await server.request(`/files/thumb/${asset.id}?h=456`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const original = await server.request(`/files/asset/${asset.id}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
    expect(readdirSync(join(server.home, "thumbs"))).toEqual([]);

    const stats = await server.json<StatsResponse>("/api/stats");
    expect(stats.body.thumbnailEngine).toBe("originals");
    expect(stats.body.assets).toBe(1);
  });

  test("originals support byte ranges", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    const asset = feedPage(server.services.db).items[0]!;
    const res = await server.request(`/files/asset/${asset.id}`, { headers: { range: "bytes=0-7" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-7\/\d+$/);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });
});

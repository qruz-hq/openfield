import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { NormalizedRequest } from "@openfield/core";
import sharp from "sharp";
import { compositeEdit, withProfile } from "../src/files/composite";
import type { StagedFile } from "../src/files/ingest";
import { saveMask } from "../src/files/mask";
import { loadSharp } from "../src/files/sharp";
import { saveUpload } from "../src/files/upload";
import { maskOutcome } from "../src/mcp/runs";
import { startTestServer, type TestServer } from "./helpers";

// The composite (§0.9): a masked edit's result laid over its base so that every pixel farther than
// expandPx + featherPx from the mask's change area decodes exactly as the base's does, whatever the
// base's channels, bit depth or colour profile.

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Straight-line distance from a pixel centre to the nearest pixel centre inside the box. */
function distance(x: number, y: number, b: Box): number {
  const dx = x < b.x ? b.x - x : x >= b.x + b.w ? x - (b.x + b.w - 1) : 0;
  const dy = y < b.y ? b.y - y : y >= b.y + b.h ? y - (b.y + b.h - 1) : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Noise, so a value copied from the wrong place or rounded on the way never matches by luck. */
function noise(
  length: number,
  seed: number,
  deep = false,
): Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> {
  const out = deep ? new Uint16Array(length) : new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    // The high bits, since an LCG's low ones repeat soon. Sixteen levels in 8 bits keep a 4K
    // base under the upload limit.
    out[i] = deep ? s >>> 16 : (s >>> 28) * 17;
  }
  return out;
}

/** A smooth diagonal gradient, standing in for what a model sends back. */
async function gradientPng(width: number, height: number, seed: number): Promise<Uint8Array> {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      rgb[i++] = Math.round(255 * t);
      rgb[i++] = (seed * 40) % 256;
      rgb[i++] = Math.round(255 * (1 - t));
    }
  return new Uint8Array(
    await sharp(rgb, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

/** A transparent hole in an otherwise opaque mask. */
async function holeMask(width: number, height: number, hole: Box): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = x >= hole.x && x < hole.x + hole.w && y >= hole.y && y < hole.y + hole.h;
      rgba[(y * width + x) * 4 + 3] = inside ? 0 : 255;
    }
  return new Uint8Array(
    await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

/** The base saved as an upload, its mask saved for it, and a masked edit's request on them. */
async function masked(
  base: Uint8Array,
  hole: Box,
  mask: Partial<NonNullable<NormalizedRequest["mask"]>> = {},
) {
  const svc = server.services;
  const { asset } = await saveUpload(svc, new Blob([base as Uint8Array<ArrayBuffer>]));
  const maskPng = await holeMask(asset.width, asset.height, hole);
  const saved = await saveMask(svc, new Blob([maskPng as Uint8Array<ArrayBuffer>]), {
    baseAssetId: asset.id,
  });
  const call = (op: "edit" | "inpaint" = "inpaint") =>
    ({
      op,
      jobId: "job",
      prompt: "a red door",
      base: { assetId: asset.id, role: "base" },
      mask: { assetId: saved.asset.id, ...mask },
    }) as unknown as NormalizedRequest;
  return { asset, call };
}

const stage = (png: Uint8Array) =>
  server.services.ingest.stage(new Blob([png as Uint8Array<ArrayBuffer>]).stream());

const fileOf = (staged: StagedFile) => server.services.ingest.fileOf(staged.path);

async function decoded(input: Uint8Array | string, opts: { ignoreIcc?: boolean; deep?: boolean } = {}) {
  let p = sharp(input, { ignoreIcc: opts.ignoreIcc ?? false });
  if (opts.deep) p = p.toColourspace("rgb16");
  const { data, info } = await p
    .raw({ depth: opts.deep ? "ushort" : "uchar" })
    .toBuffer({ resolveWithObject: true });
  const values = opts.deep ? new Uint16Array(new Uint8Array(data).buffer) : new Uint8Array(data);
  return { values, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Every value of every pixel at least `reach` from the hole is the base's, and the hole itself took
 * the edit. Compared as decoded, the way anything that shows the image reads it.
 */
async function expectKept(
  base: Uint8Array,
  out: string,
  hole: Box,
  reach: number,
  opts: { ignoreIcc?: boolean; deep?: boolean } = {},
) {
  const a = await decoded(base, opts);
  const b = await decoded(out, opts);
  expect([b.width, b.height, b.channels]).toEqual([a.width, a.height, a.channels]);
  let far = 0;
  let outside = 0;
  let changed = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const d = distance(x, y, hole);
      const i = (y * a.width + x) * a.channels;
      let same = true;
      for (let c = 0; c < a.channels; c++) if (a.values[i + c] !== b.values[i + c]) same = false;
      if (d >= reach) {
        far++;
        if (!same) outside++;
      } else if (d === 0 && !same) changed++;
    }
  expect(far).toBeGreaterThan(0);
  expect(outside).toBe(0);
  // Noise against a smooth gradient: nearly every pixel in the hole differs.
  expect(changed).toBeGreaterThan(hole.w * hole.h * 0.9);
}

async function rgbNoise(width: number, height: number, format: "png" | "jpeg" = "png") {
  const raw = noise(width * height * 3, width + height);
  const made = sharp(raw, { raw: { width, height, channels: 3 } });
  return new Uint8Array(await (format === "png" ? made.png() : made.jpeg({ quality: 90 })).toBuffer());
}

describe("compositeEdit", () => {
  for (const [width, height, made] of [
    [1920, 1080, [1920, 1088]],
    [3840, 2160, [2048, 1152]],
  ] as const) {
    test(`keeps every pixel of a ${width}×${height} base outside the feathered mask`, async () => {
      const base = await rgbNoise(width, height);
      const hole = { x: Math.round(width * 0.3), y: Math.round(height * 0.4), w: 400, h: 300 };
      const { asset, call } = await masked(base, hole);
      const result = await stage(await gradientPng(made[0], made[1], 7));
      const out = await compositeEdit(server.services, call(), result);

      expect(out?.edit).toEqual({
        composite: {
          applied: true,
          expandPx: 4,
          featherPx: 8,
          resizedFrom: { width: made[0], height: made[1] },
        },
      });
      expect(out!.staged).toMatchObject({ width: asset.width, height: asset.height, mime: "image/png" });
      // The model's own file made way for the composite.
      expect(existsSync(fileOf(result))).toBe(false);
      await expectKept(base, fileOf(out!.staged), hole, 12);
    }, 30_000);
  }

  test("a JPEG base decodes the same outside the mask, in a lossless PNG", async () => {
    const base = await rgbNoise(640, 480, "jpeg");
    const hole = { x: 100, y: 120, w: 200, h: 150 };
    const { call } = await masked(base, hole, { expandPx: 0, featherPx: 2 });
    const out = await compositeEdit(server.services, call(), await stage(await gradientPng(640, 480, 3)));
    expect(out?.edit.composite).toEqual({ applied: true, expandPx: 0, featherPx: 2 });
    expect(out!.staged.mime).toBe("image/png");
    await expectKept(base, fileOf(out!.staged), hole, 2);
  });

  test("keeps the base's colour profile and the values stored under it", async () => {
    const raw = noise(320 * 240 * 3, 9);
    const base = new Uint8Array(
      await sharp(raw, { raw: { width: 320, height: 240, channels: 3 } })
        .withIccProfile("p3")
        .png()
        .toBuffer(),
    );
    const hole = { x: 40, y: 40, w: 100, h: 80 };
    const { call } = await masked(base, hole);
    // Pure sRGB red, which Display P3 stores as a different value.
    const red = new Uint8Array(
      await sharp({ create: { width: 320, height: 240, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    const out = await compositeEdit(server.services, call(), await stage(red));
    const file = fileOf(out!.staged);
    expect((await sharp(file).metadata()).icc).toEqual((await sharp(base).metadata()).icc);
    await expectKept(base, file, hole, 12, { ignoreIcc: true });
    await expectKept(base, file, hole, 12);

    // Inside the hole the result was taken into the profile, so it still shows as the same red.
    const shown = await decoded(file);
    const centre = ((hole.y + 40) * 320 + hole.x + 50) * 3;
    expect(Array.from(shown.values.slice(centre, centre + 3)).map((v) => Math.round(v / 8))).toEqual([
      32, 0, 0,
    ]);
    const stored = await decoded(file, { ignoreIcc: true });
    expect(stored.values[centre + 1]).toBeGreaterThan(0);
  });

  test("keeps grey, transparency and 16 bits as the base has them", async () => {
    const width = 200;
    const height = 150;
    const hole = { x: 50, y: 40, w: 60, h: 50 };
    const cases = [
      { label: "grey", channels: 1, space: "b-w", deep: false },
      { label: "grey and alpha", channels: 2, space: "b-w", deep: false },
      { label: "RGBA", channels: 4, space: "srgb", deep: false },
      { label: "16-bit RGB", channels: 3, space: "rgb16", deep: true },
      { label: "16-bit grey", channels: 1, space: "grey16", deep: true },
    ] as const;
    for (const c of cases) {
      const raw = noise(width * height * c.channels, c.channels * 31, c.deep);
      const base = new Uint8Array(
        await sharp(raw, { raw: { width, height, channels: c.channels } })
          .toColourspace(c.space)
          .png()
          .toBuffer(),
      );
      const before = await sharp(base).metadata();
      const { call } = await masked(base, hole);
      const result = await stage(await gradientPng(256, 192, c.channels));
      const out = await compositeEdit(server.services, call(), result);
      expect({ label: c.label, ...out?.edit.composite }).toMatchObject({ label: c.label, applied: true });
      const file = fileOf(out!.staged);
      const after = await sharp(file).metadata();
      expect({ label: c.label, channels: after.channels, depth: after.depth, space: after.space }).toEqual({
        label: c.label,
        channels: before.channels,
        depth: before.depth,
        space: before.space,
      });
      await expectKept(base, file, hole, 12, { deep: c.deep });
    }
  });

  test("an edit fading out over a cut-out keeps its colour, with no dark edge", async () => {
    // Transparent everywhere with black underneath, as background removal leaves it.
    const base = new Uint8Array(
      await sharp(new Uint8Array(100 * 100 * 4), { raw: { width: 100, height: 100, channels: 4 } })
        .png()
        .toBuffer(),
    );
    const hole = { x: 30, y: 30, w: 20, h: 40 };
    const { call } = await masked(base, hole);
    const red = new Uint8Array(
      await sharp({ create: { width: 100, height: 100, channels: 4, background: "#ff0000ff" } })
        .png()
        .toBuffer(),
    );
    const out = await compositeEdit(server.services, call(), await stage(red));
    expect(out?.edit.composite.applied).toBe(true);
    const { values } = await decoded(fileOf(out!.staged));
    let faded = 0;
    for (let x = 50; x < 70; x++) {
      const i = (50 * 100 + x) * 4;
      const [r, g, b, a] = [...values.subarray(i, i + 4)];
      if (a === 0) continue;
      expect({ x, r, g, b }).toEqual({ x, r: 255, g: 0, b: 0 });
      if (a! < 255) faded++;
    }
    expect(faded).toBeGreaterThan(3);
  });

  test("where a result is see-through over an opaque base, the base shows", async () => {
    const width = 200;
    const height = 100;
    const base = await rgbNoise(width, height);
    const hole = { x: 60, y: 20, w: 80, h: 60 };
    const { call } = await masked(base, hole);
    // Transparent on the left with green hidden under it, opaque red on the right.
    const rgba = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const right = p % width >= 100;
      rgba.set(right ? [255, 0, 0, 255] : [0, 255, 0, 0], p * 4);
    }
    const result = new Uint8Array(
      await sharp(rgba, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
    );
    const out = await compositeEdit(server.services, call(), await stage(result));
    expect(out?.edit.composite.applied).toBe(true);
    const before = await decoded(base);
    const after = await decoded(fileOf(out!.staged));
    expect(after.channels).toBe(3);
    const at = (v: Uint8Array | Uint16Array, x: number, y: number) => {
      const i = (y * width + x) * 3;
      return [...v.subarray(i, i + 3)];
    };
    // Inside the mask: the see-through part kept the base, the opaque part took the edit.
    for (const x of [62, 70, 90]) expect(at(after.values, x, 50)).toEqual(at(before.values, x, 50));
    for (const x of [110, 130, 139]) expect(at(after.values, x, 50)).toEqual([255, 0, 0]);
    await expectKept(base, fileOf(out!.staged), { ...hole, x: 100, w: 40 }, 12);
  });

  test("a CMYK JPEG comes back as RGB that shows the same outside the mask", async () => {
    const raw = noise(320 * 240 * 3, 11);
    const base = new Uint8Array(
      await sharp(raw, { raw: { width: 320, height: 240, channels: 3 } })
        .withIccProfile("cmyk")
        .jpeg()
        .toBuffer(),
    );
    expect((await sharp(base).metadata()).space).toBe("cmyk");
    const hole = { x: 60, y: 50, w: 80, h: 60 };
    const { call } = await masked(base, hole);
    const out = await compositeEdit(server.services, call(), await stage(await gradientPng(320, 240, 6)));
    const meta = await sharp(fileOf(out!.staged)).metadata();
    expect([meta.space, meta.channels, meta.icc]).toEqual(["srgb", 3, undefined]);
    await expectKept(base, fileOf(out!.staged), hole, 12);
  });

  test("records a whole-image edit, and changes nothing when the request turns it off", async () => {
    const base = await rgbNoise(320, 240);
    const hole = { x: 10, y: 10, w: 50, h: 50 };
    const fallback = await masked(base, hole);
    const out = await compositeEdit(
      server.services,
      fallback.call("edit"),
      await stage(await gradientPng(320, 240, 1)),
    );
    expect(out?.edit).toEqual({
      composite: { applied: true, expandPx: 4, featherPx: 8 },
      fallback: "whole_image",
    });

    const off = await masked(base, hole, { composite: false, expandPx: 2, featherPx: 0 });
    const result = await stage(await gradientPng(256, 192, 2));
    const kept = await compositeEdit(server.services, off.call(), result);
    expect(kept).toEqual({
      staged: result,
      edit: { composite: { applied: false, expandPx: 2, featherPx: 0, reason: "off" } },
    });
    expect(existsSync(fileOf(result))).toBe(true);
  });

  test("keeps the model's result as it came when the base can't be read", async () => {
    const base = await rgbNoise(320, 240);
    const { call } = await masked(base, { x: 10, y: 10, w: 50, h: 50 });
    const request = call();
    const result = await stage(await gradientPng(320, 240, 5));
    // A base that's no longer in the library at all, not even the Trash.
    const gone = {
      ...request,
      base: { assetId: "01JAAAAAAAAAAAAAAAAAAAAAAA", role: "base" },
    } as NormalizedRequest;
    const out = await compositeEdit(server.services, gone, result);
    expect(out).toEqual({
      staged: result,
      edit: { composite: { applied: false, expandPx: 4, featherPx: 8, reason: "failed" } },
    });
    expect(existsSync(fileOf(result))).toBe(true);
  });

  test("a model's file that won't delete doesn't stop the composite", async () => {
    const base = await rgbNoise(320, 240);
    const hole = { x: 10, y: 10, w: 50, h: 50 };
    const { call } = await masked(base, hole);
    const ingest = server.services.ingest;
    // As Windows refuses to delete a file something still has open.
    const stuck = new Proxy(ingest, {
      get(target, key) {
        if (key === "discard")
          return () => {
            throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await stage(await gradientPng(320, 240, 8));
    const out = await compositeEdit({ ...server.services, ingest: stuck }, call(), result);
    expect(out?.edit.composite.applied).toBe(true);
    expect(out!.staged.path).not.toBe(result.path);
    await expectKept(base, fileOf(out!.staged), hole, 12);
    // And sharp holds no file open once it has read it, so discarding usually works there too.
    expect((await loadSharp()).cache().files.max).toBe(0);
  });

  test("when sharp can't load, keeps the model's result and never says the rest was kept", async () => {
    const base = await rgbNoise(320, 240);
    const { call } = await masked(base, { x: 10, y: 10, w: 50, h: 50 });
    const result = await stage(await gradientPng(256, 192, 9));
    const noSharp = { ...server.services, loadSharp: () => Promise.reject(new Error("no sharp here")) };
    // Nano Banana's whole-image edit: the case where keeping the rest matters most.
    const out = await compositeEdit(noSharp, call("edit"), result);
    expect(out).toEqual({
      staged: result,
      edit: {
        composite: { applied: false, expandPx: 4, featherPx: 8, reason: "unavailable" },
        fallback: "whole_image",
      },
    });
    expect(existsSync(fileOf(result))).toBe(true);
    expect(maskOutcome({ opParams: { edit: out!.edit } })).toEqual({
      keptOutsideMask: false,
      why: "Openfield can't open images on this computer, so this is the model's whole result.",
    });
  });

  test("a base saved on its side is never laid over, and says why", async () => {
    // Refused before any run; this covers one that got past, e.g. a base swapped mid-run.
    const svc = server.services;
    const upright = await saveUpload(svc, new Blob([await rgbNoise(320, 240, "jpeg")]));
    const { asset: sideways } = await saveUpload(
      svc,
      new Blob([
        await sharp(await rgbNoise(320, 240, "jpeg"))
          .withMetadata({ orientation: 6 })
          .jpeg()
          .toBuffer(),
      ]),
    );
    const saved = await saveMask(
      svc,
      new Blob([(await holeMask(320, 240, { x: 10, y: 10, w: 50, h: 50 })) as Uint8Array<ArrayBuffer>]),
      { baseAssetId: upright.asset.id },
    );
    const call = {
      op: "inpaint",
      jobId: "job",
      prompt: "a red door",
      base: { assetId: sideways.id, role: "base" },
      mask: { assetId: saved.asset.id },
    } as unknown as NormalizedRequest;
    const result = await stage(await gradientPng(320, 240, 10));
    const out = await compositeEdit(svc, call, result);
    expect(out).toEqual({
      staged: result,
      edit: { composite: { applied: false, expandPx: 4, featherPx: 8, reason: "turned" } },
    });
    expect(maskOutcome({ opParams: { edit: out!.edit } })).toEqual({
      keptOutsideMask: false,
      why: "The image is saved on its side, so this is the model's whole result.",
    });
  });

  test("leaves anything but a masked image edit alone", async () => {
    const result = await stage(await gradientPng(64, 64, 4));
    const plain = {
      op: "edit",
      base: { assetId: "01JAAAAAAAAAAAAAAAAAAAAAAA", role: "base" },
    } as NormalizedRequest;
    expect(await compositeEdit(server.services, plain, result)).toBeUndefined();
    const made = { op: "generate", prompt: "a red door" } as NormalizedRequest;
    expect(await compositeEdit(server.services, made, result)).toBeUndefined();
  });
});

describe("withProfile", () => {
  test("tags a PNG with a profile and leaves its pixel values alone", async () => {
    const raw = noise(32 * 16 * 3, 5) as Uint8Array<ArrayBuffer>;
    const png = new Uint8Array(
      await sharp(raw, { raw: { width: 32, height: 16, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const p3 = await sharp(raw, { raw: { width: 32, height: 16, channels: 3 } })
      .withIccProfile("p3")
      .png()
      .toBuffer();
    const icc = (await sharp(p3).metadata()).icc!;
    const tagged = withProfile(png, icc);
    expect((await sharp(tagged).metadata()).icc).toEqual(icc);
    expect(new Uint8Array(await sharp(tagged, { ignoreIcc: true }).raw().toBuffer())).toEqual(raw);
    // Tagging twice replaces the profile rather than adding a second one.
    const twice = withProfile(tagged, icc);
    expect(twice.length).toBe(tagged.length);
  });
});

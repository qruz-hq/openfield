import { rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import {
  blendPixels,
  compositeSettingsOf,
  type EditOpParams,
  isEmptyMask,
  type NormalizedRequest,
  UPLOAD_MAX_BYTES,
  weightsFromAlpha,
} from "@openfield/core";
import { type Db, getAsset } from "@openfield/db";
import type { Logger } from "../log/logger";
import type { Ingest, StagedFile } from "./ingest";
import { loadSharp, type Sharp } from "./sharp";

// A masked edit keeps the original outside its mask (§0.9). The model's result is scaled to the
// base's exact size and laid over the base through the mask, grown by expandPx and softened over
// featherPx; past that edge every value is copied from the base as it's stored. The composite
// keeps the base's channels, bit depth and colour profile and is saved as a PNG, so those pixels
// decode exactly as the base's do.

export interface CompositeDeps {
  db: Db;
  ingest: Ingest;
  logger: Logger;
  /** files/sharp.ts unless given, so tests can stand in a computer where sharp won't load. */
  loadSharp?: () => Promise<Sharp>;
}

export interface CompositeOutcome {
  /** What to file: the composite, or the model's own result when there's none. */
  staged: StagedFile;
  edit: EditOpParams;
}

type Skip = NonNullable<EditOpParams["composite"]["reason"]>;

/**
 * Lays a masked edit's result over its base. Undefined for anything but a masked image edit. When
 * it makes a composite it discards the result's own file, so `staged` is the caller's no longer.
 * Never throws: a composite that can't be made leaves the result as it came, and the record says
 * the original wasn't put back.
 */
export async function compositeEdit(
  deps: CompositeDeps,
  call: NormalizedRequest,
  staged: StagedFile,
): Promise<CompositeOutcome | undefined> {
  const { base, mask } = call;
  if (!base || !mask || (call.op !== "edit" && call.op !== "inpaint") || !staged.mime.startsWith("image/"))
    return undefined;
  const { composite, expandPx, featherPx } = compositeSettingsOf(mask);
  const record = (applied: boolean, extra: Partial<EditOpParams["composite"]> = {}): EditOpParams => ({
    composite: { applied, expandPx, featherPx, ...extra },
    // A mask on an edit (not an inpaint) means the model can't take one and changed it all.
    ...(call.op === "edit" && { fallback: "whole_image" as const }),
  });
  const skip = (reason: Skip): CompositeOutcome => ({ staged, edit: record(false, { reason }) });
  if (!composite) return skip("off");

  let sharp: Sharp;
  try {
    sharp = await (deps.loadSharp ?? loadSharp)();
  } catch {
    return skip("unavailable");
  }

  const { db, ingest, logger } = deps;
  const failed = (err: unknown) => {
    logger.warn("Couldn't put the original back outside the mask, so the whole edit is kept", {
      jobId: call.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return skip("failed");
  };
  let made: Composite | "turned";
  try {
    // The Trash keeps files where they are, so a base or mask trashed mid-run still reads.
    const baseRow = getAsset(db, base.assetId, { includeDeleted: true });
    const maskRow = getAsset(db, mask.assetId, { includeDeleted: true });
    if (!baseRow || !maskRow) throw new Error("The base or its mask is gone");
    made = await compositeFiles(
      sharp,
      ingest,
      {
        base: ingest.fileOf(baseRow.path),
        mask: ingest.fileOf(maskRow.path),
        result: ingest.fileOf(staged.path),
      },
      { expandPx, featherPx },
    );
  } catch (err) {
    return failed(err);
  }
  // Refused before the run; this only guards a base turned some other way.
  if (made === "turned") return skip("turned");

  let kept: StagedFile;
  try {
    kept = await ingest.stage(new Blob([made.png]).stream());
  } catch (err) {
    return failed(err);
  }
  if (kept.bytes > UPLOAD_MAX_BYTES) {
    logger.info("The edited image is larger than some models take, so they'll refuse it as an input", {
      jobId: call.jobId,
      bytes: kept.bytes,
    });
  }
  try {
    ingest.discard(staged);
  } catch (err) {
    // A file that won't delete (Windows holds files a reader still has open) is a leftover, not
    // a failed run: the composite is made and the job still has to land.
    logger.warn("Couldn't delete the model's own file after the composite", {
      jobId: call.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { staged: kept, edit: record(true, made.resizedFrom && { resizedFrom: made.resizedFrom }) };
}

interface Composite {
  png: Uint8Array<ArrayBuffer>;
  resizedFrom?: { width: number; height: number };
}

/** How the base's pixels are laid out, so the composite matches it. */
interface Layout {
  grey: boolean;
  alpha: boolean;
  /** 16 bits per value. */
  deep: boolean;
}

type Values = Uint8Array | Uint16Array;
type Pipeline = ReturnType<Sharp>;

async function compositeFiles(
  sharp: Sharp,
  ingest: Ingest,
  files: { base: string; mask: string; result: string },
  opts: { expandPx: number; featherPx: number },
): Promise<Composite | "turned"> {
  const meta = await sharp(files.base).metadata();
  if (meta.orientation !== undefined && meta.orientation >= 2 && meta.orientation <= 8) return "turned";
  const { width, height } = meta;
  // A CMYK JPEG has no RGB values to copy, so it's read the usual way, converted to sRGB, and the
  // composite carries no profile. Anything else is read as stored, its profile ignored, and the
  // composite gets that same profile back.
  const cmyk = meta.space === "cmyk";
  const layout: Layout = {
    grey: !cmyk && meta.channels <= 2,
    alpha: meta.hasAlpha,
    deep: meta.depth === "ushort",
  };
  const icc = cmyk ? undefined : meta.icc;

  const alpha = await maskAlpha(sharp, files.mask, width, height);
  if (isEmptyMask(alpha)) throw new Error("The mask marks nothing to change");
  const weights = weightsFromAlpha(alpha, width, height, opts);

  const base = await pixels(
    sharp(files.base, { ignoreIcc: !cmyk, failOn: "truncated" }),
    layout,
    width,
    height,
  );
  const resultMeta = await sharp(files.result).metadata();
  const shown = resultMeta.autoOrient;
  // An opaque base keeps its channels, so a see-through result can't stay see-through: where the
  // result is transparent the base shows instead of whatever colour hides under the transparency.
  const seeThrough = !layout.alpha && resultMeta.hasAlpha;
  const read = seeThrough ? { ...layout, alpha: true } : layout;
  let result = await resultPixels(sharp, ingest, files.result, read, width, height, icc);
  if (seeThrough) result = foldAlpha(result, weights, layout);
  const channels = (layout.grey ? 1 : 3) + (layout.alpha ? 1 : 0);
  const blended = blendPixels(base, result, weights, channels, { alpha: layout.alpha });

  const space = layout.grey ? (layout.deep ? "grey16" : "b-w") : layout.deep ? "rgb16" : "srgb";
  const png = new Uint8Array(
    await sharp(blended, { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } })
      .toColourspace(space)
      // Filtered at full effort: a 4K composite is often half the size, and a smaller file can go
      // back to more models as a base or a reference.
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer(),
  );
  const resized = shown.width !== width || shown.height !== height;
  return {
    png: icc ? withProfile(png, icc) : png,
    ...(resized && { resizedFrom: { width: shown.width, height: shown.height } }),
  };
}

/** One alpha value per pixel. */
async function maskAlpha(sharp: Sharp, file: string, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(file, { failOn: "truncated" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4)
    throw new Error(`The mask is ${info.width}×${info.height}, the image ${width}×${height}`);
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = data[p * 4 + 3]!;
  return alpha;
}

/**
 * The result as displayed, stretched to the base's size and taken into the base's profile, so its
 * colours mean the same as the base's values around it. A profile that can't be used that way
 * leaves the result in sRGB.
 */
async function resultPixels(
  sharp: Sharp,
  ingest: Ingest,
  file: string,
  layout: Layout,
  width: number,
  height: number,
  icc: Buffer | undefined,
): Promise<Values> {
  const read = (profile?: string) => {
    let p = sharp(file, { failOn: "truncated" })
      .autoOrient()
      .resize(width, height, { fit: "fill", kernel: "lanczos3" });
    if (profile) p = p.withIccProfile(profile);
    return pixels(p, layout, width, height);
  };
  // A grey profile can't take colour.
  if (icc && !layout.grey) {
    const profile = ingest.tmpPath("icc");
    try {
      writeFileSync(profile, icc);
      return await read(profile);
    } catch {
      // Read again below, without the profile.
    } finally {
      rmSync(profile, { force: true });
    }
  }
  return read();
}

/**
 * Raw values in the base's layout. Everything is read as colour first, since sharp hands a grey
 * image back as three equal values, and a grey layout then keeps their luma (Rec. 709 weights,
 * which sum to one, so a grey base's values come back exactly) and the alpha.
 */
async function pixels(pipeline: Pipeline, layout: Layout, width: number, height: number): Promise<Values> {
  const shaped = (layout.alpha ? pipeline.ensureAlpha() : pipeline.removeAlpha())
    .toColourspace(layout.deep ? "rgb16" : "srgb")
    .raw({ depth: layout.deep ? "ushort" : "uchar" });
  const { data, info } = await shaped.toBuffer({ resolveWithObject: true });
  const stride = layout.alpha ? 4 : 3;
  if (info.width !== width || info.height !== height || info.channels !== stride)
    throw new Error(
      `Expected ${width}×${height}×${stride}, got ${info.width}×${info.height}×${info.channels}`,
    );
  // A Uint16Array needs an even offset, which a pooled Buffer doesn't promise.
  const bytes = data.byteOffset % 2 ? new Uint8Array(data) : data;
  const values: Values = layout.deep
    ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!layout.grey) return values;
  const channels = layout.alpha ? 2 : 1;
  const grey = layout.deep
    ? new Uint16Array(width * height * channels)
    : new Uint8Array(width * height * channels);
  for (let p = 0, i = 0; p < width * height; p++, i += stride) {
    grey[p * channels] = Math.round(
      (2126 * values[i]! + 7152 * values[i + 1]! + 722 * values[i + 2]!) / 10_000,
    );
    if (layout.alpha) grey[p * channels + 1] = values[i + 3]!;
  }
  return grey;
}

/**
 * A result read with alpha, its alpha taken into `weights` (in place) and dropped, so it fits an
 * opaque base's layout. A weight only ever shrinks, so a pixel that kept the base still does.
 */
function foldAlpha(values: Values, weights: Uint8Array, layout: Layout): Values {
  const colours = layout.grey ? 1 : 3;
  const stride = colours + 1;
  const max = layout.deep ? 65_535 : 255;
  const out = layout.deep
    ? new Uint16Array(weights.length * colours)
    : new Uint8Array(weights.length * colours);
  for (let p = 0, i = 0, o = 0; p < weights.length; p++, i += stride, o += colours) {
    for (let c = 0; c < colours; c++) out[o + c] = values[i + c]!;
    const w = weights[p]!;
    if (w) weights[p] = Math.round((w * values[i + colours]!) / max);
  }
  return out;
}

/** Colour chunks a PNG may carry that would contradict an embedded profile. */
const COLOUR_CHUNKS = new Set(["iCCP", "sRGB", "cICP"]);

/**
 * `png` tagged with `icc` as its colour profile, its pixel values untouched: an iCCP chunk right
 * after the header, in place of any colour chunk it had. sharp would convert the values to attach
 * a profile, which is the one thing a composite can't have.
 */
export function withProfile(png: Uint8Array, icc: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // The profile's name ("icc"), its terminator, compression method 0, then the zlib stream.
  const packed = deflateSync(icc);
  const data = new Uint8Array(5 + packed.length);
  data.set([0x69, 0x63, 0x63, 0, 0]);
  data.set(packed, 5);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= png.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const end = pos + 12 + length;
    if (!COLOUR_CHUNKS.has(type)) parts.push(png.subarray(pos, end));
    if (type === "IHDR") parts.push(chunk("iCCP", data));
    pos = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

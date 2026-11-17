import { rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import {
  alignResult,
  analyzeKeepRest,
  blendPixels,
  compositeSettingsOf,
  decideKeepRest,
  type EditOpParams,
  fixesFromRgba,
  isEmptyMask,
  type KeepRestAnalysis,
  type KeepRestMode,
  type KeepRestRecord,
  type Mark,
  marksArea,
  maskOnlyWeights,
  type NormalizedRequest,
  type PixelImage,
  shareOfModel,
  UPLOAD_MAX_BYTES,
} from "@openfield/core";
import { type Db, getAsset } from "@openfield/db";
import type { Logger } from "../log/logger";
import type { Ingest, StagedFile } from "./ingest";
import { loadSharp, type Sharp } from "./sharp";

// A masked edit keeps the original outside its mask (§0.9). The model's result is scaled to the
// base's exact size, lined up with it, compared with it, and laid over it where it really changed:
// from the mask, grown by expandPx, into changes that spill out of it and clear changes anywhere
// (core keep-rest.ts), softened over featherPx. Past that every value is copied from the base as
// it's stored. When the comparison can't be trusted the mask alone decides, as it always did. The
// composite keeps the base's channels, bit depth and colour profile and is saved as a PNG, so those
// pixels decode exactly as the server decodes the base. For a JPEG or lossy WebP base that's
// libvips's decode: other decoders (the macOS webview's ImageIO, say) read the same JPEG a few
// values apart, so anything comparing before and after should compare against the server's decode.
//
// The model's own result is kept too, hidden with the edit (assets.result_path), so the same can be
// done again later with other settings for free (services/keep-rest.ts), and so it can be saved as
// an image of its own. Sketch & point edits without a mask keep it too: the area their marks cover
// can be put back later.

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
  /**
   * The model's own result, to keep hidden with the edit. The same file as `staged` when no
   * composite was made. The caller owns both: discard each (once) if the edit isn't filed.
   */
  result: StagedFile;
}

type Skip = NonNullable<EditOpParams["composite"]["reason"]>;

/** The settings a kept version is made with. */
export interface KeepSettings {
  mode: KeepRestMode;
  expandPx: number;
  featherPx: number;
  sensitivity: number;
}

/**
 * The files a kept version is made from, absolute. `area` is a mask file, marks on the base, or the
 * whole picture (the model's own result, with only the fix layer putting the original back).
 */
export interface KeepFiles {
  base: string;
  result: string;
  area: { mask: string } | { marks: readonly Mark[] } | { everywhere: true };
  /** A fix layer: an RGBA PNG at the base's size (core fixesFromRgba). */
  fixes?: Uint8Array;
}

/** What deciding the area found, for the record. */
export type Decided = Pick<KeepRestRecord, "lineUp" | "fellBack" | "changed">;

/**
 * Lays a masked edit's result over its base. Undefined for anything but an image edit with a mask
 * or marks. Never throws: a composite that can't be made leaves the result as it came, and the
 * record says the original wasn't put back.
 */
export async function compositeEdit(
  deps: CompositeDeps,
  call: NormalizedRequest,
  staged: StagedFile,
): Promise<CompositeOutcome | undefined> {
  const { base, mask } = call;
  // Only marks on the image being edited (1) say where it changes; others are on references.
  const onBase = call.marks?.filter((m) => (m.image ?? 1) === 1);
  const marks = onBase?.length ? onBase : undefined;
  if (
    !base ||
    (!mask && !marks) ||
    (call.op !== "edit" && call.op !== "inpaint") ||
    !staged.mime.startsWith("image/")
  )
    return undefined;
  const { composite, expandPx, featherPx, sensitivity } = compositeSettingsOf(mask, {
    marks: Boolean(marks),
  });
  const keepRest = (decided: Decided = {}): KeepRestRecord => ({
    mode: "smart",
    sensitivity,
    start: marks ? "marks" : "mask",
    ...decided,
    revision: 0,
    stored: true,
  });
  const record = (
    applied: boolean,
    extra: Partial<EditOpParams["composite"]> = {},
    decided?: Decided,
  ): EditOpParams => ({
    composite: { applied, expandPx, featherPx, ...extra },
    // A mask on an edit (not an inpaint) means the model can't take one and changed it all.
    ...(mask && call.op === "edit" && { fallback: "whole_image" as const }),
    keepRest: keepRest(decided),
  });
  const skip = (reason: Skip): CompositeOutcome => ({
    staged,
    result: staged,
    edit: record(false, { reason }),
  });
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
  let made: Kept | "turned";
  try {
    // The Trash keeps files where they are, so a base or mask trashed mid-run still reads.
    const baseRow = getAsset(db, base.assetId, { includeDeleted: true });
    const maskRow = mask && getAsset(db, mask.assetId, { includeDeleted: true });
    if (!baseRow || (mask && !maskRow)) throw new Error("The base or its mask is gone");
    made = await keptVersion(
      sharp,
      ingest,
      {
        base: ingest.fileOf(baseRow.path),
        result: ingest.fileOf(staged.path),
        area: maskRow ? { mask: ingest.fileOf(maskRow.path) } : { marks: marks! },
      },
      { mode: "smart", expandPx, featherPx, sensitivity },
      logger,
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
  return {
    staged: kept,
    result: staged,
    edit: record(true, made.resizedFrom && { resizedFrom: made.resizedFrom }, made.decided),
  };
}

export interface Kept {
  png: Uint8Array<ArrayBuffer>;
  resizedFrom?: { width: number; height: number };
  decided: Decided;
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

/** Everything a kept version is made from, read in the base's layout. */
interface Read {
  width: number;
  height: number;
  layout: Layout;
  icc: Buffer | undefined;
  /** The mask's alpha (0 changes), or the area the marks cover. */
  area: Uint8Array;
  base: Values;
  /** The result at the base's size, in the base's layout, plus alpha when it's see-through. */
  result: Values;
  seeThrough: boolean;
  resizedFrom?: { width: number; height: number };
  fixes?: Uint8Array;
}

async function readAll(sharp: Sharp, ingest: Ingest, files: KeepFiles): Promise<Read | "turned"> {
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

  const area =
    "mask" in files.area
      ? await maskAlpha(sharp, files.area.mask, width, height)
      : "marks" in files.area
        ? marksAlpha(files.area.marks, width, height)
        : new Uint8Array(width * height);
  if (isEmptyMask(area)) throw new Error("The mask marks nothing to change");

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
  const result = await resultPixels(
    sharp,
    ingest,
    files.result,
    seeThrough ? { ...layout, alpha: true } : layout,
    width,
    height,
    icc,
  );
  const resized = shown.width !== width || shown.height !== height;
  return {
    width,
    height,
    layout,
    icc,
    area,
    base,
    result,
    seeThrough,
    ...(resized && { resizedFrom: { width: shown.width, height: shown.height } }),
    ...(files.fixes && { fixes: await fixesAlpha(sharp, files.fixes, width, height) }),
  };
}

/**
 * The last few analyses, by a key the caller makes from what they read (the original's hash, the
 * stored result and the area), so dragging a slider decides again without comparing again.
 */
export class AnalysisCache {
  readonly #entries = new Map<string, KeepRestAnalysis>();
  constructor(private readonly size = 4) {}

  get(key: string): KeepRestAnalysis | undefined {
    const hit = this.#entries.get(key);
    if (hit) {
      this.#entries.delete(key);
      this.#entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, analysis: KeepRestAnalysis): void {
    this.#entries.delete(key);
    this.#entries.set(key, analysis);
    while (this.#entries.size > this.size) this.#entries.delete(this.#entries.keys().next().value!);
  }
}

/** Where a kept version may find, and leave, its analysis. */
export interface Cached {
  cache: AnalysisCache;
  key: string;
}

/** The weights for these settings, and the result moved by the line-up where they take it. */
function decide(
  read: Read,
  settings: KeepSettings,
  logger?: Logger,
  cached?: Cached,
): { weights: Uint8Array; moved: Values; decided: Decided } {
  const { width, height, layout, area, fixes } = read;
  const colours = layout.grey ? 1 : 3;
  const image = (data: Values, alpha: boolean): PixelImage<Values> => ({
    data,
    width,
    height,
    channels: (colours + (alpha ? 1 : 0)) as PixelImage["channels"],
  });
  const resultImage = image(read.result, layout.alpha || read.seeThrough);
  const maskOnly = (fellBack?: Decided["fellBack"]) => {
    const weights = maskOnlyWeights(area, width, height, settings, fixes);
    return {
      weights,
      moved: read.result,
      decided: { ...(fellBack && { fellBack }), changed: shareOfModel(weights) },
    };
  };
  if (settings.mode === "mask") return maskOnly();
  try {
    const analysis =
      cached?.cache.get(cached.key) ??
      analyzeKeepRest(image(read.base, layout.alpha), resultImage, area, {
        ...(read.resizedFrom && { sentSize: read.resizedFrom }),
      });
    cached?.cache.set(cached.key, analysis);
    const decision = decideKeepRest(analysis, area, settings, fixes);
    const lineUp = roundLineUp(analysis.lineUp);
    // A fallback reads the result where it lies: a line-up that failed is no line-up at all.
    const moved = decision.fallback
      ? read.result
      : alignResult(resultImage, analysis.lineUp, decision.weights);
    return {
      weights: decision.weights,
      moved,
      decided: {
        lineUp,
        ...(decision.fallback && { fellBack: decision.fallback }),
        changed: round(decision.changed, 4),
      },
    };
  } catch (err) {
    logger?.warn("Couldn't compare the edit with the original, so the mask alone decides", {
      error: err instanceof Error ? err.message : String(err),
    });
    return maskOnly("failed");
  }
}

/**
 * The kept version of an edit for these settings, as the PNG to file. "turned" for a base stored
 * on its side. Throws when a file can't be read.
 */
export async function keptVersion(
  sharp: Sharp,
  ingest: Ingest,
  files: KeepFiles,
  settings: KeepSettings,
  logger?: Logger,
  cached?: Cached,
): Promise<Kept | "turned"> {
  const read = await readAll(sharp, ingest, files);
  if (read === "turned") return "turned";
  const { width, height, layout, icc } = read;
  const { weights, moved, decided } = decide(read, settings, logger, cached);
  const result = read.seeThrough ? foldAlpha(moved, weights, layout) : moved;
  const channels = (layout.grey ? 1 : 3) + (layout.alpha ? 1 : 0);
  const blended = blendPixels(read.base, result, weights, channels, { alpha: layout.alpha });
  const png = await encode(sharp, blended, width, height, channels, layout, icc);
  return { png, decided, ...(read.resizedFrom && { resizedFrom: read.resizedFrom }) };
}

/**
 * The decided area for these settings at the base's size, as a grey PNG: white takes the model,
 * black keeps the original, grey along the feather. For the Difference view.
 */
export async function areaMap(
  sharp: Sharp,
  ingest: Ingest,
  files: KeepFiles,
  settings: KeepSettings,
  logger?: Logger,
  cached?: Cached,
): Promise<{ png: Uint8Array<ArrayBuffer>; decided: Decided } | "turned"> {
  const read = await readAll(sharp, ingest, files);
  if (read === "turned") return "turned";
  const { weights, decided } = decide(read, settings, logger, cached);
  const png = await sharp(weights, { raw: { width: read.width, height: read.height, channels: 1 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return { png: new Uint8Array(png), decided };
}

/**
 * The model's result as the server blends it: upright, stretched to the base's size, in the base's
 * layout and profile, lossless. The browser's live preview reads these exact values.
 */
export async function fittedResult(
  sharp: Sharp,
  ingest: Ingest,
  files: Pick<KeepFiles, "base" | "result">,
): Promise<Uint8Array<ArrayBuffer>> {
  const meta = await sharp(files.base).metadata();
  const cmyk = meta.space === "cmyk";
  const resultMeta = await sharp(files.result).metadata();
  const layout: Layout = {
    grey: !cmyk && meta.channels <= 2,
    alpha: meta.hasAlpha || resultMeta.hasAlpha,
    deep: meta.depth === "ushort",
  };
  const icc = cmyk ? undefined : meta.icc;
  const values = await resultPixels(sharp, ingest, files.result, layout, meta.width, meta.height, icc);
  const channels = (layout.grey ? 1 : 3) + (layout.alpha ? 1 : 0);
  return encode(sharp, values, meta.width, meta.height, channels, layout, icc);
}

async function encode(
  sharp: Sharp,
  values: Values,
  width: number,
  height: number,
  channels: number,
  layout: Layout,
  icc: Buffer | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const space = layout.grey ? (layout.deep ? "grey16" : "b-w") : layout.deep ? "rgb16" : "srgb";
  const png = new Uint8Array(
    await sharp(values, { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } })
      .toColourspace(space)
      // Filtered at full effort: a 4K composite is often half the size, and a smaller file can go
      // back to more models as a base or a reference.
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer(),
  );
  return icc ? withProfile(png, icc) : png;
}

/** Alpha for the area marks cover on the base, as a mask's: 0 where they reach. */
function marksAlpha(marks: readonly Mark[], width: number, height: number): Uint8Array {
  const area = marksArea(marks, width, height);
  for (let i = 0; i < area.length; i++) area[i] = area[i] ? 0 : 255;
  return area;
}

/** A fix layer's values, from its PNG, which must be the base's size. */
async function fixesAlpha(sharp: Sharp, png: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(png, { failOn: "truncated" })
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4)
    throw new Error(`The fixes are ${info.width}×${info.height}, the image ${width}×${height}`);
  return fixesFromRgba(data);
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

const roundLineUp = (l: { dx: number; dy: number; scaleX: number; scaleY: number; confidence: number }) => ({
  dx: round(l.dx, 3),
  dy: round(l.dy, 3),
  scaleX: round(l.scaleX, 5),
  scaleY: round(l.scaleY, 5),
  confidence: round(l.confidence, 3),
});

/** One alpha value per pixel, read on its own so the mask never sits in memory four times over. */
async function maskAlpha(sharp: Sharp, file: string, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(file, { failOn: "truncated" })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 1)
    throw new Error(`The mask is ${info.width}×${info.height}, the image ${width}×${height}`);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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

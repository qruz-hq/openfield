import {
  errorCopy,
  formatBytes,
  invertAlpha,
  isEmptyMask,
  luminanceToAlpha,
  MASK_CHANGE_BELOW,
  MASK_MAX_BYTES,
  MASK_MAX_PIXELS,
  t,
  UPLOAD_MAX_BYTES,
  type UploadResponse,
} from "@openfield/core";
import { type AssetRow, type Db, findLiveMask, getAsset, insertAsset } from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import { ApiFailure } from "../http/errors";
import { toAsset } from "../mappers/asset";
import type { Ingest, StagedFile } from "./ingest";
import { probeImage } from "./probe";
import { loadSharp, type Sharp } from "./sharp";

// Masks (§0.9): the part of an image an edit may change, saved once as a mask asset and sent by
// id. Whatever comes in, a PNG with transparency or an opaque black and white image read by
// brightness (white changes), is saved the one way models and the composite read it: a black
// RGBA PNG at the image's exact size, transparent where it changes and opaque where it keeps.
// Inverting happens here, so nothing later ever flips a mask.

export interface MaskDeps {
  db: Db;
  ingest: Ingest;
}

export interface SaveMaskOptions {
  /** The image the mask was drawn on. The mask must be its exact pixel size. */
  baseAssetId: string;
  /** Swap the areas to change and keep before saving. */
  invert?: boolean;
}

const badMask = (message: string, userMessage: string) =>
  new ApiFailure(400, "bad_request", message, { field: "mask", userMessage });

const unsupported = (message: string) => badMask(message, t("masks.unsupported"));

const tooLarge = (message: string, limit: number) =>
  new ApiFailure(413, "payload_too_large", message, {
    field: "mask",
    userMessage: t("errors.maskTooLarge", { size: formatBytes(limit) }),
  });

/**
 * Saves a mask for an image: from the editor (POST /api/masks), an agent's file, or an image wired
 * into a mask input. The same mask saved again for the same image comes back as the first one.
 */
export async function saveMask(deps: MaskDeps, file: Blob, opts: SaveMaskOptions): Promise<UploadResponse> {
  const { db, ingest } = deps;
  const base = editableImage(db, opts.baseAssetId, "baseAssetId");
  requireMaskableSize(base, "baseAssetId");
  if (file.size > UPLOAD_MAX_BYTES) throw tooLarge(`The file is ${file.size} bytes`, UPLOAD_MAX_BYTES);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const probed = probeImage(bytes);
  // HEIC carries no size in its header, and nobody paints a mask in one.
  if (!probed || probed.mime === "image/heic") throw unsupported("Not a PNG, JPEG or WebP image");
  requireSameSize(probed, base);

  let sharp: Sharp;
  try {
    sharp = await loadSharp();
  } catch {
    throw new ApiFailure(500, "internal", "sharp can't load on this computer", {
      userMessage: t("masks.cantOpen"),
    });
  }
  if (await isTurned(sharp, ingest.fileOf(base.path))) throw turned("baseAssetId");

  let alpha = await alphaOf(sharp, bytes, base.width, base.height);
  if (!alpha) throw unsupported("The mask can't be read to the end");
  if (opts.invert) alpha = invertAlpha(alpha);
  // Every pixel either changes or keeps, so the model and the composite agree on the area.
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i]! < MASK_CHANGE_BELOW ? 0 : 255;
  if (isEmptyMask(alpha)) throw badMask("The mask marks nothing to change", t("errors.maskMissing"));

  const png = await encodeMask(sharp, alpha, base.width, base.height);
  if (png.byteLength >= MASK_MAX_BYTES) throw tooLarge(`The mask is ${png.byteLength} bytes`, MASK_MAX_BYTES);

  let staged: StagedFile;
  try {
    staged = await ingest.stage(new Blob([png as Uint8Array<ArrayBuffer>]).stream(), {
      folder: "uploads",
      maxBytes: MASK_MAX_BYTES,
    });
  } catch (err) {
    if (isProviderError(err) && err.code === "disk_full") {
      throw new ApiFailure(507, "disk_full", err.message, { userMessage: errorCopy("disk_full").reason });
    }
    throw err;
  }
  if (staged.duplicate) {
    const existing = findLiveMask(db, staged.sha256, base.id);
    if (existing) return { asset: toAsset(existing, false, false), duplicate: true };
  }
  // Drawn on the image, so it hangs off it in the lineage. The library, the feed and the image's
  // own list of what was made from it all leave masks out.
  const row = insertAsset(db, {
    id: staged.assetId,
    kind: "mask",
    path: staged.path,
    mime: staged.mime,
    width: staged.width,
    height: staged.height,
    bytes: staged.bytes,
    sha256: staged.sha256,
    generative: false,
    parentAssetId: base.id,
    rootAssetId: base.rootAssetId,
  });
  return { asset: toAsset(row, false, false), duplicate: staged.duplicate };
}

/** A live image that can be edited with a mask, or a refusal naming `field`. */
export function editableImage(db: Db, id: string, field: string): AssetRow {
  const row = getAsset(db, id);
  if (!row) {
    throw new ApiFailure(400, "bad_request", `No image ${id}`, { field, userMessage: t("masks.imageGone") });
  }
  if (row.modality !== "image" || row.kind === "mask") {
    throw new ApiFailure(400, "bad_request", `${id} is a ${row.kind} ${row.modality}`, {
      field,
      userMessage: t("masks.notImage"),
    });
  }
  return row;
}

/** An image small enough for its composite to be made without running out of memory. */
export function requireMaskableSize(base: AssetRow, field: string): void {
  if (base.width * base.height <= MASK_MAX_PIXELS) return;
  throw new ApiFailure(400, "bad_request", `${base.width}×${base.height} is past ${MASK_MAX_PIXELS} pixels`, {
    field,
    userMessage: t("masks.tooManyPixels", {
      width: base.width,
      height: base.height,
      megapixels: MASK_MAX_PIXELS / 1_000_000,
    }),
  });
}

/** A mask must cover its image pixel for pixel. */
export function requireSameSize(mask: { width: number; height: number }, base: AssetRow): void {
  if (mask.width === base.width && mask.height === base.height) return;
  throw badMask(
    `The mask is ${mask.width}×${mask.height}, the image ${base.width}×${base.height}`,
    t("masks.wrongSize", {
      maskWidth: mask.width,
      maskHeight: mask.height,
      width: base.width,
      height: base.height,
    }),
  );
}

/**
 * Refuses an image shown turned or mirrored (EXIF orientation 2 to 8), as phones save photos:
 * what people see isn't how its pixels are stored, so a mask drawn over it wouldn't line up. When
 * sharp can't load here nothing could have saved a mask anyway, so there's nothing to check.
 */
export async function requireUpright(ingest: Ingest, base: AssetRow, field: string): Promise<void> {
  let sharp: Sharp;
  try {
    sharp = await loadSharp();
  } catch {
    return;
  }
  if (await isTurned(sharp, ingest.fileOf(base.path))) throw turned(field);
}

const turned = (field: string) =>
  new ApiFailure(400, "bad_request", "The image is stored turned (EXIF orientation 2 to 8)", {
    field,
    userMessage: t("masks.turned"),
  });

async function isTurned(sharp: Sharp, file: string): Promise<boolean> {
  try {
    const { orientation } = await sharp(file).metadata();
    return orientation !== undefined && orientation >= 2 && orientation <= 8;
  } catch {
    // An image sharp can't read has no orientation to go wrong; the edit itself reports the file.
    return false;
  }
}

/**
 * One alpha value per pixel. A mask with any transparency says what to change with it; a fully
 * opaque one by brightness. Null when the image can't be decoded to the end.
 */
async function alphaOf(sharp: Sharp, bytes: Uint8Array, width: number, height: number) {
  let decoded: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    // Stored pixels, never turned: a mask lines up with how its image's pixels are stored.
    decoded = await sharp(bytes, { failOn: "truncated", limitInputPixels: width * height })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const { data, info } = decoded;
  const channels = info.channels as 1 | 2 | 3 | 4;
  if (info.width !== width || info.height !== height || channels < 1 || channels > 4) return null;
  if (channels === 2 || channels === 4) {
    const alpha = new Uint8Array(width * height);
    let opaque = true;
    for (let p = 0, i = channels - 1; p < alpha.length; p++, i += channels) {
      alpha[p] = data[i]!;
      if (data[i] !== 255) opaque = false;
    }
    if (!opaque) return alpha;
  }
  return luminanceToAlpha(data, channels);
}

/** The canonical mask: black, with the alpha alone saying what changes, squeezed as small as PNG goes. */
async function encodeMask(sharp: Sharp, alpha: Uint8Array, width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < alpha.length; p++) rgba[p * 4 + 3] = alpha[p]!;
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(png);
}

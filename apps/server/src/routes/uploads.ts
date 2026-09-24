import { zValidator } from "@hono/zod-validator";
import {
  errorCopy,
  formatBytes,
  THUMB_RUNGS,
  t,
  UPLOAD_MAX_BYTES,
  type UploadResponse,
} from "@openfield/core";
import { findLiveAssetBySha256, getAsset, insertAsset, isFavourite } from "@openfield/db";
import { isProviderError } from "@openfield/providers/server";
import { Hono } from "hono";
import type SharpModule from "sharp";
import { z } from "zod";
import type { Env, Services } from "../context";
import { heicToPng, shrinkPng } from "../files/heic";
import { probeImage } from "../files/probe";
import { Thumbs } from "../files/thumbs";
import { ApiFailure, onInvalid } from "../http/errors";
import { toAsset } from "../mappers/asset";

// POST /api/uploads (M1-07, §8.3): one reference image per request, multipart field "file".
// The type comes from the bytes, never the name, and the whole image is read once before it's
// kept, so a cut-off file never reaches the library or a model. HEIC becomes PNG here and only
// here (§8.5.1), made smaller when its PNG would pass the limit, so what's kept is what any model
// takes. Identical bytes already uploaded come back as that image.

/** Refused before decoding: bigger than any model takes, and a decompression bomb's favourite. */
const MAX_PIXELS = 16_384 * 16_384;

// Server-only, so core stays free of the File global.
const uploadFormSchema = z.object({
  file: z.instanceof(File, { error: () => t("uploads.noFile") }),
});

export const uploadsRoutes = new Hono<Env>().post(
  "/uploads",
  zValidator("form", uploadFormSchema, onInvalid),
  async (c) => {
    const result = await saveUpload(c.var.svc, c.req.valid("form").file);
    if (result.duplicate) return c.json(result satisfies UploadResponse, 200);
    return c.json(result satisfies UploadResponse, 201);
  },
);

const unsupported = (message: string) =>
  new ApiFailure(400, "bad_request", message, { field: "file", userMessage: t("uploads.unsupported") });

const tooLarge = (message: string) =>
  new ApiFailure(413, "payload_too_large", message, {
    field: "file",
    userMessage: t("uploads.tooLarge", { size: formatBytes(UPLOAD_MAX_BYTES) }),
  });

/**
 * Reads the whole image once. False when it can't be read (cut off, corrupt). Null when sharp
 * won't load on this computer, so only the header could be checked.
 */
async function decodes(bytes: Uint8Array): Promise<boolean | null> {
  let sharp: typeof SharpModule;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }
  try {
    await sharp(bytes, { failOn: "truncated", limitInputPixels: MAX_PIXELS })
      .resize(8, 8, { fit: "inside" })
      .raw()
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}

async function saveUpload(svc: Services, file: File): Promise<UploadResponse> {
  if (file.size > UPLOAD_MAX_BYTES) throw tooLarge(`The file is ${file.size} bytes`);
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  const probed = probeImage(bytes);
  if (!probed) throw unsupported("Not a JPEG, PNG, WebP or HEIC image");
  const heic = probed.mime === "image/heic";
  if (heic) {
    const converted = await heicToPng(bytes, svc.paths.tmp);
    if (!converted.ok && converted.reason === "no_converter") {
      throw new ApiFailure(400, "bad_request", "Nothing on this computer can read HEIC", {
        field: "file",
        userMessage: t("uploads.heic"),
      });
    }
    if (!converted.ok) throw unsupported("The HEIC converter couldn't read this file");
    const fitted = await shrinkPng(converted.png, UPLOAD_MAX_BYTES);
    if (!fitted) {
      throw new ApiFailure(413, "payload_too_large", "The converted PNG is over the limit", {
        field: "file",
        userMessage: t("uploads.heicTooLarge"),
      });
    }
    bytes = fitted;
  } else if (!probed.width || !probed.height) {
    throw unsupported("The image says it has no pixels");
  }
  if ((await decodes(bytes)) === false) throw unsupported("The image can't be read to the end");

  let staged: Awaited<ReturnType<Services["ingest"]["stage"]>>;
  try {
    staged = await svc.ingest.stage(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), {
      folder: "uploads",
      maxBytes: UPLOAD_MAX_BYTES,
    });
  } catch (err) {
    // Ingest speaks in model errors; an upload has its own words for them.
    if (!isProviderError(err)) throw err;
    if (err.code === "payload_too_large") throw tooLarge(err.message);
    if (err.code === "disk_full") {
      throw new ApiFailure(507, "disk_full", err.message, { userMessage: errorCopy("disk_full").reason });
    }
    throw unsupported(err.message);
  }
  const { db } = svc;
  if (staged.duplicate) {
    // The same photo uploaded again is that upload. The same bytes as an image made here (or a
    // mask) get an uploaded row of their own against the shared file (§8.5.1 step 3), so the
    // reply is always kind 'uploaded' (§8.3).
    const existing = findLiveAssetBySha256(db, staged.sha256, "uploaded");
    if (existing) return { asset: toAsset(existing, isFavourite(db, existing.id)), duplicate: true };
  }
  const row = insertAsset(db, {
    id: staged.assetId,
    kind: "uploaded",
    path: staged.path,
    mime: staged.mime,
    width: staged.width,
    height: staged.height,
    bytes: staged.bytes,
    sha256: staged.sha256,
    generative: false,
  });
  const rung = THUMB_RUNGS[svc.settings.get().feedZoom] ?? 456;
  svc.thumbs.warm(row, Thumbs.sizeFor({ h: rung }));
  return { asset: toAsset(getAsset(db, row.id) ?? row, false), duplicate: staged.duplicate };
}

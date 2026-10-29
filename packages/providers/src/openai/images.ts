import { formatBytes, type ModelManifest, type NormalizedRequest, t } from "@openfield/core";
import { type CallContext, ProviderError, type StoredAsset } from "../types";
import { MASK_MAX_BYTES } from "./capabilities";

// The images an edit sends: the base first (the mask applies to it), then the references, read
// from the asset store and checked against the manifest. Masks need no conversion: OpenAI edits
// where the mask is fully transparent, which is Openfield's own rule (alpha 0 = change, §0.9).

export interface EditInputs {
  images: StoredAsset[];
  mask?: StoredAsset;
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export const fileNameOf = (asset: StoredAsset, name: string) =>
  `${name}.${EXTENSIONS[asset.mimeType] ?? "png"}`;

export async function editInputs(
  manifest: ModelManifest,
  req: NormalizedRequest,
  ctx: CallContext,
): Promise<EditInputs> {
  const refs = manifest.capabilities.references;
  const needsBase = req.op === "edit" || req.op === "inpaint";
  if (needsBase && !req.base) {
    throw new ProviderError("invalid_request", {
      field: "base",
      message: "An edit needs an image to start from",
    });
  }
  const ids = [
    ...(needsBase && req.base ? [req.base.assetId] : []),
    ...(req.references ?? []).map((r) => r.assetId),
  ];
  const images: StoredAsset[] = [];
  for (const id of ids) {
    const asset = await read(ctx, id, "references");
    if (!refs.mimeTypes.includes(asset.mimeType)) {
      throw new ProviderError("invalid_request", {
        field: "references",
        message: `${manifest.displayName} can't read ${asset.mimeType} images`,
      });
    }
    if (asset.bytes.byteLength > refs.maxBytes) {
      throw new ProviderError("payload_too_large", {
        field: "references",
        message: `Reference ${id} is ${asset.bytes.byteLength} bytes`,
        userMessage: t("errors.referenceTooLarge", { size: formatBytes(refs.maxBytes) }),
      });
    }
    images.push(asset);
  }

  if (req.op !== "inpaint" || !req.mask) return { images };
  const mask = await read(ctx, req.mask.assetId, "mask");
  const base = images[0];
  // OpenAI wants a PNG with an alpha channel, under 4MB, the same size as the image it edits.
  if (mask.mimeType !== "image/png") {
    throw new ProviderError("invalid_request", { field: "mask", message: "The mask must be a PNG" });
  }
  if (!pngHasAlpha(mask.bytes)) {
    throw new ProviderError("invalid_request", {
      field: "mask",
      message: "The mask has no alpha channel",
      userMessage: t("errors.maskNoAlpha"),
    });
  }
  if (mask.bytes.byteLength >= MASK_MAX_BYTES) {
    throw new ProviderError("payload_too_large", {
      field: "mask",
      message: `The mask is ${mask.bytes.byteLength} bytes`,
      userMessage: t("errors.maskTooLarge", { size: formatBytes(MASK_MAX_BYTES) }),
    });
  }
  if (base && (mask.width !== base.width || mask.height !== base.height)) {
    throw new ProviderError("invalid_request", {
      field: "mask",
      message: `The mask is ${mask.width}×${mask.height}, the image ${base.width}×${base.height}`,
    });
  }
  return { images, mask };
}

/**
 * Whether a PNG carries transparency: a colour type with alpha (grey or RGB plus alpha), or a
 * tRNS chunk, which has to come before the image data.
 */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  for (let pos = 8; pos + 8 <= bytes.byteLength; ) {
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    pos += 12 + view.getUint32(pos);
  }
  return false;
}

async function read(ctx: CallContext, id: string, field: string): Promise<StoredAsset> {
  return ctx.assets.read(id).catch((err: unknown) => {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("invalid_request", { field, message: `Couldn't read asset ${id}`, cause: err });
  });
}

/** A data URL, for the JSON form of /v1/images/edits that a batch line needs. */
export const dataUrlOf = (asset: StoredAsset) =>
  `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;

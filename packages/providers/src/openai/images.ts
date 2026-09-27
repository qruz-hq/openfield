import { formatBytes, type ModelManifest, type NormalizedRequest, t } from "@openfield/core";
import { type CallContext, ProviderError, type StoredAsset } from "../types";

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
  // OpenAI wants a PNG with an alpha channel, the same size as the image it edits.
  if (mask.mimeType !== "image/png") {
    throw new ProviderError("invalid_request", { field: "mask", message: "The mask must be a PNG" });
  }
  if (base && (mask.width !== base.width || mask.height !== base.height)) {
    throw new ProviderError("invalid_request", {
      field: "mask",
      message: `The mask is ${mask.width}×${mask.height}, the image ${base.width}×${base.height}`,
    });
  }
  return { images, mask };
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

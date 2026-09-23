import { formatBytes, type ModelManifest, type NormalizedRequest, t } from "@openfield/core";
import { type CallContext, ProviderError } from "../types";
import type { InlineImage } from "./map-request";

/** The edit base first, then references, read from the asset store and checked against the manifest. */
export async function inlineImages(
  manifest: ModelManifest,
  req: NormalizedRequest,
  ctx: CallContext,
): Promise<InlineImage[]> {
  const refs = manifest.capabilities.references;
  const ids = [
    ...(req.op === "edit" && req.base ? [req.base.assetId] : []),
    ...(req.references ?? []).map((r) => r.assetId),
  ];
  if (req.op === "edit" && !req.base) {
    throw new ProviderError("invalid_request", {
      field: "base",
      message: "An edit needs an image to start from",
    });
  }

  const images: InlineImage[] = [];
  for (const id of ids) {
    const asset = await ctx.assets.read(id).catch((err: unknown) => {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("invalid_request", {
        field: "references",
        message: `Couldn't read asset ${id}`,
        cause: err,
      });
    });
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
    images.push({ mimeType: asset.mimeType, data: Buffer.from(asset.bytes).toString("base64") });
  }
  return images;
}

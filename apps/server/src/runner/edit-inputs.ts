import {
  adapterOpFor,
  type GenerateRequest,
  type ModelManifest,
  type Op,
  type PixelSize,
  type ReferenceInput,
  type ResolutionTier,
  type SizeSpec,
  t,
} from "@openfield/core";
import { type AssetRow, type Db, getAsset, getAssets } from "@openfield/db";
import { editSizeFor } from "@openfield/providers/manifest";
import { editableImage, type MaskDeps, requireSameSize, requireUpright } from "../files/mask";
import { ApiFailure } from "../http/errors";

// The images an edit sends in, checked when the run is asked for, before anything is spent
// (§0.9), and what's priced and asked of the model from their sizes. The runner and the estimate
// route share these, so a price shown before an edit is the price the run records.

/**
 * An edit's base, checked: a live image, never a video or a mask. With a mask, the mask must be a
 * saved one the base's exact size, and the base must be stored upright. Throws an ApiFailure that
 * names the field. Undefined when the request isn't an edit or has no base (normalize says so).
 */
export async function checkEditInputs(
  deps: MaskDeps,
  req: Pick<GenerateRequest, "op" | "base" | "mask">,
): Promise<AssetRow | undefined> {
  if (req.op === "generate" || !req.base) return undefined;
  const base = editableImage(deps.db, req.base.assetId, "base");
  if (!req.mask) return base;
  const id = req.mask.assetId;
  const mask = getAsset(deps.db, id);
  if (!mask) {
    throw new ApiFailure(400, "bad_request", `No mask ${id}`, {
      field: "mask",
      userMessage: t("masks.maskGone"),
    });
  }
  if (mask.kind !== "mask") {
    throw new ApiFailure(400, "bad_request", `${id} is a ${mask.kind} image, not a saved mask`, {
      field: "mask",
      userMessage: t("masks.notMask"),
    });
  }
  requireSameSize(mask, base);
  await requireUpright(deps.ingest, base, "base");
  return base;
}

interface Sizable {
  op: Op;
  size?: SizeSpec;
  resolution?: ResolutionTier;
  mask?: unknown;
}

/**
 * An edit that leaves its size open (none, or "auto") asks for the base's own, or the nearest the
 * model takes, so the result lines up with the base and its mask. Its tier follows unless the
 * request names one. A size the request chose stays, and so does everything outside edits.
 */
export function withEditSize<T extends Sizable>(manifest: ModelManifest, req: T, base?: PixelSize): T {
  if (!base || (req.size && req.size.kind !== "auto")) return req;
  const op = adapterOpFor(req.op, {
    hasMask: Boolean(req.mask),
    canInpaint: manifest.capabilities.ops.inpaint,
  });
  if (op !== "edit" && op !== "inpaint") return req;
  const fit = editSizeFor(manifest, base);
  return {
    ...req,
    size: fit.size,
    ...(!req.resolution && fit.resolution && { resolution: fit.resolution }),
  };
}

/**
 * Pixel sizes of the images a request sends in, its base and then its references, for pricing.
 * Undefined when any of them isn't in the library, so they're priced as any size could be.
 */
export function inputImageSizes(
  db: Db,
  req: { base?: Pick<ReferenceInput, "assetId">; references?: Pick<ReferenceInput, "assetId">[] },
): PixelSize[] | undefined {
  const ids = [...(req.base ? [req.base.assetId] : []), ...(req.references ?? []).map((r) => r.assetId)];
  const sizes = new Map(getAssets(db, ids).map((a) => [a.id, { width: a.width, height: a.height }]));
  const known = ids.flatMap((id) => sizes.get(id) ?? []);
  return known.length === ids.length ? known : undefined;
}

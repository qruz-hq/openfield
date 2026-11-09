import {
  formatBytes,
  type JobHandle,
  type ModelManifest,
  type NormalizedRequest,
  pngHasAlpha,
  t,
} from "@openfield/core";
import {
  type CallContext,
  errorFromFetchFailure,
  type ImageModel,
  type JobResult,
  type JobUpdate,
  ProviderError,
  redactError,
  type StoredAsset,
} from "../types";
import { mapError } from "./errors";
import { byteplusFetch } from "./http";
import { promptWithMarks } from "./marks";
import { IMAGES_URL, INPUT_MAX_PIXELS, MAX_RATIO, type SeedreamSpec } from "./seedream";
import { type SeedreamBody, toLayersBody, toSeedreamBody } from "./seedream-request";
import { asLayerFailure, type SeedreamResponse, toSeedreamResult } from "./seedream-response";

// Seedream's /images/generations answers in one blocking call with the images inline, and keeps no
// id to read them by later, so nothing here resumes after a restart: a call cut off can only run
// again. submit() makes the call and returns a handle that already holds the result.

export function bindSeedream(manifest: ModelManifest, spec: SeedreamSpec): ImageModel {
  return {
    ...manifest,

    async submit(req, ctx): Promise<JobHandle> {
      if (req.op !== "generate" && req.op !== "edit" && !(req.op === "decompose" && spec.layers)) {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op} through Openfield`,
        });
      }
      if (ctx.speed === "batch" || ctx.speed === "flex") {
        throw new ProviderError("unsupported_param", {
          field: "speed",
          message: "Seedream runs at Standard or Fast",
        });
      }
      if (ctx.signal.aborted) throw errorFromFetchFailure(ctx.signal.reason, ctx.signal);
      const submittedAt = ctx.now();
      const body =
        req.op === "decompose"
          ? toLayersBody(spec, req, dataUrlOf(await layerInput(manifest, req, ctx)))
          : await imageBody(spec, manifest, req, ctx);
      ctx.log.debug("BytePlus image request", {
        model: spec.modelId,
        size: body.size,
        images: Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0,
        fields: Object.keys(body).filter((k) => k !== "image" && k !== "prompt"),
      });
      const { res, body: answer } = await byteplusFetch(ctx, IMAGES_URL, { method: "POST", body });
      if (!res.ok) {
        const err = await mapError(res, answer, manifest.displayName);
        throw redactError(req.op === "decompose" ? asLayerFailure(err, manifest.displayName) : err, ctx.log);
      }
      const result = await toSeedreamResult((answer ?? {}) as SeedreamResponse, req, ctx, {
        submittedAt,
        price: manifest.price,
        speed: ctx.speed,
        model: manifest.displayName,
        inputsSent: Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0,
        format: body.output_format ?? "jpeg",
      });
      ctx.log.info("BytePlus images saved", {
        model: spec.modelId,
        images: result.images.length,
        failed: result.failures?.length ?? 0,
        ms: result.timings.completedAt - submittedAt,
      });
      return { jobId: req.jobId, resume: { result }, attempt: 0 };
    },

    async poll(handle: JobHandle): Promise<JobUpdate> {
      const result = handle.resume?.result as JobResult | undefined;
      if (result && Array.isArray(result.images)) return { state: "succeeded", result };
      return {
        state: "failed",
        error: new ProviderError("provider_error", { message: "This run has no result to resume" }),
      };
    },
  };
}

/** A generation or an edit: the images it sends, read and checked, with any marks drawn on. */
async function imageBody(
  spec: SeedreamSpec,
  manifest: ModelManifest,
  req: NormalizedRequest,
  ctx: CallContext,
): Promise<SeedreamBody> {
  if (req.op === "edit" && !req.base) {
    throw new ProviderError("invalid_request", {
      field: "base",
      message: "An edit needs an image to start from",
    });
  }
  const ids = [
    ...(req.op === "edit" && req.base ? [req.base.assetId] : []),
    ...(req.references ?? []).map((r) => r.assetId),
  ];
  if (ids.length > spec.maxInputs) {
    throw new ProviderError("invalid_request", {
      field: "references",
      message: `${ids.length} images, ${manifest.displayName} takes ${spec.maxInputs}`,
      userMessage: t("composer.referenceLimit", { model: manifest.displayName, max: spec.maxInputs }),
    });
  }
  const assets: StoredAsset[] = [];
  for (const id of ids) assets.push(checkInput(manifest, await read(ctx, id, "references"), "references"));

  // Shapes that have no tag are drawn onto the image they're on, for this call only.
  const { drawings } = promptWithMarks("", req.marks);
  for (const [image, shapes] of drawings) {
    const at = image - 1;
    if (!assets[at]) continue;
    if (!ctx.assets.drawMarks) {
      throw new ProviderError("provider_error", {
        field: "marks",
        message: "Marks can't be drawn in this context",
      });
    }
    assets[at] = await ctx.assets.drawMarks(assets[at]!.assetId, shapes);
  }

  let transparent = false;
  if (req.background === "transparent" && spec.transparency) {
    // Only an edit of exactly one PNG that has transparency can come out transparent.
    const only = assets.length === 1 ? assets[0] : undefined;
    if (only?.mimeType !== "image/png" || !pngHasAlpha(only.bytes)) {
      throw new ProviderError("invalid_request", {
        field: "background",
        message: "A transparent background needs exactly one PNG input with alpha",
        userMessage: t("errors.transparentInput"),
      });
    }
    transparent = true;
  }
  return toSeedreamBody(
    spec,
    req,
    { images: assets.map(dataUrlOf), transparent },
    { fast: ctx.speed === "priority" },
  );
}

/** A separation's one image: a PNG or JPEG of at least 512×512 pixels in all, within 1:16. */
async function layerInput(
  manifest: ModelManifest,
  req: NormalizedRequest,
  ctx: CallContext,
): Promise<StoredAsset> {
  if (!req.base) {
    throw new ProviderError("invalid_request", { field: "base", message: "A separation needs an image" });
  }
  const rules = manifest.capabilities.layers!;
  const asset = await read(ctx, req.base.assetId, "base");
  const pixels = asset.width * asset.height;
  if (!rules.mimeTypes.includes(asset.mimeType) || pixels < rules.minPixels || pixels > rules.maxPixels) {
    throw new ProviderError("invalid_request", {
      field: "base",
      message: `A ${asset.mimeType} of ${asset.width}×${asset.height} can't be separated`,
      userMessage: t("errors.layerImage"),
    });
  }
  if (
    Math.max(asset.width, asset.height) / Math.max(1, Math.min(asset.width, asset.height)) >
    rules.maxRatio
  ) {
    throw new ProviderError("invalid_request", {
      field: "base",
      message: "Too long and thin",
      userMessage: t("errors.layerShape"),
    });
  }
  if (asset.bytes.byteLength > rules.maxBytes) {
    throw new ProviderError("payload_too_large", {
      field: "base",
      message: `The image is ${asset.bytes.byteLength} bytes`,
      userMessage: t("errors.imageTooLarge", {
        model: manifest.displayName,
        size: formatBytes(rules.maxBytes),
      }),
    });
  }
  return asset;
}

/** An input image BytePlus would refuse fails here, with words that say why, before anything is sent. */
function checkInput(manifest: ModelManifest, asset: StoredAsset, field: string): StoredAsset {
  const refs = manifest.capabilities.references;
  if (!refs.mimeTypes.includes(asset.mimeType)) {
    throw new ProviderError("invalid_request", {
      field,
      message: `${manifest.displayName} can't read ${asset.mimeType} images`,
      userMessage: t("errors.capability_unsupported.reason"),
    });
  }
  if (asset.bytes.byteLength > refs.maxBytes) {
    throw new ProviderError("payload_too_large", {
      field,
      message: `Image ${asset.assetId} is ${asset.bytes.byteLength} bytes`,
      userMessage: t("errors.referenceTooLarge", { size: formatBytes(refs.maxBytes) }),
    });
  }
  const long = Math.max(asset.width, asset.height);
  const short = Math.max(1, Math.min(asset.width, asset.height));
  // "Width and height > 14", total pixels at most 36 million, within 1:16.
  if (short <= 14 || asset.width * asset.height > INPUT_MAX_PIXELS || long / short > MAX_RATIO) {
    throw new ProviderError("invalid_request", {
      field,
      message: `Image ${asset.assetId} is ${asset.width}×${asset.height}`,
      userMessage: t("errors.capability_unsupported.reason"),
    });
  }
  return asset;
}

async function read(ctx: CallContext, id: string, field: string): Promise<StoredAsset> {
  return ctx.assets.read(id).catch((err: unknown) => {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("invalid_request", { field, message: `Couldn't read asset ${id}`, cause: err });
  });
}

/** "<image format> must be in lowercase", which the stored types already are. */
const dataUrlOf = (asset: StoredAsset) =>
  `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;

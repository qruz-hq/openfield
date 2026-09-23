import { formatBytes, type JobHandle, type ModelManifest, type NormalizedRequest, t } from "@openfield/core";
import {
  type CallContext,
  errorFromFetchFailure,
  type ImageModel,
  type JobResult,
  type JobUpdate,
  type Provider,
  ProviderError,
  readBody,
  redactError,
  UnknownModelError,
} from "../types";
import { authHeaders } from "./auth";
import { API_BASE } from "./capabilities";
import { discoverIds, manifestFor, mergeDiscovered, recognise, variantOf } from "./discovery";
import { mapError } from "./errors";
import { type InlineImage, toGeminiRequest } from "./map-request";
import { type GeminiResponse, pickImage, toJobResult } from "./map-response";
import { GOOGLE_MODELS } from "./models";

export { mapError } from "./errors";

export function createGoogleProvider(): Provider {
  return {
    meta: {
      id: "google",
      displayName: "Google",
      docsUrl: "https://ai.google.dev/gemini-api/docs/image-generation",
      consoleUrl: "https://aistudio.google.com/apikey",
      networkHosts: ["generativelanguage.googleapis.com"],
      // Images come back inline, so there's nothing to download.
      assetHosts: [],
      stable: true,
    },
    credentials: {
      fields: [
        {
          name: "apiKey",
          label: "API key",
          secret: true,
          required: true,
          placeholder: t("settings.apiKeys.field.placeholder"),
          envVars: ["OPENFIELD_GOOGLE_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
        },
      ],
    },

    validateCredentials(values) {
      return values.apiKey?.trim()
        ? []
        : [
            {
              level: "error",
              field: "apiKey",
              code: "required",
              message: t("settings.apiKeys.field.placeholder"),
            },
          ];
    },

    async verifyCredentials(ctx) {
      const ids = await discoverIds(ctx);
      return { ok: true, modelCount: mergeDiscovered(ids).filter((m) => ids.includes(m.modelId)).length };
    },

    catalog: () => GOOGLE_MODELS.map((m) => structuredClone(m)),
    listModels: async (ctx) => mergeDiscovered(await discoverIds(ctx)),
    discoverIds,
    recognise,
    variantOf,

    model(key, manifest) {
      const bound = manifest ?? manifestFor(key.slice("google:".length));
      if (!bound || bound.key !== key || bound.providerId !== "google") throw new UnknownModelError(key);
      return bindModel(bound);
    },
  };
}

function bindModel(manifest: ModelManifest): ImageModel {
  return {
    ...manifest,

    // Gemini answers in one blocking call, so the handle already carries the result (§6.7).
    async submit(req, ctx) {
      if (req.op !== "generate" && req.op !== "edit") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op}`,
        });
      }
      if (ctx.signal.aborted) throw errorFromFetchFailure(ctx.signal.reason, ctx.signal);
      const submittedAt = ctx.now();
      const url = `${API_BASE}/models/${encodeURIComponent(manifest.modelId)}:generateContent`;
      const headers = { ...authHeaders(ctx), "content-type": "application/json" };
      const payload = toGeminiRequest(manifest, req, await inlineImages(manifest, req, ctx));
      ctx.log.debug("Gemini request", {
        model: manifest.modelId,
        imageConfig: payload.generationConfig.imageConfig,
        parts: payload.contents[0]?.parts.length,
      });

      let res: Response;
      let body: unknown;
      try {
        res = await ctx.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: ctx.signal,
        });
        body = await readBody(res);
      } catch (err) {
        throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
      }
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);

      const image = pickImage(body);
      if (!image) throw redactError(await mapError(res, body), ctx.log);
      const result = await toJobResult(body as GeminiResponse, image, req, ctx, submittedAt);
      ctx.log.info("Gemini image saved", {
        model: manifest.modelId,
        ms: result.timings.completedAt - submittedAt,
      });

      // No idempotency header: Gemini doesn't document one.
      const responseId = (body as GeminiResponse).responseId;
      return {
        jobId: req.jobId,
        ...(responseId && { providerRef: responseId }),
        resume: { result },
        attempt: 0,
      };
    },

    async poll(handle: JobHandle): Promise<JobUpdate> {
      const result = handle.resume?.result as JobResult | undefined;
      if (result && Array.isArray(result.images)) return { state: "succeeded", result };
      // A blocking call that never returned can't be picked up again; the runner marks it interrupted.
      return {
        state: "failed",
        error: new ProviderError("provider_error", { message: "This run has no result to resume" }),
      };
    },
  };
}

/** The edit base first, then references, read from the asset store and checked against the manifest. */
async function inlineImages(
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

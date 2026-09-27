import { type JobHandle, type ModelManifest, t } from "@openfield/core";
import {
  type CallContext,
  errorFromFetchFailure,
  type ImageModel,
  type JobResult,
  type JobUpdate,
  type Provider,
  ProviderError,
  redactError,
  UnknownModelError,
} from "../types";
import { openAiBatch } from "./batch";
import { API_BASE, COMPANY } from "./capabilities";
import { discoverIds, manifestFor, mergeDiscovered, recognise, variantOf } from "./discovery";
import { mapError } from "./errors";
import { openAiFetch } from "./http";
import { editInputs, fileNameOf } from "./images";
import { endpointFor, toFormValues, toImageFields } from "./map-request";
import { type ImagesResponse, toJobResult } from "./map-response";
import { OPENAI_MODELS } from "./models";
import { OPENAI_SETTINGS } from "./settings";

export { mapError } from "./errors";

export function createOpenAiProvider(): Provider {
  return {
    meta: {
      id: "openai",
      displayName: COMPANY,
      docsUrl: "https://developers.openai.com/api/docs/guides/image-generation",
      consoleUrl: "https://platform.openai.com/api-keys",
      networkHosts: ["api.openai.com"],
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
          envVars: ["OPENFIELD_OPENAI_API_KEY", "OPENAI_API_KEY"],
        },
      ],
    },
    settings: OPENAI_SETTINGS,

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

    catalog: () => OPENAI_MODELS.map((m) => structuredClone(m)),
    listModels: async (ctx) => mergeDiscovered(await discoverIds(ctx)),
    discoverIds,
    recognise,
    variantOf,

    model(key, manifest) {
      const bound = manifest ?? manifestFor(key.slice("openai:".length));
      if (!bound || bound.key !== key || bound.providerId !== "openai") throw new UnknownModelError(key);
      return bindModel(bound);
    },
  };
}

function bindModel(manifest: ModelManifest): ImageModel {
  const offersBatch = manifest.speeds?.some((o) => o.id === "batch") ?? false;
  return {
    ...manifest,
    ...(offersBatch && { batch: openAiBatch(manifest) }),

    // /v1/images/* answers in one blocking call with the images inline, and keeps no id to fetch them
    // by later, so no speed is listed in resumableSpeeds: a call cut off by a restart can only run
    // again (§0.4). Background mode on the Responses API could resume; README.md says why it waits.
    async submit(req, ctx) {
      if (req.op !== "generate" && req.op !== "edit" && req.op !== "inpaint") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op}`,
        });
      }
      if (ctx.speed === "batch") {
        throw new ProviderError("invalid_request", { message: "A Batch run goes through model.batch" });
      }
      if (ctx.signal.aborted) throw errorFromFetchFailure(ctx.signal.reason, ctx.signal);
      const submittedAt = ctx.now();
      const fields = toImageFields(manifest, req);
      const endpoint = endpointFor(req);
      ctx.log.debug("OpenAI request", {
        model: manifest.modelId,
        endpoint,
        size: fields.size,
        quality: fields.quality,
        n: fields.n,
      });

      const { res, body } =
        endpoint === "generations"
          ? await openAiFetch(ctx, `${API_BASE}/images/generations`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(fields),
            })
          : await openAiFetch(ctx, `${API_BASE}/images/edits`, {
              method: "POST",
              // No content-type: fetch sets the multipart boundary itself.
              body: await editForm(manifest, req, ctx, fields),
            });
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);

      const result = await toJobResult((body ?? {}) as ImagesResponse, req, ctx, {
        submittedAt,
        price: manifest.price,
        speed: "standard",
      });
      ctx.log.info("OpenAI images saved", {
        model: manifest.modelId,
        images: result.images.length,
        ms: result.timings.completedAt - submittedAt,
      });
      return { jobId: req.jobId, resume: { result }, attempt: 0 };
    },

    async poll(handle: JobHandle): Promise<JobUpdate> {
      const result = handle.resume?.result as JobResult | undefined;
      if (result && Array.isArray(result.images)) return { state: "succeeded", result };
      // A blocking call that never returned has nothing to pick up. The runner never stores this
      // handle, because no OpenAI speed is resumable, so this only guards against misuse.
      return {
        state: "failed",
        error: new ProviderError("provider_error", { message: "This run has no result to resume" }),
      };
    },
  };
}

/** The edit form: the fields, then image[] (the base first), then the mask when there is one. */
async function editForm(
  manifest: ModelManifest,
  req: Parameters<ImageModel["submit"]>[0],
  ctx: CallContext,
  fields: ReturnType<typeof toImageFields>,
): Promise<FormData> {
  const inputs = await editInputs(manifest, req, ctx);
  const form = new FormData();
  for (const [name, value] of toFormValues(fields)) form.append(name, value);
  for (const [i, image] of inputs.images.entries()) {
    form.append(
      "image[]",
      new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
      fileNameOf(image, `image-${i}`),
    );
  }
  if (inputs.mask) {
    form.append("mask", new Blob([new Uint8Array(inputs.mask.bytes)], { type: "image/png" }), "mask.png");
  }
  return form;
}

import { type JobHandle, type ModelManifest, type SpeedId, speedName, t } from "@openfield/core";
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
import { googleBatch } from "./batch";
import { API_BASE, COMPANY } from "./capabilities";
import { discoverIds, manifestFor, mergeDiscovered, recognise, variantOf } from "./discovery";
import { isFlexBusy, mapError, retryAfterOf } from "./errors";
import { googleFetch } from "./http";
import { inlineImages } from "./images";
import { type GeminiRequest, serviceTierFor, toGeminiRequest } from "./map-request";
import { type GeminiResponse, pickImage, speedServed, toJobResult } from "./map-response";
import { GOOGLE_MODELS } from "./models";
import { GOOGLE_SETTINGS, parseGoogleSettings } from "./settings";

export { mapError } from "./errors";

export function createGoogleProvider(): Provider {
  return {
    meta: {
      id: "google",
      displayName: COMPANY,
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
    settings: GOOGLE_SETTINGS,

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
  const offersBatch = manifest.speeds?.some((o) => o.id === "batch") ?? false;
  return {
    ...manifest,
    ...(offersBatch && { batch: googleBatch(manifest) }),

    // Gemini answers in one blocking call, so the handle already carries the result (§6.7).
    async submit(req, ctx) {
      if (req.op !== "generate" && req.op !== "edit") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op}`,
        });
      }
      if (ctx.speed === "batch") {
        throw new ProviderError("invalid_request", { message: "A Batch run goes through model.batch" });
      }
      if (ctx.signal.aborted) throw errorFromFetchFailure(ctx.signal.reason, ctx.signal);
      const submittedAt = ctx.now();
      const serviceTier = serviceTierFor(ctx.speed);
      const payload = toGeminiRequest(manifest, req, await inlineImages(manifest, req, ctx), {
        ...(serviceTier && { serviceTier }),
      });
      ctx.log.debug("Gemini request", {
        model: manifest.modelId,
        imageConfig: payload.generationConfig.imageConfig,
        parts: payload.contents[0]?.parts.length,
        serviceTier,
      });

      let requested: SpeedId = ctx.speed;
      let sent = await generate(manifest, payload, ctx);
      if (!sent.res.ok && serviceTier === "flex" && isFlexBusy(sent.res, sent.body)) {
        // Google never moves a busy Flex request up to Standard itself; the person's setting decides.
        if (parseGoogleSettings(ctx.settings).flexBusy === "wait") {
          throw redactError(await busyError(sent.res, sent.body), ctx.log);
        }
        ctx.log.info("Flex is busy, sending again at Standard", { model: manifest.modelId });
        const { serviceTier: _, ...standard } = payload;
        requested = "standard";
        sent = await generate(manifest, standard, ctx);
      }
      const { res, body } = sent;
      if (!res.ok) throw redactError(speedAware(await mapError(res, body), requested), ctx.log);

      const image = pickImage(body);
      if (!image) throw redactError(await mapError(res, body), ctx.log);
      const speedUsed = speedServed(body, res.headers, requested);
      const result = await toJobResult(body as GeminiResponse, image, req, ctx, submittedAt, speedUsed);
      ctx.log.info("Gemini image saved", {
        model: manifest.modelId,
        ms: result.timings.completedAt - submittedAt,
        speed: speedUsed,
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

async function generate(
  manifest: ModelManifest,
  payload: GeminiRequest,
  ctx: CallContext,
): Promise<{ res: Response; body: unknown }> {
  const url = `${API_BASE}/models/${encodeURIComponent(manifest.modelId)}:generateContent`;
  return googleFetch(ctx, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Flex refused for capacity: the runner waits it out on its busy schedule, not the retry budget. */
async function busyError(res: Response, body: unknown): Promise<ProviderError> {
  const mapped = await mapError(res, body);
  const retryAfterMs = retryAfterOf(res, body);
  return new ProviderError("provider_unavailable", {
    busy: true,
    httpStatus: res.status,
    ...(mapped.providerCode && { providerCode: mapped.providerCode }),
    message: `Flex is busy: ${mapped.message}`,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}

/** A speed Google won't take for this model points at the setting, in its own words (§0.5). */
function speedAware(err: ProviderError, requested: SpeedId): ProviderError {
  if (err.field !== "speed") return err;
  return new ProviderError("unsupported_param", {
    field: "speed",
    ...(err.httpStatus !== undefined && { httpStatus: err.httpStatus }),
    ...(err.providerCode && { providerCode: err.providerCode }),
    message: err.message,
    userMessage: t("errors.speedNotOffered", {
      company: COMPANY,
      speed: speedName(GOOGLE_SETTINGS, requested),
    }),
    hint: { action: "open-settings", label: t("actions.openSettings") },
  });
}

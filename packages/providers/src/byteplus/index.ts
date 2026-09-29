import { formatBytes, type JobHandle, type ModelManifest, t, type VideoResolution } from "@openfield/core";
import {
  type CallContext,
  errorFromFetchFailure,
  type ImageModel,
  type JobUpdate,
  notFoundError,
  type Provider,
  ProviderError,
  redactError,
  UnknownModelError,
} from "../types";
import {
  API_HOST,
  ASSET_HOSTS,
  COMPANY,
  FRAME_EDGE,
  FRAME_MAX_BYTES,
  FRAME_MIME_TYPES,
  FRAME_RATIO,
  type SeedanceSpec,
  TASKS_URL,
} from "./capabilities";
import { mapError } from "./errors";
import { byteplusFetch } from "./http";
import { type FrameUrls, toSeedanceBody } from "./map-request";
import { type Resume, type TaskBody, toJobUpdate } from "./map-response";
import { BYTEPLUS_MODELS, specFor } from "./models";

export { mapError } from "./errors";

// BytePlus ModelArk's video generation API (Seedance): a task queue. A create call answers at once
// with a task id, and a status read by that id answers queued, running, then the finished video as
// a URL that lasts 24 hours. Checked against the API reference on 2026-09-29; README.md lists what
// still needs a live run.

export function createByteplusProvider(): Provider {
  return {
    meta: {
      id: "byteplus",
      displayName: COMPANY,
      docsUrl: "https://docs.byteplus.com/en/docs/ModelArk/1520757",
      consoleUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey",
      networkHosts: [API_HOST],
      assetHosts: [...ASSET_HOSTS],
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
          // ARK_API_KEY is what BytePlus's own SDKs and samples read.
          envVars: ["OPENFIELD_BYTEPLUS_API_KEY", "ARK_API_KEY"],
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
      await listTasks(ctx);
      return { ok: true, modelCount: BYTEPLUS_MODELS.length };
    },

    catalog: () => BYTEPLUS_MODELS.map((m) => structuredClone(m)),
    // The task list proves the key; which models it may run only shows when one is asked for.
    listModels: async (ctx) => {
      await listTasks(ctx);
      return BYTEPLUS_MODELS.map((m) => structuredClone(m));
    },
    recognise: (modelId) => specFor(modelId) !== undefined,

    model(key, manifest) {
      const modelId = key.slice("byteplus:".length);
      const spec = specFor(modelId);
      const bound = manifest ?? BYTEPLUS_MODELS.find((m) => m.key === key);
      if (!spec || !bound || bound.key !== key || bound.providerId !== "byteplus") {
        throw new UnknownModelError(key);
      }
      return bindModel(bound, spec);
    },
  };
}

/** One task from the list: a free, authenticated read that proves a key works (§6.2). */
async function listTasks(ctx: CallContext): Promise<void> {
  const { res, body } = await byteplusFetch(ctx, `${TASKS_URL}?page_num=1&page_size=1`);
  if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
}

function bindModel(manifest: ModelManifest, spec: SeedanceSpec): ImageModel {
  const taskUrl = (id: string) => `${TASKS_URL}/${encodeURIComponent(id)}`;
  return {
    ...manifest,

    // Returns as soon as BytePlus has the task and its id, never after the video (§6.3). No
    // idempotency key exists, so a create whose answer is lost can't be asked for again.
    async submit(req, ctx): Promise<JobHandle> {
      if (req.op !== "generate") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op} through Openfield`,
        });
      }
      if (ctx.speed !== "standard") {
        throw new ProviderError("unsupported_param", {
          field: "speed",
          message: `${COMPANY} only runs at Standard`,
        });
      }
      if (ctx.signal.aborted) throw errorFromFetchFailure(ctx.signal.reason, ctx.signal);
      const submittedAt = ctx.now();
      const frames = await readFrames(req.video, ctx);
      const payload = toSeedanceBody(spec, req, frames);
      ctx.log.debug("BytePlus request", {
        model: spec.modelId,
        fields: Object.keys(payload).filter((k) => k !== "content"),
        frames: Object.keys(frames),
      });
      const { res, body } = await byteplusFetch(ctx, TASKS_URL, { method: "POST", body: payload });
      if (!res.ok) throw redactError(await mapError(res, body, manifest.displayName), ctx.log);
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) {
        throw new ProviderError("provider_error", { message: "BytePlus accepted the task without an id" });
      }
      ctx.log.info("BytePlus accepted the task", { model: spec.modelId, id });
      const resume: Resume = {
        index: req.batchIndex,
        submittedAt,
        resolution: payload.resolution as VideoResolution,
        ...(payload.generate_audio !== undefined && { audio: payload.generate_audio }),
      };
      // The status and cancel URLs are rebuilt from the id, so the stored handle holds no URL.
      return { jobId: req.jobId, providerRef: id, resume: { ...resume }, attempt: 0 };
    },

    async poll(handle, ctx): Promise<JobUpdate> {
      const id = handle.providerRef;
      if (!id) throw new ProviderError("provider_error", { message: "This handle has no task id" });
      const { res, body } = await byteplusFetch(ctx, taskUrl(id));
      // Kept for 7 days, and only for the account that made it: either way it won't come back.
      if (res.status === 404) throw redactError(notFoundError(COMPANY, { httpStatus: 404 }), ctx.log);
      if (!res.ok) throw redactError(await mapError(res, body, manifest.displayName), ctx.log);
      return toJobUpdate(handle, (body ?? {}) as TaskBody, ctx, manifest);
    },

    // BytePlus cancels only a task that's still queued, and bills nothing for it. Once it runs,
    // the delete is refused: nothing more can be stopped, so that ends the cancel rather than being
    // retried, and the run says the video may still be charged.
    async cancel(handle, ctx) {
      const id = handle.providerRef;
      if (!id) return;
      const { res, body } = await byteplusFetch(ctx, taskUrl(id), { method: "DELETE" });
      if (res.ok || res.status === 404) return;
      const error = await mapError(res, body, manifest.displayName);
      if (!error.retryable && error.code !== "auth_invalid") {
        ctx.log.info("BytePlus had already started this task, so it runs to the end", {
          id,
          code: error.providerCode,
        });
        return;
      }
      throw redactError(error, ctx.log);
    },
  };
}

/**
 * The frames as data URLs, checked against BytePlus's limits first so a frame it would refuse
 * fails here, with words that say why, before anything is sent.
 */
async function readFrames(video: ImageModelVideo, ctx: CallContext): Promise<FrameUrls> {
  const frames: FrameUrls = {};
  for (const [slot, ref] of [
    ["start", video?.startFrame],
    ["end", video?.endFrame],
  ] as const) {
    if (!ref) continue;
    const field = slot === "start" ? "video.startFrame" : "video.endFrame";
    const asset = await ctx.assets.read(ref.assetId);
    if (!FRAME_MIME_TYPES.includes(asset.mimeType)) {
      throw new ProviderError("invalid_request", {
        field,
        message: `A ${asset.mimeType} frame can't be sent`,
        userMessage: t("errors.capability_unsupported.reason"),
      });
    }
    if (asset.bytes.byteLength > FRAME_MAX_BYTES) {
      throw new ProviderError("payload_too_large", {
        field,
        message: `The frame is ${asset.bytes.byteLength} bytes`,
        userMessage: t("video.frameTooLarge", { size: formatBytes(FRAME_MAX_BYTES) }),
      });
    }
    const [low, high] = FRAME_EDGE;
    const ratio = asset.width / Math.max(1, asset.height);
    const edgesOk = [asset.width, asset.height].every((edge) => edge >= low && edge <= high);
    if (!edgesOk || ratio < FRAME_RATIO[0] || ratio > FRAME_RATIO[1]) {
      throw new ProviderError("invalid_request", {
        field,
        message: `The frame is ${asset.width}×${asset.height}`,
        userMessage: t("video.frameSize"),
      });
    }
    frames[slot] = `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  }
  return frames;
}

type ImageModelVideo = Parameters<ImageModel["submit"]>[0]["video"];

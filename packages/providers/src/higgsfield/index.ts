import {
  type CostEstimate,
  DEFAULT_CURRENCY,
  formatMoney,
  type JobHandle,
  type ModelManifest,
  t,
} from "@openfield/core";
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
import { API_BASE, API_HOST, ASSET_HOSTS, COMPANY, type WireSpec } from "./capabilities";
import { mapError } from "./errors";
import { higgsfieldFetch } from "./http";
import { toHiggsfieldBody } from "./map-request";
import { type Resume, type StatusBody, toJobUpdate } from "./map-response";
import { HIGGSFIELD_MODELS, specFor } from "./models";

export { mapError } from "./errors";

// Higgsfield's public API (§6.15): a queue. A create call answers at once with a request id, and a
// status read by that id answers queued, in_progress, then the finished images as URLs. Experimental
// until someone runs it live: see README.md for what's unconfirmed.

export function createHiggsfieldProvider(): Provider {
  return {
    meta: {
      id: "higgsfield",
      displayName: COMPANY,
      docsUrl: "https://docs.higgsfield.ai",
      consoleUrl: "https://open.higgsfield.ai/api-keys",
      networkHosts: [API_HOST],
      assetHosts: [...ASSET_HOSTS],
      stable: false,
    },
    credentials: {
      fields: [
        {
          name: "apiKey",
          label: "API key",
          secret: true,
          required: true,
          placeholder: t("settings.apiKeys.field.placeholder"),
          // Not HF_KEY, which Higgsfield's own clients read: HF_ is Hugging Face's prefix, and a
          // Hugging Face token must never be sent here.
          envVars: ["OPENFIELD_HIGGSFIELD_API_KEY"],
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
      await listStyles(ctx);
      return { ok: true, modelCount: HIGGSFIELD_MODELS.length };
    },

    catalog: () => HIGGSFIELD_MODELS.map((m) => structuredClone(m)),
    // There's no model list to discover from, so this checks the key and returns the catalog.
    listModels: async (ctx) => {
      await listStyles(ctx);
      return HIGGSFIELD_MODELS.map((m) => structuredClone(m));
    },
    recognise: (modelId) => specFor(modelId) !== undefined,

    model(key, manifest) {
      const modelId = key.slice("higgsfield:".length);
      const spec = specFor(modelId);
      const bound = manifest ?? HIGGSFIELD_MODELS.find((m) => m.key === key);
      if (!spec || !bound || bound.key !== key || bound.providerId !== "higgsfield") {
        throw new UnknownModelError(key);
      }
      return bindModel(bound, spec);
    },
  };
}

/** SOUL's style list: a free, authenticated read, so it proves a key works (§6.2). */
async function listStyles(ctx: CallContext): Promise<void> {
  const { res, body } = await higgsfieldFetch(ctx, `${API_BASE}/v1/text2image/soul-styles`);
  if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
}

function bindModel(manifest: ModelManifest, spec: WireSpec): ImageModel {
  const endpoint = `${API_BASE}/${spec.path}`;
  return {
    ...manifest,

    // Returns as soon as Higgsfield has the request and its id, never after the image (§6.3). No
    // idempotency key exists, so a create whose answer is lost can't be asked for again.
    async submit(req, ctx): Promise<JobHandle> {
      if (req.op !== "generate") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op} through Openfield yet`,
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
      const payload = toHiggsfieldBody(spec, req);
      ctx.log.debug("Higgsfield request", {
        model: spec.path,
        fields: Object.keys(payload).filter((k) => k !== "prompt"),
      });
      const { res, body } = await higgsfieldFetch(ctx, endpoint, { method: "POST", body: payload });
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
      const id = (body as StatusBody | undefined)?.request_id;
      if (typeof id !== "string" || !id) {
        throw new ProviderError("provider_error", {
          message: "Higgsfield accepted the request without an id",
        });
      }
      ctx.log.info("Higgsfield accepted the request", { model: spec.path, id });
      const resume: Resume = { index: req.batchIndex, submittedAt };
      // The status and cancel URLs are rebuilt from the id, so the stored handle holds no URL.
      return { jobId: req.jobId, providerRef: id, resume: { ...resume }, attempt: 0 };
    },

    async poll(handle, ctx): Promise<JobUpdate> {
      const id = handle.providerRef;
      if (!id) throw new ProviderError("provider_error", { message: "This handle has no request id" });
      const url = `${API_BASE}/requests/${encodeURIComponent(id)}/status`;
      const { res, body } = await higgsfieldFetch(ctx, url);
      // Gone, or another account's: either way it won't come back.
      if (res.status === 404) throw redactError(notFoundError(COMPANY, { httpStatus: 404 }), ctx.log);
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
      return toJobUpdate(handle, (body ?? {}) as StatusBody, ctx);
    },

    // Higgsfield cancels only a request that hasn't started, and refunds it. Once it has started it
    // answers 400: nothing more can be stopped, so that ends the cancel rather than being retried.
    async cancel(handle, ctx) {
      const id = handle.providerRef;
      if (!id) return;
      const url = `${API_BASE}/requests/${encodeURIComponent(id)}/cancel`;
      const { res, body } = await higgsfieldFetch(ctx, url, { method: "POST" });
      if (res.ok || res.status === 404) return;
      if (res.status === 400) {
        ctx.log.info("Higgsfield had already started this request, so it runs to the end", { id });
        return;
      }
      throw redactError(await mapError(res, body), ctx.log);
    },

    // The documented estimate: the same body, answered with credits and dollars for one request.
    async estimateRemote(req, ctx): Promise<CostEstimate> {
      const { res, body } = await higgsfieldFetch(ctx, `${API_BASE}/estimate/${spec.path}`, {
        method: "POST",
        body: toHiggsfieldBody(spec, req),
      });
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
      const each = Number((body as { usd?: unknown } | undefined)?.usd);
      if (!Number.isFinite(each) || each < 0) {
        throw new ProviderError("provider_error", { message: "The estimate had no dollar amount" });
      }
      const count = Math.max(1, req.batch);
      return {
        currency: DEFAULT_CURRENCY,
        min: each * count,
        max: each * count,
        confidence: "estimated",
        basis: t("cost.basis", { count, each: formatMoney(each, DEFAULT_CURRENCY, true) }),
        pricedAt: new Date(ctx.now()).toISOString().slice(0, 10),
      };
    },
  };
}

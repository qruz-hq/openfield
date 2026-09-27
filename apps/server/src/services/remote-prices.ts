import {
  type CostEstimate,
  type EstimateBody,
  type ModelManifest,
  type NormalizedRequest,
  newId,
  type SizeSpec,
} from "@openfield/core";
import { type FetchLike, isProviderError, normalize } from "@openfield/providers/server";
import type { Ingest } from "../files/ingest";
import type { Logger } from "../log/logger";
import { type CallContexts, noWrites } from "../runner/provider-fetch";
import type { ModelService } from "./models";
import type { ProviderSettingsService } from "./provider-settings";

// Prices a company answers per request (price.kind "provider_estimate", §6.9): Higgsfield's
// estimate endpoint. The composer, the canvas, Settings and each run ask through here. The prompt
// and seed never change a price (checked live), so they're swapped for fixed ones before asking and
// the company's answer is kept by what went over the wire: one request's price is asked once a day,
// however many screens show it and whatever the image count. A price that can't be had is unknown,
// never an error on screen.

const HOUR = 3_600_000;
/** Prices move rarely, and Settings shows each model's usual price as of today. */
const ANSWER_TTL_MS = 24 * HOUR;
/** A failed answer is asked again after this, so a blip doesn't hide a price all day. */
const RETRY_AFTER_MS = 60_000;
const ASK_TIMEOUT_MS = 10_000;
/** Stands in for the prompt, which the price never depends on. */
const PRICE_PROMPT = "An image";

/** An estimate body that isn't normalized yet: the estimate route's, or a canvas node's call. */
export type PriceBody = Omit<EstimateBody, "prompt" | "size"> & { prompt?: string; size?: SizeSpec };

interface Answer {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

interface Kept {
  answer: Promise<Answer>;
  until: number;
}

export interface RemotePricesDeps {
  models: ModelService;
  contexts: CallContexts;
  ingest: Ingest;
  providerSettings: ProviderSettingsService;
  logger: Logger;
  now?: () => number;
}

/** True when a model's price comes from its company per request rather than from its manifest. */
export const asksForPrice = (manifest: ModelManifest): boolean => manifest.price.kind === "provider_estimate";

export class RemotePrices {
  readonly #answers = new Map<string, Kept>();

  constructor(private readonly deps: RemotePricesDeps) {}

  /** The cost of `req.batch` images, or null when the company can't say (no key, no amount, a failure). */
  async estimate(manifest: ModelManifest, req: NormalizedRequest): Promise<CostEstimate | null> {
    if (!asksForPrice(manifest)) return null;
    let bound: ReturnType<ModelService["bind"]>;
    try {
      bound = this.deps.models.bind(manifest.key);
    } catch {
      return null;
    }
    const ask = bound.model.estimateRemote?.bind(bound.model);
    if (!ask) return null;
    const ctx = this.deps.contexts.for(
      bound.provider,
      AbortSignal.timeout(ASK_TIMEOUT_MS),
      noWrites((id) => this.deps.ingest.read(id)),
    );
    // No key, or the company is off: there's no one to ask.
    if (!ctx) return null;
    try {
      const cost = await ask(priceRequest(req), { ...ctx, fetch: this.#keep(ctx.fetch) });
      return cost.confidence === "unknown" ? null : cost;
    } catch (error) {
      this.deps.logger.warn("Couldn't get a price. It shows as unknown for now", {
        model: manifest.key,
        code: isProviderError(error) ? error.code : "unknown",
      });
      return null;
    }
  }

  /** The same, for a request that isn't normalized yet. */
  async estimateFor(manifest: ModelManifest, body: PriceBody): Promise<CostEstimate | null> {
    if (!asksForPrice(manifest)) return null;
    const result = await normalize(
      manifest,
      {
        ...body,
        idempotencyKey: newId(),
        model: manifest.key,
        source: "composer",
        prompt: body.prompt?.trim() || PRICE_PROMPT,
        size: body.size ?? defaultSize(manifest),
      },
      {
        jobSetId: newId(),
        settings: this.deps.providerSettings.forRun(manifest.providerId),
        randomSeed: () => 0,
      },
    );
    if (result.error) return null;
    return this.estimate(manifest, result.request);
  }

  /**
   * Keeps each answer by what was sent, so a repeat within the day costs no call and two screens
   * asking at once share one. Only answers are kept: a call that throws is asked again next time.
   */
  #keep(fetch: FetchLike): FetchLike {
    return async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      const key = `${init?.method ?? "GET"} ${url} ${body}`;
      const now = this.#now();
      const kept = this.#answers.get(key);
      if (kept && kept.until > now) return toResponse(await kept.answer);

      const answer = fetch(input, init).then(async (res) => ({
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body: await res.text(),
      }));
      const entry: Kept = { answer, until: now + ANSWER_TTL_MS };
      this.#prune(now);
      this.#answers.set(key, entry);
      try {
        const got = await answer;
        if (got.status < 200 || got.status >= 300) entry.until = this.#now() + RETRY_AFTER_MS;
        return toResponse(got);
      } catch (error) {
        if (this.#answers.get(key) === entry) this.#answers.delete(key);
        throw error;
      }
    };
  }

  #prune(now: number): void {
    for (const [key, kept] of this.#answers) if (kept.until <= now) this.#answers.delete(key);
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/** The request as priced: the fixed prompt, no seed, and a stand-in for a negative prompt's text. */
function priceRequest(req: NormalizedRequest): NormalizedRequest {
  const { seed: _seed, ...rest } = req;
  return {
    ...rest,
    prompt: PRICE_PROMPT,
    promptAfterPreset: PRICE_PROMPT,
    ...(req.negativePrompt && { negativePrompt: PRICE_PROMPT }),
  };
}

function toResponse(answer: Answer): Response {
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  });
}

/** The model's own default size, for a body that names none (Settings' usual price). */
function defaultSize(manifest: ModelManifest): SizeSpec {
  const size = manifest.capabilities.size;
  if (size.mode === "aspect") {
    return size.default === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: size.default };
  }
  return { kind: "pixels", width: size.default.width, height: size.default.height };
}

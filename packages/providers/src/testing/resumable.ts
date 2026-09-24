import {
  type AspectRatio,
  type Capabilities,
  type JobHandle,
  jobIdempotencyKey,
  type ModelManifest,
  RESOLUTION_TIER_PX,
  t,
} from "@openfield/core";
import {
  type AssetSink,
  type CallContext,
  errorCodeForStatus,
  errorFromFetchFailure,
  type ImageModel,
  type JobResult,
  type JobUpdate,
  notFoundError,
  type Provider,
  ProviderError,
  readBody,
  redactError,
  retryAfterFromHeaders,
  UnknownModelError,
} from "../types";
import { gradientPng, hashString } from "./png";
import {
  type FakeEnv,
  type FakeRoute,
  type FakeScenario,
  type RecordedExchange,
  replay,
  storeMap,
  taggedScenario,
} from "./types";

// The test company (§6.12): one resumable model that exists only in fake mode, so the resume path
// can be tested without keys. No built-in adapter resumes a sync call yet (Google can't, §6.13).
// Its create call answers at once with an id, and a status read by id answers queued, then
// running, then the image. The id carries its own plan (when it was made, the size, the seed), like
// the fake batch ids, so it still answers after a server restart with no stored state.
//
// The adapter half goes through ctx.fetch like any adapter; the fake half answers for
// fake.openfield.invalid, a name that never resolves, so a real fetch fails loudly.

const COMPANY = "Test company";
const HOST = "fake.openfield.invalid";
const BASE = `https://${HOST}/v1`;
const MODEL_ID = "resumable-image";
const RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const satisfies readonly AspectRatio[];

const CAPABILITIES: Capabilities = {
  ops: {
    textToImage: true,
    imageEdit: false,
    inpaint: false,
    outpaint: false,
    upscale: false,
    removeBackground: false,
    detectText: false,
    decomposeLayers: false,
  },
  references: {
    supported: false,
    max: 0,
    roles: [],
    mimeTypes: [],
    maxBytes: 0,
    weights: false,
    strengthMode: "none",
  },
  size: { mode: "aspect", ratios: [...RATIOS], default: "1:1" },
  resolution: { tiers: ["1K"], default: "1K" },
  batch: { max: 4, native: false },
  seed: { supported: false, echoed: false },
  negativePrompt: false,
  promptEnhance: "openfield",
  styleStrength: false,
  transparency: false,
  streaming: { partialImages: false, progressPercent: true },
  output: { formats: ["png"], default: "png" },
  identity: { nativeCharacterRefs: false, nativeStylePresets: false },
  // Long enough for "#fake:resume_slow" (about a minute) inside one attempt.
  limits: { requestTimeoutMs: 120_000, typicalLatencyMs: [4_000, 60_000], maxConcurrent: 4 },
  controlOrder: ["model", "aspect", "resolution", "batch", "seed"],
  emulated: ["batch"],
  unsupported: {
    seed: { reason: t("composer.chips.seed.unsupported", { model: "Resumable test model" }) },
  },
  unsupportedParamPolicy: "drop-with-warning",
};

export const RESUMABLE_TEST_MODEL: ModelManifest = {
  key: `fake:${MODEL_ID}`,
  providerId: "fake",
  modelId: MODEL_ID,
  displayName: "Resumable test model",
  description: "Keeps going through a restart. Only in fake mode.",
  family: "Test",
  capabilities: CAPABILITIES,
  price: {
    kind: "per_image",
    currency: "USD",
    pricedAt: "2026-09-24",
    sourceUrl: `https://${HOST}/pricing`,
    tiers: [{ tier: "1K", usd: 0.04 }],
  },
  resumableSpeeds: ["standard"],
  // Its create sends the idempotency key, and the fake answers a repeated key with the first call.
  idempotentSubmit: true,
  source: "static",
  manifestVersion: "1",
  fetchedAt: "2026-09-24",
};

// The adapter

export function createResumableFakeProvider(): Provider {
  return {
    meta: {
      id: "fake",
      displayName: COMPANY,
      docsUrl: `https://${HOST}/docs`,
      consoleUrl: `https://${HOST}/keys`,
      networkHosts: [HOST],
      // Images come back inline in the status answer.
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
          envVars: ["OPENFIELD_FAKE_API_KEY"],
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
      return { ok: true, modelCount: (await listIds(ctx)).length };
    },

    catalog: () => [structuredClone(RESUMABLE_TEST_MODEL)],
    listModels: async (ctx) => {
      await listIds(ctx);
      return [structuredClone(RESUMABLE_TEST_MODEL)];
    },
    recognise: (modelId) => modelId === MODEL_ID,

    model(key, manifest) {
      const bound = manifest ?? (key === RESUMABLE_TEST_MODEL.key ? RESUMABLE_TEST_MODEL : undefined);
      if (!bound || bound.key !== key || bound.providerId !== "fake") throw new UnknownModelError(key);
      return bindModel(bound);
    },
  };
}

/** What handle.resume carries: enough to shape the result in a process that never saw the request. */
interface Resume {
  index: number;
  submittedAt: number;
}

interface StatusBody {
  id?: string;
  status?: string;
  progress?: number;
  output?: { mime_type?: string; width?: number; height?: number; data?: string };
  error?: { code?: string; message?: string };
}

function bindModel(manifest: ModelManifest): ImageModel {
  return {
    ...manifest,

    // Returns as soon as the company has the call and its id, never after the image (§6.3).
    async submit(req, ctx): Promise<JobHandle> {
      if (req.op !== "generate") {
        throw new ProviderError("capability_unsupported", {
          message: `${manifest.displayName} can't ${req.op}`,
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
      const payload = {
        prompt: req.promptAfterPreset.trim(),
        ...("aspect" in req.size && req.size.aspect !== "auto" && { aspect_ratio: req.size.aspect }),
        size: req.resolution ?? "1K",
      };
      const { res, body } = await call(ctx, `${BASE}/images`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The same key on every attempt, so a create resent after a lost answer isn't billed twice.
          "idempotency-key": jobIdempotencyKey(req.idempotencyKey, req.batchIndex),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
      const id = (body as StatusBody | undefined)?.id;
      if (typeof id !== "string" || !id) {
        throw new ProviderError("provider_error", { message: "The create call answered without an id" });
      }
      ctx.log.debug("Test company accepted the call", { model: manifest.modelId, id });
      const resume: Resume = { index: req.batchIndex, submittedAt };
      return { jobId: req.jobId, providerRef: id, resume: { ...resume }, attempt: 0 };
    },

    async poll(handle, ctx): Promise<JobUpdate> {
      const id = handle.providerRef;
      if (!id) throw new ProviderError("provider_error", { message: "This handle has no id to read" });
      const { res, body } = await call(ctx, `${BASE}/images/${encodeURIComponent(id)}`);
      if (res.status === 404) throw redactError(notFoundError(COMPANY, { httpStatus: 404 }), ctx.log);
      if (!res.ok) throw redactError(await mapError(res, body), ctx.log);

      const status = (body ?? {}) as StatusBody;
      switch (status.status) {
        case "queued":
          return { state: "queued" };
        case "running":
          return {
            state: "running",
            ...(typeof status.progress === "number" && { progress: status.progress }),
          };
        case "succeeded":
          return { state: "succeeded", result: await harvest(id, handle, status, ctx) };
        case "failed":
          return { state: "failed", error: errorFromStatus(status.error) };
        case "canceled":
          return {
            state: "canceled",
            error: new ProviderError("canceled", { message: `${COMPANY} stopped this call` }),
          };
        default:
          throw new ProviderError("provider_error", {
            message: `Unknown status ${JSON.stringify(status.status)}`,
          });
      }
    },

    async cancel(handle, ctx) {
      const id = handle.providerRef;
      if (!id) return;
      const { res, body } = await call(ctx, `${BASE}/images/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      // Gone already: nothing left to stop.
      if (!res.ok && res.status !== 404) throw redactError(await mapError(res, body), ctx.log);
    },
  };
}

/**
 * A finished call's image, written once per asset sink however often it's polled (§6.3), so a
 * repeated poll returns the same result instead of a second copy. A failed write is forgotten, so
 * the next poll tries again.
 */
const harvested = new WeakMap<AssetSink, Map<string, Promise<JobResult>>>();

function harvest(id: string, handle: JobHandle, status: StatusBody, ctx: CallContext): Promise<JobResult> {
  const bySink = harvested.get(ctx.assets) ?? new Map<string, Promise<JobResult>>();
  harvested.set(ctx.assets, bySink);
  const known = bySink.get(id);
  if (known) return known;
  const pending = toJobResult(handle, status, ctx);
  bySink.set(id, pending);
  pending.catch(() => bySink.delete(id));
  return pending;
}

async function toJobResult(handle: JobHandle, status: StatusBody, ctx: CallContext): Promise<JobResult> {
  const output = status.output;
  if (!output?.data) {
    throw new ProviderError("provider_error", { message: "The finished call carried no image" });
  }
  // Copy out of Buffer's shared pool so the sink gets bytes it owns.
  const bytes = new Uint8Array(Buffer.from(output.data, "base64"));
  const mimeType = output.mime_type ?? "image/png";
  const written = await ctx.assets.write(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { mimeType },
  );
  const resume = (handle.resume ?? {}) as Partial<Resume>;
  const completedAt = ctx.now();
  return {
    images: [
      {
        assetId: written.assetId,
        index: typeof resume.index === "number" ? resume.index : 0,
        width: written.width,
        height: written.height,
        mimeType,
        bytes: written.bytes,
      },
    ],
    usage: { imagesBilled: 1 },
    providerRaw: ctx.log.scrub({ ...status, output: { ...output, data: `[${bytes.byteLength} bytes]` } }),
    timings: {
      submittedAt: typeof resume.submittedAt === "number" ? resume.submittedAt : completedAt,
      firstOutputAt: completedAt,
      completedAt,
    },
    speedUsed: "standard",
  };
}

async function listIds(ctx: CallContext): Promise<string[]> {
  const { res, body } = await call(ctx, `${BASE}/models`);
  if (!res.ok) throw redactError(await mapError(res, body), ctx.log);
  const data = (body as { data?: { id?: unknown }[] } | undefined)?.data ?? [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

async function call(
  ctx: CallContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ res: Response; body: unknown }> {
  const key = ctx.credentials.apiKey?.trim();
  if (!key) throw new ProviderError("auth_missing", { message: `No ${COMPANY} key is set` });
  try {
    const res = await ctx.fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${key}` },
      signal: ctx.signal,
    });
    return { res, body: await readBody(res) };
  } catch (err) {
    throw redactError(errorFromFetchFailure(err, ctx.signal), ctx.log);
  }
}

/** One mapError signature everywhere (§6.8): `{ error: { code, message } }` bodies. */
export async function mapError(res: Response, body?: unknown): Promise<ProviderError> {
  const data = body === undefined ? await readBody(res) : body;
  const err = (data as StatusBody | undefined)?.error;
  const retryAfterMs = retryAfterFromHeaders(res.headers);
  return new ProviderError(
    err?.code === "content_refused" ? "content_refused" : errorCodeForStatus(res.status),
    {
      httpStatus: res.status,
      providerCode: err?.code ?? String(res.status),
      message: err?.message ?? `HTTP ${res.status}`,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    },
  );
}

function errorFromStatus(err: StatusBody["error"]): ProviderError {
  const opts = { providerCode: err?.code ?? "failed", message: err?.message ?? "The call failed" };
  return new ProviderError(err?.code === "content_refused" ? "content_refused" : "provider_error", opts);
}

// The fake company

type Plot = "success" | "refused" | "resume_slow" | "resume_gone";

/** Queued until the first number, running until the second, in milliseconds after the create call. */
const TIMELINE: Record<Plot, [queued: number, done: number]> = {
  success: [1_000, 4_000],
  refused: [1_000, 2_000],
  // Long enough to stop or kill the server mid-run and start it again. FakeEnv.resumeSlowMs sets
  // resume_slow's end, so e2e tests can run it in seconds.
  resume_slow: [3_000, 60_000],
  resume_gone: [3_000, 60_000],
};
/** resume_gone: the company forgets the call this long after it was made. */
const GONE_AFTER_MS = 10_000;

interface Plan {
  v: 1;
  /** Created at, epoch ms, on the fake's clock. */
  c: number;
  w: number;
  h: number;
  /** Seed for the gradient, so each image differs. */
  n: number;
  s: Plot;
  /** Done this long after it was made. In the id, so a server started with other options agrees. */
  d?: number;
}

const PREFIX = "img_";
const encode = (plan: Plan) => `${PREFIX}${Buffer.from(JSON.stringify(plan)).toString("base64url")}`;

function decode(id: string): Plan | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  try {
    const plan = JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8")) as Plan;
    return plan.v === 1 && plan.s in TIMELINE ? plan : undefined;
  } catch {
    return undefined;
  }
}

const errorBody = (status: number, code: string, message: string, headers?: Record<string, string>) => ({
  request: { method: "POST", path: "/v1/images" },
  response: { status, ...(headers && { headers }), body: { error: { code, message } } },
});

const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: errorBody(401, "invalid_api_key", "This key isn't valid."),
  forbidden: errorBody(403, "forbidden", "This key can't use this model."),
  invalid: errorBody(400, "invalid_request", "aspect_ratio must be one of 1:1, 3:4, 4:3, 9:16, 16:9."),
  rate_limited: errorBody(429, "rate_limited", "Too many requests.", { "retry-after": "12" }),
  server_error: errorBody(500, "server_error", "Something went wrong on our side."),
  unavailable: errorBody(503, "unavailable", "Busy. Try again soon."),
  // Accepted, then refused while it runs: the refusal arrives on a status read, not the create.
  refused: {
    request: { method: "GET", path: "/v1/images/{id}" },
    response: {
      status: 200,
      body: { status: "failed", error: { code: "content_refused", message: "This prompt was refused." } },
    },
  },
};

const canceledAt = (env: FakeEnv) => storeMap<string, number>(env, "fake:canceled");
const byIdempotencyKey = (env: FakeEnv) => storeMap<string, string>(env, "fake:idempotency");

export const resumableFake: FakeRoute = {
  providerId: "fake",
  hosts: [HOST],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    // Any key works, except one containing "invalid", like the Google fake.
    const forced = env.scenario ?? (!key || key.includes("invalid") ? "bad_key" : undefined);
    const failure = forced && forced !== "refused" ? fixtures[forced] : undefined;

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return failure ? replay(failure) : json(200, { data: [{ id: MODEL_ID }] });
    }
    if (request.method === "POST" && url.pathname === "/v1/images") {
      return failure ? replay(failure) : create(request, env, forced);
    }
    const one = /^\/v1\/images\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (!one) return json(404, { error: { code: "not_found", message: `No route for ${url.pathname}` } });
    const id = decodeURIComponent(one[1]!);
    if (one[2] && request.method === "POST") return cancel(id, env);
    if (!one[2] && request.method === "GET") return failure ? replay(failure) : status(id, env);
    return json(405, { error: { code: "method_not_allowed", message: "Not allowed here." } });
  },
};

async function create(request: Request, env: FakeEnv, forced: FakeScenario | undefined): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    prompt?: unknown;
    aspect_ratio?: unknown;
    size?: unknown;
  };
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) return json(400, { error: { code: "invalid_request", message: "prompt is required." } });
  const ratio = body.aspect_ratio ?? "1:1";
  if (typeof ratio !== "string" || !(RATIOS as readonly string[]).includes(ratio)) {
    return replay(fixtures.invalid!);
  }
  if (body.size !== undefined && body.size !== "1K") {
    return json(400, { error: { code: "invalid_request", message: "size must be 1K." } });
  }

  const scenario = forced ?? taggedScenario(prompt);
  const tagged = scenario && scenario !== "refused" ? fixtures[scenario] : undefined;
  if (tagged) return replay(tagged);

  // A create sent again with the same key gets the first call back, so it runs and bills once.
  const idem = request.headers.get("idempotency-key");
  const seen = idem ? byIdempotencyKey(env).get(idem) : undefined;
  if (seen) return json(200, await statusBody(seen, decode(seen)!, env));

  const [rw, rh] = ratio.split(":").map(Number) as [number, number];
  const long = Math.min(RESOLUTION_TIER_PX["1K"], env.maxEdge);
  const plot: Plot = scenario && scenario in TIMELINE ? (scenario as Plot) : "success";
  const plan: Plan = {
    v: 1,
    c: env.now(),
    w: Math.max(1, Math.round(rw >= rh ? long : (long * rw) / rh)),
    h: Math.max(1, Math.round(rw >= rh ? (long * rh) / rw : long)),
    n: (hashString(prompt) + env.nextSeed() * 7919) >>> 0,
    s: plot,
    ...(plot === "resume_slow" && { d: Math.max(TIMELINE.resume_slow[0], env.resumeSlowMs) }),
  };
  const id = encode(plan);
  if (idem) byIdempotencyKey(env).set(idem, id);
  return json(202, await statusBody(id, plan, env));
}

async function status(id: string, env: FakeEnv): Promise<Response> {
  const plan = decode(id);
  if (!plan || gone(plan, env)) return missing(id);
  return json(200, await statusBody(id, plan, env, { withOutput: true }));
}

async function cancel(id: string, env: FakeEnv): Promise<Response> {
  const plan = decode(id);
  if (!plan || gone(plan, env)) return missing(id);
  if (!canceledAt(env).has(id)) canceledAt(env).set(id, env.now());
  return json(200, await statusBody(id, plan, env));
}

const gone = (plan: Plan, env: FakeEnv) => plan.s === "resume_gone" && env.now() >= plan.c + GONE_AFTER_MS;

async function statusBody(
  id: string,
  plan: Plan,
  env: FakeEnv,
  opts: { withOutput?: boolean } = {},
): Promise<Record<string, unknown>> {
  const now = env.now();
  const [queued, planned] = TIMELINE[plan.s];
  const done = plan.d ?? planned;
  const startedAt = plan.c + queued;
  const doneAt = plan.c + done;
  const stoppedAt = canceledAt(env).get(id);
  const base = { id, created_at: new Date(plan.c).toISOString() };

  if (stoppedAt !== undefined && stoppedAt < doneAt) {
    return { ...base, status: "canceled", completed_at: new Date(stoppedAt).toISOString() };
  }
  if (now < startedAt) return { ...base, status: "queued" };
  const started = { ...base, started_at: new Date(startedAt).toISOString() };
  if (now < doneAt) {
    return {
      ...started,
      status: "running",
      progress: Math.round((100 * (now - startedAt)) / (doneAt - startedAt)),
    };
  }
  const completed = { ...started, completed_at: new Date(doneAt).toISOString() };
  if (plan.s === "refused") return { ...completed, ...(fixtures.refused!.response.body as object) };
  if (!opts.withOutput) return { ...completed, status: "succeeded" };
  const png = await gradientPng(plan.w, plan.h, plan.n);
  return {
    ...completed,
    status: "succeeded",
    output: {
      mime_type: "image/png",
      width: plan.w,
      height: plan.h,
      data: Buffer.from(png).toString("base64"),
    },
  };
}

function missing(id: string): Response {
  return json(404, { error: { code: "not_found", message: `No image with the id ${id}` } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

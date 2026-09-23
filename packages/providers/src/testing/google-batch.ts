import {
  badRequest,
  files,
  type GenerateBody,
  imageResponse,
  json,
  type PlannedImage,
  planImage,
  promptOf,
  storeMap,
} from "./google-common";
import { type FakeEnv, type FakeScenario, taggedScenario } from "./types";

// The fake Batch and Files APIs. A batch id carries its own plan (model, sizes, seeds, when it was
// made), so a batch sent before a server restart still answers after it: a short, realistic
// stand-in for a run that lives at Google, not in our process.

const HOST = "https://generativelanguage.googleapis.com";
const INLINE_LIMIT = 20 * 1024 * 1024;
const META_TYPE = "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch";
const OUTPUT_TYPE = "type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatchOutput";

type BatchScenario = "success" | "batch_slow" | "batch_partial" | "batch_expired" | "batch_failed";
const BATCH_SCENARIOS: readonly FakeScenario[] = [
  "batch_slow",
  "batch_partial",
  "batch_expired",
  "batch_failed",
];

/** Waiting, then running, in milliseconds. Each image finishes in turn while running. */
const TIMELINE: Record<BatchScenario, [pending: number, running: number]> = {
  success: [1_500, 2_500],
  batch_partial: [1_500, 2_500],
  batch_expired: [1_500, 2_500],
  batch_failed: [1_500, 0],
  batch_slow: [5_000, 25_000],
};

interface Spec {
  v: 1;
  /** Model id. */
  m: string;
  /** Display name. */
  d: string;
  /** Created at, epoch ms. */
  c: number;
  s: BatchScenario;
  /** One per request: key, then the image it will make. */
  r: { k: string; w: number; h: number; t: number; p: number; n: number }[];
}

const encode = (spec: Spec) => `fake${Buffer.from(JSON.stringify(spec)).toString("base64url")}`;

function decode(id: string): Spec | undefined {
  if (!id.startsWith("fake")) return undefined;
  try {
    const spec = JSON.parse(Buffer.from(id.slice(4), "base64url").toString("utf8")) as Spec;
    return spec.v === 1 && Array.isArray(spec.r) ? spec : undefined;
  } catch {
    return undefined;
  }
}

const canceled = (env: FakeEnv) => storeMap<string, number>(env, "google:batch-canceled");
const deleted = (env: FakeEnv) => storeMap<string, true>(env, "google:batch-deleted");
const created = (env: FakeEnv) => storeMap<string, true>(env, "google:batch-created");
const pendingUploads = (env: FakeEnv) =>
  storeMap<string, { mimeType: string; displayName: string }>(env, "google:uploads");

/** The batch and file routes, or undefined when the request is for something else. */
export function batchRoutes(request: Request, url: URL, env: FakeEnv): Promise<Response> | undefined {
  const path = url.pathname;
  if (path.startsWith("/upload/v1beta/files") && request.method === "POST") return upload(request, url, env);
  const file = /^\/v1beta\/(files\/[^/:]+)$/.exec(path);
  if (file && request.method === "DELETE") return removeFile(file[1]!, env);
  if (path === "/v1beta/batches" && request.method === "GET") return list(env);
  const create = /^\/v1beta\/models\/([^/:]+):batchGenerateContent$/.exec(path);
  if (create && request.method === "POST") return createBatch(decodeURIComponent(create[1]!), request, env);
  const one = /^\/v1beta\/(batches\/[^/:]+)(:cancel)?$/.exec(path);
  if (!one) return undefined;
  const name = one[1]!;
  if (one[2] && request.method === "POST") return cancel(name, env);
  if (!one[2] && request.method === "GET") return get(name, env);
  if (!one[2] && request.method === "DELETE") return remove(name, env);
  return undefined;
}

interface CreateBody {
  batch?: {
    displayName?: string;
    inputConfig?: { requests?: { requests?: { request?: GenerateBody; metadata?: { key?: string } }[] } };
  };
}

async function createBatch(modelId: string, request: Request, env: FakeEnv): Promise<Response> {
  const raw = await request.text();
  if (raw.length > INLINE_LIMIT) {
    return badRequest(`Request payload size exceeds the limit: ${INLINE_LIMIT} bytes.`);
  }
  const body = JSON.parse(raw) as CreateBody;
  const displayName = body.batch?.displayName;
  const requests = body.batch?.inputConfig?.requests?.requests ?? [];
  if (!displayName) return badRequest("* batch.display_name: display_name is required", "batch.display_name");
  if (!requests.length) return badRequest("* batch.input_config: no requests", "batch.input_config");

  const plans: Spec["r"] = [];
  for (const [i, item] of requests.entries()) {
    const planned = planImage(modelId, item.request ?? {}, env, (name) => files(env).get(name));
    if (planned instanceof Response) return planned;
    plans.push(toPlan(item.metadata?.key ?? String(i), planned));
  }
  const tagged = env.scenario ?? taggedScenario(promptOf(requests[0]?.request ?? {}));
  const scenario: BatchScenario =
    tagged && BATCH_SCENARIOS.includes(tagged) ? (tagged as BatchScenario) : "success";
  const spec: Spec = { v: 1, m: modelId, d: displayName, c: env.now(), s: scenario, r: plans };
  const name = `batches/${encode(spec)}`;
  created(env).set(name, true);
  return json(200, await operation(name, spec, env));
}

const toPlan = (k: string, p: PlannedImage): Spec["r"][number] => ({
  k,
  w: p.width,
  h: p.height,
  t: p.tokens,
  p: p.promptTokens,
  n: p.seed,
});

async function get(name: string, env: FakeEnv): Promise<Response> {
  const spec = decode(name.slice("batches/".length));
  if (!spec || deleted(env).has(name)) return missing(name);
  return json(200, await operation(name, spec, env));
}

async function cancel(name: string, env: FakeEnv): Promise<Response> {
  const spec = decode(name.slice("batches/".length));
  if (!spec || deleted(env).has(name)) return missing(name);
  if (!canceled(env).has(name)) canceled(env).set(name, env.now());
  return json(200, {});
}

async function remove(name: string, env: FakeEnv): Promise<Response> {
  if (!decode(name.slice("batches/".length)) || deleted(env).has(name)) return missing(name);
  deleted(env).set(name, true);
  return json(200, {});
}

async function list(env: FakeEnv): Promise<Response> {
  const operations = [];
  for (const name of created(env).keys()) {
    const spec = decode(name.slice("batches/".length));
    if (spec && !deleted(env).has(name))
      operations.push(await operation(name, spec, env, { withOutput: false }));
  }
  return json(200, { operations });
}

type Outcome = "ok" | "error" | "blocked";

/** Batch partial fails every other image: an internal error, then a safety block. */
const outcomeOf = (spec: Spec, i: number): Outcome =>
  spec.s !== "batch_partial" || i % 2 === 0 ? "ok" : i % 4 === 1 ? "error" : "blocked";

async function operation(
  name: string,
  spec: Spec,
  env: FakeEnv,
  opts: { withOutput?: boolean } = {},
): Promise<Record<string, unknown>> {
  const now = env.now();
  const [pending, running] = TIMELINE[spec.s];
  const startedAt = spec.c + pending;
  const finishAt = (i: number) => startedAt + (running * (i + 1)) / spec.r.length;
  const lastFinish = finishAt(spec.r.length - 1);
  const canceledAt = canceled(env).get(name);

  let state: string;
  let cutoff = now;
  let error: Record<string, unknown> | undefined;
  if (canceledAt !== undefined && canceledAt < lastFinish && canceledAt <= now) {
    state = "CANCELLED";
    cutoff = canceledAt;
    error = { code: 1, message: "The operation was cancelled." };
  } else if (now < startedAt) {
    state = "PENDING";
  } else if (spec.s === "batch_failed") {
    state = "FAILED";
    cutoff = startedAt - 1;
    error = { code: 13, message: "Internal error encountered." };
  } else if (now < lastFinish) {
    state = "RUNNING";
  } else if (spec.s === "batch_expired") {
    state = "EXPIRED";
    cutoff = startedAt - 1;
  } else {
    state = "SUCCEEDED";
  }

  const finished = spec.r.map((_, i) => finishAt(i) <= cutoff);
  const outcomes = spec.r.map((_, i) => outcomeOf(spec, i));
  const ok = finished.filter((f, i) => f && outcomes[i] === "ok").length;
  const failed =
    state === "EXPIRED" || state === "FAILED"
      ? spec.r.length
      : finished.filter((f, i) => f && outcomes[i] !== "ok").length;
  const terminal = !["PENDING", "RUNNING"].includes(state);

  let output: Record<string, unknown>[] | undefined;
  if (terminal && opts.withOutput !== false && state !== "EXPIRED" && state !== "FAILED") {
    output = [];
    for (const [i, plan] of spec.r.entries()) {
      if (!finished[i]) continue;
      const metadata = { key: plan.k };
      if (outcomes[i] === "error")
        output.push({ error: { code: 13, message: "Internal error encountered." }, metadata });
      else if (outcomes[i] === "blocked")
        output.push({ response: { promptFeedback: { blockReason: "SAFETY" } }, metadata });
      else output.push({ response: await imageResponse(fromPlan(spec, plan), { env }), metadata });
    }
  }

  const inlined = output && { inlinedResponses: { inlinedResponses: output } };
  return {
    name,
    metadata: {
      "@type": META_TYPE,
      model: `models/${spec.m}`,
      displayName: spec.d,
      state: `BATCH_STATE_${state}`,
      createTime: new Date(spec.c).toISOString(),
      updateTime: new Date(Math.min(now, terminal ? cutoff : now)).toISOString(),
      ...(terminal && { endTime: new Date(Math.max(spec.c, cutoff)).toISOString() }),
      batchStats: {
        requestCount: String(spec.r.length),
        successfulRequestCount: String(ok),
        failedRequestCount: String(failed),
        pendingRequestCount: String(spec.r.length - ok - failed),
      },
      ...(inlined && { output: inlined }),
    },
    ...(terminal && { done: true }),
    ...(inlined && { response: { "@type": OUTPUT_TYPE, ...inlined } }),
    ...(error && { error }),
  };
}

const fromPlan = (spec: Spec, plan: Spec["r"][number]): PlannedImage => ({
  modelId: spec.m,
  width: plan.w,
  height: plan.h,
  tokens: plan.t,
  promptTokens: plan.p,
  seed: plan.n,
});

function missing(name: string): Response {
  return json(404, {
    error: { code: 404, message: `Requested entity was not found: ${name}`, status: "NOT_FOUND" },
  });
}

// Files API: a resumable upload in two calls, start then "upload, finalize".
async function upload(request: Request, url: URL, env: FakeEnv): Promise<Response> {
  const command = request.headers.get("x-goog-upload-command") ?? "";
  if (command === "start") {
    const mimeType = request.headers.get("x-goog-upload-header-content-type") ?? "application/octet-stream";
    const meta = (await request.json().catch(() => ({}))) as { file?: { display_name?: string } };
    const id = `fake-u${env.nextSeed()}`;
    pendingUploads(env).set(id, { mimeType, displayName: meta.file?.display_name ?? id });
    return json(
      200,
      {},
      {
        "x-goog-upload-url": `${HOST}/upload/v1beta/files?upload_id=${id}`,
        "x-goog-upload-status": "active",
      },
    );
  }
  const id = url.searchParams.get("upload_id") ?? "";
  const started = pendingUploads(env).get(id);
  if (!started || !command.includes("finalize")) return badRequest("Unknown or unfinished upload.");
  pendingUploads(env).delete(id);
  const bytes = new Uint8Array(await request.arrayBuffer());
  const name = `files/fake-f${env.nextSeed()}`;
  files(env).set(name, { mimeType: started.mimeType, bytes, displayName: started.displayName });
  return json(200, {
    file: {
      name,
      displayName: started.displayName,
      mimeType: started.mimeType,
      sizeBytes: String(bytes.byteLength),
      uri: `${HOST}/v1beta/${name}`,
      state: "ACTIVE",
    },
  });
}

async function removeFile(name: string, env: FakeEnv): Promise<Response> {
  if (!files(env).delete(name)) return missing(name);
  return json(200, {});
}

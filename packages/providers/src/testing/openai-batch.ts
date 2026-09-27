import moderationOutput from "../openai/__fixtures__/moderation-output.json";
import {
  badRequest,
  familyOf,
  type ImageRequest,
  imagesResponse,
  json,
  type Planned,
  planImages,
} from "./openai-common";
import { probeImage } from "./png";
import { type FakeEnv, type FakeScenario, storeMap, taggedScenario } from "./types";

// The fake Files and Batch APIs. A batch id carries its own plan (model, sizes, tokens, seeds, when
// it was made), and a results file id carries its batch's, so a batch sent before a server restart
// still answers after it: a short, realistic stand-in for a run that lives at OpenAI.

type BatchScenario = "success" | "batch_slow" | "batch_partial" | "batch_expired" | "batch_failed";
const BATCH_SCENARIOS: readonly FakeScenario[] = [
  "batch_slow",
  "batch_partial",
  "batch_expired",
  "batch_failed",
];

/** Validating, then in progress, in milliseconds. Each image finishes in turn while in progress. */
const TIMELINE: Record<BatchScenario, [validating: number, running: number]> = {
  success: [1_500, 2_500],
  batch_partial: [1_500, 2_500],
  batch_expired: [1_500, 2_500],
  batch_failed: [1_500, 0],
  batch_slow: [5_000, 25_000],
};
const WINDOW_MS = 24 * 3_600_000;
const ENDPOINTS = ["/v1/images/generations", "/v1/images/edits"];

interface Spec {
  v: 1;
  /** Endpoint. */
  e: string;
  /** Created at, epoch ms. */
  c: number;
  s: BatchScenario;
  meta: Record<string, string>;
  /** One per line: custom_id, then what the line makes. */
  r: {
    k: string;
    m: string;
    w: number;
    h: number;
    dw: number;
    dh: number;
    t: number;
    p: number;
    i: number;
    q: string;
    n: number;
  }[];
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode<T>(text: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}
const specOf = (id: string) =>
  id.startsWith("batch_fake") ? decode<Spec>(id.slice("batch_fake".length)) : undefined;

const uploads = (env: FakeEnv) => storeMap<string, { text: string; filename: string }>(env, "openai:uploads");
const canceled = (env: FakeEnv) => storeMap<string, number>(env, "openai:batch-canceled");
const created = (env: FakeEnv) => storeMap<string, true>(env, "openai:batch-created");
const deletedFiles = (env: FakeEnv) => storeMap<string, true>(env, "openai:files-deleted");

/** The file and batch routes, or undefined when the request is for something else. */
export function openAiBatchRoutes(request: Request, url: URL, env: FakeEnv): Promise<Response> | undefined {
  const path = url.pathname;
  if (path === "/v1/files" && request.method === "POST") return upload(request, env);
  const file = /^\/v1\/files\/([^/]+)(\/content)?$/.exec(path);
  if (file?.[2] && request.method === "GET") return content(file[1]!, env);
  if (file && !file[2] && request.method === "DELETE") return removeFile(file[1]!, env);
  if (path === "/v1/batches" && request.method === "POST") return create(request, env);
  if (path === "/v1/batches" && request.method === "GET") return list(url, env);
  const one = /^\/v1\/batches\/([^/]+)(\/cancel)?$/.exec(path);
  if (!one) return undefined;
  if (one[2] && request.method === "POST") return cancel(one[1]!, env);
  if (!one[2] && request.method === "GET") return get(one[1]!, env);
  return undefined;
}

async function upload(request: Request, env: FakeEnv): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (form.get("purpose") !== "batch") return badRequest("Only purpose=batch is faked.", "purpose");
  if (!file || typeof file === "string") return badRequest("Missing required parameter: 'file'.", "file");
  if (file.size > 200_000_000) return badRequest("Files must be under 200 MB.", "file");
  const id = `file-${env.nextSeed().toString(36)}${Math.floor(env.now()).toString(36)}`;
  uploads(env).set(id, { text: await file.text(), filename: file.name });
  return json(200, {
    id,
    object: "file",
    bytes: file.size,
    created_at: Math.floor(env.now() / 1000),
    filename: file.name,
    purpose: "batch",
  });
}

async function removeFile(id: string, env: FakeEnv): Promise<Response> {
  uploads(env).delete(id);
  deletedFiles(env).set(id, true);
  return json(200, { id, object: "file", deleted: true });
}

interface Line {
  custom_id?: unknown;
  method?: unknown;
  url?: unknown;
  body?: ImageRequest & { images?: { image_url?: string }[] };
}

async function create(request: Request, env: FakeEnv): Promise<Response> {
  const body = (await request.json()) as {
    input_file_id?: string;
    endpoint?: string;
    completion_window?: string;
    metadata?: Record<string, string>;
  };
  if (body.completion_window !== "24h")
    return badRequest("completion_window must be 24h.", "completion_window");
  if (!body.endpoint || !ENDPOINTS.includes(body.endpoint))
    return badRequest("Unsupported endpoint.", "endpoint");
  const input = body.input_file_id ? uploads(env).get(body.input_file_id) : undefined;
  if (!input)
    return json(404, {
      error: {
        message: `No such File object: ${body.input_file_id}`,
        type: "invalid_request_error",
        param: "input_file_id",
        code: null,
      },
    });

  const lines = input.text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
  if (!lines.length) return badRequest("The input file has no requests.", "input_file_id");
  const ids = new Set<string>();
  const models = new Set<string>();
  const plans: Spec["r"] = [];
  for (const line of lines) {
    if (typeof line.custom_id !== "string" || ids.has(line.custom_id))
      return badRequest("Each line needs a unique custom_id.", "input_file_id");
    ids.add(line.custom_id);
    if (line.method !== "POST" || line.url !== body.endpoint)
      return badRequest("Every line must POST to the batch's endpoint.", "input_file_id");
    const req = line.body ?? {};
    models.add(String(req.model));
    // Batch lines are JSON, so an edit carries its images as data URLs in images[].
    const inputs = [];
    for (const image of req.images ?? []) {
      const data = /^data:image\/[a-z]+;base64,(.+)$/.exec(image.image_url ?? "")?.[1];
      const probed = data ? probeImage(new Uint8Array(Buffer.from(data, "base64"))) : null;
      if (!probed) return badRequest("images[].image_url must be an image data URL.", "images");
      inputs.push(probed);
    }
    if (body.endpoint === "/v1/images/edits" && !inputs.length)
      return badRequest("An edit needs images.", "images");
    const planned = planImages(req, env, inputs);
    if (planned instanceof Response) return planned;
    plans.push(toPlan(line.custom_id, planned));
  }
  if (models.size > 1) return badRequest("A batch file must use one model.", "input_file_id");
  const [model] = [...models];
  if (!familyOf(model ?? "")) return badRequest(`The model ${model} can't run in a batch here.`, "model");

  const tagged = env.scenario ?? taggedScenario(String(lines[0]?.body?.prompt ?? ""));
  const scenario: BatchScenario =
    tagged && BATCH_SCENARIOS.includes(tagged) ? (tagged as BatchScenario) : "success";
  const spec: Spec = {
    v: 1,
    e: body.endpoint,
    c: env.now(),
    s: scenario,
    meta: body.metadata ?? {},
    r: plans,
  };
  const id = `batch_fake${encode(spec)}`;
  created(env).set(id, true);
  return json(200, batchObject(id, spec, env));
}

function toPlan(k: string, p: Planned): Spec["r"][number] {
  return {
    k,
    m: p.model,
    w: p.width,
    h: p.height,
    dw: p.drawWidth,
    dh: p.drawHeight,
    t: p.outputTokens,
    p: p.textTokens,
    i: p.imageTokens,
    q: p.quality,
    n: p.seed,
  };
}

async function get(id: string, env: FakeEnv): Promise<Response> {
  const spec = specOf(id);
  if (!spec)
    return json(404, {
      error: {
        message: `No batch found with id '${id}'.`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  return json(200, batchObject(id, spec, env));
}

async function cancel(id: string, env: FakeEnv): Promise<Response> {
  const spec = specOf(id);
  if (!spec)
    return json(404, {
      error: {
        message: `No batch found with id '${id}'.`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  const state = timeline(id, spec, env);
  if (["completed", "failed", "expired", "cancelled"].includes(state.status))
    return badRequest(`Cannot cancel a batch with status '${state.status}'.`);
  if (!canceled(env).has(id)) canceled(env).set(id, env.now());
  return json(200, batchObject(id, spec, env));
}

async function list(url: URL, env: FakeEnv): Promise<Response> {
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const after = url.searchParams.get("after");
  const all = [...created(env).keys()].reverse();
  const start = after ? all.indexOf(after) + 1 : 0;
  const page = all.slice(start, start + limit);
  const data = page.map((id) => batchObject(id, specOf(id)!, env));
  return json(200, {
    object: "list",
    data,
    first_id: page[0] ?? null,
    last_id: page.at(-1) ?? null,
    has_more: start + limit < all.length,
  });
}

type Status =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

/** Where a batch is on its timeline now, and how many lines have finished. */
function timeline(id: string, spec: Spec, env: FakeEnv): { status: Status; finished: number } {
  const [validating, running] = TIMELINE[spec.s];
  const total = spec.r.length;
  const at = (t: number) => t - spec.c;
  const doneBy = (t: number) =>
    at(t) < validating
      ? 0
      : running <= 0
        ? total
        : Math.min(total, Math.floor(((at(t) - validating) / running) * total));
  const canceledAt = canceled(env).get(id);
  if (canceledAt !== undefined) {
    const finished = doneBy(canceledAt);
    return { status: env.now() - canceledAt < 1_000 ? "cancelling" : "cancelled", finished };
  }
  if (spec.s === "batch_failed")
    return at(env.now()) < validating
      ? { status: "validating", finished: 0 }
      : { status: "failed", finished: 0 };
  if (at(env.now()) < validating) return { status: "validating", finished: 0 };
  if (at(env.now()) < validating + running) return { status: "in_progress", finished: doneBy(env.now()) };
  if (spec.s === "batch_expired") return { status: "expired", finished: 0 };
  return { status: "completed", finished: total };
}

/** Which finished lines fail: every other one in a partial batch. */
const fails = (spec: Spec, index: number) => spec.s === "batch_partial" && index % 2 === 1;

function batchObject(id: string, spec: Spec, env: FakeEnv): Record<string, unknown> {
  const { status, finished } = timeline(id, spec, env);
  const terminal = ["completed", "expired", "cancelled", "failed"].includes(status);
  const failed = spec.r.slice(0, finished).filter((_, i) => fails(spec, i)).length;
  // Only an expired batch reports its unfinished lines; a canceled one leaves them out.
  const expired = status === "expired";
  const unfinished = expired ? spec.r.length - finished : 0;
  const ok = finished - failed;
  const fileOf = (kind: "out" | "err") => `file-${kind}${encode({ id, finished, kind, expired })}`;
  const seconds = (ms: number) => Math.floor(ms / 1000);
  return {
    id,
    object: "batch",
    endpoint: spec.e,
    input_file_id: "file-input",
    completion_window: "24h",
    status,
    output_file_id: terminal && ok > 0 ? fileOf("out") : null,
    error_file_id: terminal && failed + unfinished > 0 ? fileOf("err") : null,
    created_at: seconds(spec.c),
    expires_at: seconds(spec.c + WINDOW_MS),
    request_counts: { total: spec.r.length, completed: ok, failed: failed + unfinished },
    metadata: spec.meta,
    ...(status === "failed" && {
      errors: {
        object: "list",
        data: [
          {
            code: "invalid_request",
            message: "The batch input file could not be processed.",
            param: null,
            line: 1,
          },
        ],
      },
    }),
  };
}

/** A results file, rebuilt from its batch's plan: images for "out", errors for "err". */
async function content(fileId: string, env: FakeEnv): Promise<Response> {
  const upload = uploads(env).get(fileId);
  if (upload) return new Response(upload.text, { headers: { "content-type": "application/jsonl" } });
  const match = /^file-(out|err)(.+)$/.exec(fileId);
  const ref = match
    ? decode<{ id: string; finished: number; kind: "out" | "err"; expired: boolean }>(match[2]!)
    : undefined;
  const spec = ref && specOf(ref.id);
  if (!ref || !spec || deletedFiles(env).has(fileId))
    return json(404, {
      error: {
        message: `No such File object: ${fileId}`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });

  const lines: string[] = [];
  for (const [i, plan] of spec.r.entries()) {
    const done = i < ref.finished;
    if (ref.kind === "out" && done && !fails(spec, i)) {
      const planned: Planned = {
        model: plan.m,
        n: 1,
        width: plan.w,
        height: plan.h,
        drawWidth: plan.dw,
        drawHeight: plan.dh,
        outputTokens: plan.t,
        textTokens: plan.p,
        imageTokens: plan.i,
        quality: plan.q,
        seed: plan.n,
      };
      const body = await imagesResponse(planned, {});
      lines.push(
        JSON.stringify({
          id: `batch_req_${i}`,
          custom_id: plan.k,
          response: { status_code: 200, request_id: `req_${i}`, body },
          error: null,
        }),
      );
    } else if (ref.kind === "err" && done && fails(spec, i)) {
      lines.push(
        JSON.stringify({
          id: `batch_req_${i}`,
          custom_id: plan.k,
          response: { status_code: 400, request_id: `req_${i}`, body: moderationOutput.response.body },
          error: null,
        }),
      );
    } else if (ref.kind === "err" && !done && ref.expired) {
      lines.push(
        JSON.stringify({
          id: `batch_req_${i}`,
          custom_id: plan.k,
          response: null,
          error: {
            code: "batch_expired",
            message: "This request could not be executed before the completion window expired.",
          },
        }),
      );
    }
  }
  // Line order isn't guaranteed at OpenAI, so the fake doesn't keep it either.
  return new Response(`${lines.reverse().join("\n")}\n`, {
    headers: { "content-type": "application/jsonl" },
  });
}

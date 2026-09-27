import badKey from "../higgsfield/__fixtures__/bad-key.json";
import cancelStarted from "../higgsfield/__fixtures__/cancel-started.json";
import concurrency from "../higgsfield/__fixtures__/concurrency.json";
import estimate from "../higgsfield/__fixtures__/estimate.json";
import estimateDescription from "../higgsfield/__fixtures__/estimate-description.json";
import invalid from "../higgsfield/__fixtures__/invalid.json";
import modelNotFound from "../higgsfield/__fixtures__/model-not-found.json";
import noCredits from "../higgsfield/__fixtures__/no-credits.json";
import nsfw from "../higgsfield/__fixtures__/nsfw.json";
import serverError from "../higgsfield/__fixtures__/server-error.json";
import styles from "../higgsfield/__fixtures__/styles.json";
import unavailable from "../higgsfield/__fixtures__/unavailable.json";
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

// A stand-in for api.higgsfield.ai and its image host. It checks every request against each
// workflow's documented JSON schema, written out below rather than read from our manifests, so a
// manifest that offers something a workflow doesn't take fails the conformance suite. It's also
// stricter than the real API: an unknown field is refused, so a typo can't slip through.
//
// A request id carries its own plan (when it was made, the size, the seed), so a status read still
// answers after a server restart with no stored state, like the other fakes.

const API = "api.higgsfield.ai";
const CDN = "d3u0tzju9qaucj.cloudfront.net";

type Rule =
  | { type: "string"; enum?: string[]; minLength?: number; maxLength?: number; uuid?: boolean }
  | { type: "number" | "integer"; min?: number; max?: number; enum?: number[] }
  | { type: "boolean" };

interface Workflow {
  fields: Record<string, Rule>;
  /** Longest edge per resolution value, for the fake image. Absent: a fixed size. */
  edges?: Record<string, number>;
  /** Default ratio when none is sent. */
  ratio: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unit = { type: "number", min: 0, max: 1 } as const;
const SOUL_RATIOS = ["9:16", "16:9", "4:3", "3:4", "1:1", "2:3", "3:2"];
const SOUL_EDGES = { "720p": 1280, "1080p": 1920 };
const K_EDGES = { "1k": 1024, "2k": 2048, "4k": 4096 };
const STUDIO_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
const RECRAFT_RATIOS = [
  "1:1",
  "2:1",
  "1:2",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "6:10",
  "14:10",
  "10:14",
  "16:9",
  "9:16",
];
const QWEN_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "7:9", "9:7", "9:16", "16:9", "21:9"];
const soulSeed = { type: "integer", min: 1, max: 1_000_000 } as const;
const wideSeed = { type: "integer", min: 0, max: 2_147_483_647 } as const;
const recraft = (resolution: string): Workflow => ({
  ratio: "1:1",
  edges: K_EDGES,
  fields: {
    prompt: { type: "string", minLength: 1, maxLength: 10_000 },
    resolution: { type: "string", enum: [resolution] },
    aspect_ratio: { type: "string", enum: RECRAFT_RATIOS },
    output_format: { type: "string", enum: ["jpg", "png", "webp"] },
  },
});
const studio = (qualities: string[]): Workflow => ({
  ratio: "1:1",
  edges: K_EDGES,
  fields: {
    prompt: { type: "string", minLength: 1, maxLength: 5000 },
    quality: { type: "string", enum: qualities },
    moderation: { type: "string", enum: ["auto", "low"] },
    resolution: { type: "string", enum: ["1k", "2k", "4k"] },
    aspect_ratio: { type: "string", enum: STUDIO_RATIOS },
    enhance_prompt: { type: "boolean" },
  },
});

/** From each workflow's JSON schema on docs.higgsfield.ai, 2026-09-27. Uploads aren't faked. */
const WORKFLOWS: Record<string, Workflow> = {
  "higgsfield-ai/soul/standard": {
    ratio: "4:3",
    edges: SOUL_EDGES,
    fields: {
      prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: SOUL_RATIOS },
      enhance_prompt: { type: "boolean" },
      style_id: { type: "string", uuid: true },
      style_strength: unit,
      resolution: { type: "string", enum: ["720p", "1080p"] },
      seed: soulSeed,
      custom_reference_id: { type: "string", uuid: true },
      custom_reference_strength: unit,
      batch_size: { type: "integer", enum: [1, 4] },
    },
  },
  "higgsfield-ai/soul/v2/standard": {
    ratio: "1:1",
    edges: SOUL_EDGES,
    fields: {
      prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: SOUL_RATIOS },
      resolution: { type: "string", enum: ["720p", "1080p"] },
      enhance_prompt: { type: "boolean" },
      custom_reference_id: { type: "string", uuid: true },
      custom_reference_strength: unit,
      style_id: { type: "string", uuid: true },
      style_strength: unit,
      seed: soulSeed,
      batch_size: { type: "integer", enum: [1, 4] },
    },
  },
  "higgsfield-ai/soul/cinema": {
    ratio: "1:1",
    edges: SOUL_EDGES,
    fields: {
      prompt: { type: "string" },
      aspect_ratio: { type: "string", enum: SOUL_RATIOS },
      enhance_prompt: { type: "boolean" },
      resolution: { type: "string", enum: ["720p", "1080p"] },
      custom_reference_id: { type: "string", uuid: true },
      custom_reference_strength: unit,
      seed: soulSeed,
      batch_size: { type: "integer", enum: [1, 4] },
    },
  },
  "marketing-studio/image": studio(["low", "medium", "high"]),
  "marketing-studio/image/flare": studio(["low", "medium", "high", "xhigh", "max"]),
  "marketing-studio/image/sunburst": studio(["low", "medium", "high", "xhigh", "max"]),
  "xai/grok-imagine-image-2.0": {
    ratio: "1:1",
    edges: K_EDGES,
    fields: {
      prompt: { type: "string" },
      quality: { type: "string", enum: ["low", "medium"] },
      resolution: { type: "string", enum: ["1k", "2k"] },
      aspect_ratio: {
        type: "string",
        enum: ["auto", "1:1", "1:2", "2:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
      },
    },
  },
  "recraft/v4.1/text-to-image": recraft("1k"),
  "recraft/v4.1/utility/text-to-image": recraft("1k"),
  "recraft/v4.1/pro/text-to-image": recraft("2k"),
  "recraft/v4.1/utility/pro/text-to-image": recraft("2k"),
  "alibaba/qwen-image-3/text-to-image": {
    ratio: "1:1",
    edges: { "1k": 1024, "2k": 1536 },
    fields: {
      seed: wideSeed,
      prompt: { type: "string", minLength: 1 },
      resolution: { type: "string", enum: ["1k", "2k"] },
      aspect_ratio: { type: "string", enum: QWEN_RATIOS },
      prompt_extend: { type: "boolean" },
      enable_thinking: { type: "boolean" },
      negative_prompt: { type: "string" },
      prompt_extend_mode: { type: "string", enum: ["direct", "agent"] },
    },
  },
  "ideogram/v4.0": {
    ratio: "1:1",
    fields: {
      prompt: { type: "string", minLength: 2, maxLength: 2048 },
      aspect_ratio: {
        type: "string",
        enum: [
          "1:1",
          "1:2",
          "2:1",
          "2:3",
          "3:2",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "5:8",
          "8:5",
          "3:4",
          "4:3",
          "9:22",
          "22:9",
          "9:23",
          "23:9",
          "3:8",
          "8:3",
          "5:12",
          "12:5",
          "1:3",
          "3:1",
        ],
      },
      rendering_speed: { type: "string", enum: ["TURBO", "DEFAULT", "QUALITY"] },
    },
  },
  "z-image/turbo": {
    ratio: "1:1",
    edges: { "1k": 1024, "2k": 2048 },
    fields: {
      seed: wideSeed,
      prompt: { type: "string", minLength: 1, maxLength: 800 },
      resolution: { type: "string", enum: ["1k", "2k"] },
      aspect_ratio: { type: "string", enum: QWEN_RATIOS },
      prompt_extend: { type: "boolean" },
    },
  },
};

// Errors a create call can answer with, by #fake: tag. A refusal arrives later, on a status read.
const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden: modelNotFound,
  no_billing: noCredits,
  invalid,
  rate_limited: concurrency,
  server_error: serverError,
  unavailable,
  refused: nsfw,
};

type Plot = "success" | "refused" | "foreign_asset" | "slow";

/** Queued until the first number, running until the second, in milliseconds after the create call. */
const TIMELINE: Record<Plot, [queued: number, done: number]> = {
  success: [1_000, 4_000],
  refused: [1_000, 2_000],
  foreign_asset: [1_000, 2_000],
  slow: [3_000, 30_000],
};

interface Plan {
  v: 1;
  c: number;
  w: number;
  h: number;
  n: number;
  s: Plot;
  /** Done this long after it was made, when not the timeline's own. */
  d?: number;
}

const PREFIX = "hf-";
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

const canceledAt = (env: FakeEnv) => storeMap<string, number>(env, "higgsfield:canceled");

export const higgsfieldFake: FakeRoute = {
  providerId: "higgsfield",
  hosts: [API, CDN],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    if (url.host === CDN) return image(url, env);

    const key = /^Key (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    // Any key works, except one containing "invalid", like the other fakes.
    const forced = env.scenario ?? (!key || key.includes("invalid") ? "bad_key" : undefined);
    const failure = forced && forced !== "refused" ? fixtures[forced] : undefined;
    const path = url.pathname.replace(/^\//, "");

    if (request.method === "GET" && path === "v1/text2image/soul-styles") {
      return failure ? replay(failure) : replay(styles);
    }
    const status = /^requests\/([^/]+)\/(status|cancel)$/.exec(path);
    if (status) {
      const id = decodeURIComponent(status[1]!);
      if (status[2] === "status" && request.method === "GET") return statusOf(id, env);
      if (status[2] === "cancel" && request.method === "POST") return cancel(id, env);
      return detail(405, "Method Not Allowed");
    }
    if (request.method !== "POST") return detail(404, "Not Found");

    const estimating = path.startsWith("estimate/");
    const workflow = WORKFLOWS[estimating ? path.slice("estimate/".length) : path];
    if (!workflow) return detail(404, "Not Found");
    if (failure) return replay(failure);

    const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const invalidBody = validate(workflow, body);
    if (invalidBody) return invalidBody;
    if (estimating) return estimateOf(path, body!);

    const prompt = String(body!.prompt);
    const scenario = forced ?? taggedScenario(prompt);
    const tagged = scenario && scenario !== "refused" ? fixtures[scenario] : undefined;
    if (tagged) return replay(tagged);
    return create(workflow, body!, prompt, scenario, env);
  },
};

/**
 * Live answers from 2026-09-27, so fake mode prices like a real key: SOUL V2 at 720p ($0.004) and
 * 1080p ($0.006), and a token-priced workflow's description with no amount. The rest answer like
 * SOUL V2 at 720p.
 */
function estimateOf(path: string, body: Record<string, unknown>): Response {
  if (
    path === "estimate/marketing-studio/image/flare" ||
    path === "estimate/marketing-studio/image/sunburst"
  ) {
    return replay(estimateDescription);
  }
  if (body.resolution === "1080p") {
    const { response } = estimate;
    return replay({
      ...estimate,
      response: { ...response, body: { type: "estimate", credits: "0.090", usd: "0.006", discount: null } },
    });
  }
  return replay(estimate);
}

function create(
  workflow: Workflow,
  body: Record<string, unknown>,
  prompt: string,
  scenario: FakeScenario | undefined,
  env: FakeEnv,
): Response {
  const ratio =
    typeof body.aspect_ratio === "string" && body.aspect_ratio !== "auto"
      ? body.aspect_ratio
      : workflow.ratio;
  const [rw, rh] = ratio.split(":").map(Number) as [number, number];
  const edge = workflow.edges?.[String(body.resolution)] ?? 1024;
  const long = Math.min(edge, env.maxEdge);
  const plot: Plot = scenario && scenario in TIMELINE ? (scenario as Plot) : "success";
  const plan: Plan = {
    v: 1,
    c: env.now(),
    w: Math.max(1, Math.round(rw >= rh ? long : (long * rw) / rh)),
    h: Math.max(1, Math.round(rw >= rh ? (long * rh) / rw : long)),
    n: (hashString(prompt) + env.nextSeed() * 7919) >>> 0,
    s: plot,
    ...(plot === "slow" && { d: Math.max(TIMELINE.slow[0], env.slowMs) }),
  };
  const id = encode(plan);
  return json(200, { status: "queued", request_id: id, ...urlsOf(id) });
}

const urlsOf = (id: string) => ({
  status_url: `https://${API}/requests/${encodeURIComponent(id)}/status`,
  cancel_url: `https://${API}/requests/${encodeURIComponent(id)}/cancel`,
});

/** The request's state on the fake's clock, from its plan. */
function stateOf(id: string, plan: Plan, env: FakeEnv): "queued" | "in_progress" | "done" | "canceled" {
  const [queued, planned] = TIMELINE[plan.s];
  const doneAt = plan.c + (plan.d ?? planned);
  const stopped = canceledAt(env).get(id);
  if (stopped !== undefined) return "canceled";
  const now = env.now();
  if (now < plan.c + queued) return "queued";
  return now < doneAt ? "in_progress" : "done";
}

function statusOf(id: string, env: FakeEnv): Response {
  const plan = decode(id);
  if (!plan) return detail(404, "Not Found");
  const base = { request_id: id, ...urlsOf(id) };
  const state = stateOf(id, plan, env);
  if (state !== "done") return json(200, { status: state, ...base });
  if (plan.s === "refused") return json(200, { ...base, ...(nsfw.response.body as object) });
  const host = plan.s === "foreign_asset" ? "files.unknown-host.example" : CDN;
  return json(200, {
    status: "completed",
    ...base,
    images: [{ url: `https://${host}/outputs/${encodeURIComponent(id)}/0.png` }],
  });
}

function cancel(id: string, env: FakeEnv): Response {
  const plan = decode(id);
  if (!plan) return detail(404, "Not Found");
  const state = stateOf(id, plan, env);
  if (state === "canceled") return new Response(null, { status: 202 });
  // Only a request that hasn't started can be canceled (and it's refunded).
  if (state !== "queued") return replay(cancelStarted);
  canceledAt(env).set(id, env.now());
  return new Response(null, { status: 202 });
}

async function image(url: URL, env: FakeEnv): Promise<Response> {
  const id = /^\/outputs\/([^/]+)\/0\.png$/.exec(url.pathname)?.[1];
  const plan = id ? decode(decodeURIComponent(id)) : undefined;
  if (!id || !plan || stateOf(decodeURIComponent(id), plan, env) !== "done")
    return new Response(null, { status: 404 });
  // A copy on its own ArrayBuffer, which every Response type accepts.
  const png = (await gradientPng(plan.w, plan.h, plan.n)).slice();
  return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
}

/** FastAPI's 422: one item per problem, naming the field. */
function validate(workflow: Workflow, body: Record<string, unknown> | undefined): Response | undefined {
  if (!body || typeof body !== "object") return unprocessable([], "Input should be a valid dictionary");
  const problems: { loc: string[]; msg: string; type: string }[] = [];
  const say = (field: string, msg: string, type = "value_error") =>
    problems.push({ loc: ["body", field], msg, type });
  if (typeof body.prompt !== "string" || !body.prompt.trim()) say("prompt", "Field required", "missing");
  for (const [field, value] of Object.entries(body)) {
    const rule = workflow.fields[field];
    if (!rule) {
      say(field, "Extra inputs are not permitted", "extra_forbidden");
      continue;
    }
    if (rule.type === "boolean") {
      if (typeof value !== "boolean") say(field, "Input should be a valid boolean", "bool_type");
    } else if (rule.type === "string") {
      if (typeof value !== "string") say(field, "Input should be a valid string", "string_type");
      else if (rule.enum && !rule.enum.includes(value))
        say(field, `Input should be ${rule.enum.join(", ")}`, "enum");
      else if (rule.uuid && !UUID.test(value)) say(field, "Input should be a valid UUID", "uuid_parsing");
      else if (rule.minLength !== undefined && value.length < rule.minLength)
        say(field, "String too short", "string_too_short");
      else if (rule.maxLength !== undefined && value.length > rule.maxLength)
        say(field, "String too long", "string_too_long");
    } else {
      const ok = typeof value === "number" && (rule.type === "number" || Number.isInteger(value));
      if (!ok) say(field, `Input should be a valid ${rule.type}`, `${rule.type}_type`);
      else if (rule.enum && !rule.enum.includes(value))
        say(field, `Input should be ${rule.enum.join(" or ")}`, "enum");
      else if (rule.min !== undefined && value < rule.min)
        say(field, `Input should be at least ${rule.min}`, "greater_than_equal");
      else if (rule.max !== undefined && value > rule.max)
        say(field, `Input should be at most ${rule.max}`, "less_than_equal");
    }
  }
  // Qwen: thinking needs its prompt rewriting on.
  if (body.enable_thinking === true && body.prompt_extend === false) {
    say("enable_thinking", "enable_thinking requires prompt_extend=true");
  }
  return problems.length ? unprocessable(problems) : undefined;
}

function unprocessable(problems: { loc: string[]; msg: string; type: string }[], message?: string): Response {
  return json(422, { detail: problems.length ? problems : message });
}

function detail(status: number, message: string): Response {
  return json(status, { detail: message });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

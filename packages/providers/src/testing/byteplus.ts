import accepted from "../byteplus/__fixtures__/accepted.json";
import badKey from "../byteplus/__fixtures__/bad-key.json";
import cancelStarted from "../byteplus/__fixtures__/cancel-started.json";
import expired from "../byteplus/__fixtures__/expired.json";
import failed from "../byteplus/__fixtures__/failed.json";
import gone from "../byteplus/__fixtures__/gone.json";
import invalid from "../byteplus/__fixtures__/invalid.json";
import { LAST_FRAME_JPEG, VIDEO_SILENT, VIDEO_WITH_SOUND } from "../byteplus/__fixtures__/media";
import notActivated from "../byteplus/__fixtures__/not-activated.json";
import overdue from "../byteplus/__fixtures__/overdue.json";
import overloaded from "../byteplus/__fixtures__/overloaded.json";
import rateLimited from "../byteplus/__fixtures__/rate-limited.json";
import refused from "../byteplus/__fixtures__/refused.json";
import serverError from "../byteplus/__fixtures__/server-error.json";
import tasks from "../byteplus/__fixtures__/tasks.json";
import { childBoxes } from "../mp4";
import { hashString } from "./png";
import {
  type FakeEnv,
  type FakeRoute,
  type FakeScenario,
  type RecordedExchange,
  replay,
  storeMap,
  taggedScenario,
} from "./types";

// A stand-in for BytePlus ModelArk's video task API and its storage host. It checks every create
// against the Create task reference, written out below rather than read from our manifests, so a
// manifest that offers something a model doesn't take fails the conformance suite. It's stricter
// than the real API: an unknown field is refused, so a typo can't slip through.
//
// A task id carries its own plan (when it was made, the size, the model, sound), so a status read
// still answers after a server restart with no stored state, like the other fakes. Videos are the
// tiny fixtures in __fixtures__/media.ts, with their display size set to the size asked for.

const API = "ark.ap-southeast.bytepluses.com";
const STORAGE = "ark-content-generation-v2-ap-southeast-1.tos-ap-southeast-1.bytepluses.com";
const TASKS = "/api/v3/contents/generations/tasks";

interface ModelRules {
  resolutions: string[];
  /** Inclusive; -1 (the model picks) is taken where the docs say. */
  seconds: [number, number];
  autoSeconds: boolean;
  audio: boolean;
  seedAndCamera: boolean;
  lastFrame: boolean;
  /** Text to video may be "adaptive". */
  adaptiveText: boolean;
  /** A first frame allows "adaptive" only. */
  adaptiveOnlyWithFrame: boolean;
}

// From "Create a video generation task" (docs.byteplus.com/en/docs/ModelArk/1520757), 2026-09-29.
const TWO: Omit<ModelRules, "resolutions"> = {
  seconds: [4, 15],
  autoSeconds: true,
  audio: true,
  seedAndCamera: false,
  lastFrame: true,
  adaptiveText: true,
  adaptiveOnlyWithFrame: false,
};
const ONE: Omit<ModelRules, "resolutions" | "lastFrame"> = {
  seconds: [2, 12],
  autoSeconds: false,
  audio: false,
  seedAndCamera: true,
  adaptiveText: false,
  adaptiveOnlyWithFrame: false,
};
const MODELS: Record<string, ModelRules> = {
  "dreamina-seedance-2-5-260628": {
    ...TWO,
    resolutions: ["480p", "720p", "1080p"],
    seconds: [4, 30],
    adaptiveOnlyWithFrame: true,
  },
  "dreamina-seedance-2-0-260128": { ...TWO, resolutions: ["480p", "720p", "1080p", "4k"] },
  "dreamina-seedance-2-0-fast-260128": { ...TWO, resolutions: ["480p", "720p"] },
  "dreamina-seedance-2-0-mini-260615": { ...TWO, resolutions: ["480p", "720p"] },
  "seedance-1-5-pro-251215": {
    ...TWO,
    resolutions: ["480p", "720p", "1080p"],
    seconds: [4, 12],
    seedAndCamera: true,
  },
  "seedance-1-0-pro-250528": { ...ONE, resolutions: ["480p", "720p", "1080p"], lastFrame: true },
  "seedance-1-0-pro-fast-251015": { ...ONE, resolutions: ["480p", "720p", "1080p"], lastFrame: false },
};
const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];
const SHORT_EDGE: Record<string, number> = { "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 };
const FIELDS = new Set([
  "model",
  "content",
  "resolution",
  "ratio",
  "duration",
  "seed",
  "camera_fixed",
  "watermark",
  "generate_audio",
  "return_last_frame",
  "execution_expires_after",
]);

// Errors a create call can answer with, by #fake: tag. A refusal, a failure and an expiry arrive
// later, on a status read.
const fixtures: Partial<Record<FakeScenario, RecordedExchange>> = {
  bad_key: badKey,
  forbidden: notActivated,
  no_billing: overdue,
  invalid,
  rate_limited: rateLimited,
  server_error: serverError,
  unavailable: overloaded,
  refused,
  failed,
  expired,
};

type Plot =
  | "success"
  | "refused"
  | "failed"
  | "expired"
  | "foreign_asset"
  | "slow"
  | "resume_slow"
  | "resume_gone";

/** Queued until the first number, running until the second, in milliseconds after the create call. */
const TIMELINE: Record<Plot, (env: FakeEnv) => [queued: number, done: number]> = {
  success: () => [1_500, 5_000],
  refused: () => [1_000, 3_000],
  failed: () => [1_000, 3_000],
  expired: () => [1_000, 3_000],
  foreign_asset: () => [1_000, 3_000],
  // Stays queued long enough to cancel, or to stop the server while it waits.
  slow: (env) => [env.slowMs, env.slowMs + 4_000],
  resume_slow: (env) => [3_000, env.resumeSlowMs],
  resume_gone: () => [3_000, 60_000],
};
/** A resume_gone task is forgotten this long after it was made. */
const GONE_AFTER_MS = 10_000;

interface Plan {
  v: 1;
  /** Made at, on the fake's clock. */
  c: number;
  m: string;
  w: number;
  h: number;
  /** Seconds. */
  d: number;
  a: boolean;
  r: string;
  q: string;
  n: number;
  s: Plot;
}

const PREFIX = "cgt-fake-";
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

const cancelled = (env: FakeEnv) => storeMap<string, number>(env, "byteplus:cancelled");

export const byteplusFake: FakeRoute = {
  providerId: "byteplus",
  hosts: [API, STORAGE],
  fixtures,

  async handle(request, env) {
    const url = new URL(request.url);
    if (url.host === STORAGE) return media(url, env);

    const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    // Any key works, except one containing "invalid", like the other fakes.
    const forced = env.scenario ?? (!key || key.includes("invalid") ? "bad_key" : undefined);
    const failure = forced && !(forced in LATER) ? fixtures[forced] : undefined;

    if (url.pathname === TASKS && request.method === "GET") {
      return failure ? replay(failure) : replay(tasks);
    }
    const task = new RegExp(`^${TASKS}/([^/]+)$`).exec(url.pathname);
    if (task) {
      const id = decodeURIComponent(task[1]!);
      if (request.method === "GET") return statusOf(id, env);
      if (request.method === "DELETE") return cancel(id, env);
      return error(405, "MethodNotAllowed", "Method not allowed");
    }
    if (url.pathname !== TASKS || request.method !== "POST")
      return error(404, "PathNotFound", "The path of api not found.");
    if (failure) return replay(failure);

    const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const problem = validate(body);
    if (problem) return problem;
    const prompt = textOf(body!);
    const scenario = forced ?? taggedScenario(prompt);
    const tagged = scenario && !(scenario in LATER) ? fixtures[scenario] : undefined;
    if (tagged) return replay(tagged);
    return create(body!, prompt, scenario, env);
  },
};

/** Scenarios that end on a status read, not on the create call. */
const LATER: Partial<Record<FakeScenario, true>> = {
  refused: true,
  failed: true,
  expired: true,
  foreign_asset: true,
  slow: true,
  resume_slow: true,
  resume_gone: true,
};

function textOf(body: Record<string, unknown>): string {
  const content = Array.isArray(body.content) ? (body.content as { type?: string; text?: string }[]) : [];
  return content.find((c) => c.type === "text")?.text ?? "";
}

function create(
  body: Record<string, unknown>,
  prompt: string,
  scenario: FakeScenario | undefined,
  env: FakeEnv,
): Response {
  const rules = MODELS[String(body.model)]!;
  const resolution = typeof body.resolution === "string" ? body.resolution : rules.resolutions[0]!;
  const ratio = typeof body.ratio === "string" && body.ratio !== "adaptive" ? body.ratio : "16:9";
  const [rw, rh] = ratio.split(":").map(Number) as [number, number];
  const short = SHORT_EDGE[resolution] ?? 720;
  const long = Math.round((short * Math.max(rw, rh)) / Math.min(rw, rh));
  const plot: Plot = scenario && scenario in TIMELINE ? (scenario as Plot) : "success";
  const seconds = typeof body.duration === "number" && body.duration > 0 ? body.duration : 5;
  const plan: Plan = {
    v: 1,
    c: env.now(),
    m: String(body.model),
    w: rw >= rh ? long : short,
    h: rw >= rh ? short : long,
    d: seconds,
    a: rules.audio ? body.generate_audio !== false : false,
    r: resolution,
    q: String(body.ratio ?? "adaptive"),
    n:
      typeof body.seed === "number" && body.seed >= 0
        ? body.seed
        : (hashString(prompt) + env.nextSeed() * 7919) % 2_147_483_648,
    s: plot,
  };
  return json(200, { ...(accepted.response.body as object), id: encode(plan) });
}

/** The task's state on the fake's clock, from its plan. */
function stateOf(id: string, plan: Plan, env: FakeEnv): "queued" | "running" | "done" | "cancelled" | "gone" {
  if (cancelled(env).has(id)) return "cancelled";
  const now = env.now();
  if (plan.s === "resume_gone" && now >= plan.c + GONE_AFTER_MS) return "gone";
  const [queued, done] = TIMELINE[plan.s](env);
  if (now < plan.c + queued) return "queued";
  return now < plan.c + done ? "running" : "done";
}

function statusOf(id: string, env: FakeEnv): Response {
  const plan = decode(id);
  if (!plan) return replay(gone);
  const state = stateOf(id, plan, env);
  if (state === "gone") return replay(gone);
  const base = {
    id,
    model: plan.m,
    created_at: Math.floor(plan.c / 1000),
    updated_at: Math.floor(env.now() / 1000),
    execution_expires_after: 7200,
  };
  if (state !== "done") return json(200, { ...base, status: state, error: null, content: null, usage: null });
  if (plan.s === "refused" || plan.s === "failed" || plan.s === "expired") {
    const { status, error: err } = fixtures[plan.s]!.response.body as { status: string; error: unknown };
    return json(200, { ...base, status, error: err, content: null, usage: null });
  }
  const host = plan.s === "foreign_asset" ? "files.unknown-host.example" : STORAGE;
  const tokens = Math.round((plan.w * plan.h * 24 * plan.d) / 1024);
  return json(200, {
    ...base,
    status: "succeeded",
    error: null,
    content: {
      video_url: `https://${host}/${encodeURIComponent(id)}/video.mp4?X-Tos-Signature=fake`,
      last_frame_url: `https://${host}/${encodeURIComponent(id)}/last_frame.jpeg?X-Tos-Signature=fake`,
    },
    usage: { completion_tokens: tokens, total_tokens: tokens },
    seed: plan.n,
    resolution: plan.r,
    ratio: plan.q === "adaptive" ? "16:9" : plan.q,
    duration: plan.d,
    framespersecond: 24,
    ...(MODELS[plan.m]?.audio && { generate_audio: plan.a }),
  });
}

function cancel(id: string, env: FakeEnv): Response {
  const plan = decode(id);
  if (!plan) return replay(gone);
  const state = stateOf(id, plan, env);
  if (state === "cancelled") return json(200, {});
  // Only a queued task can be cancelled; nothing is billed for it.
  if (state !== "queued") return replay(cancelStarted);
  cancelled(env).set(id, env.now());
  return json(200, {});
}

function media(url: URL, env: FakeEnv): Response {
  const match = /^\/([^/]+)\/(video\.mp4|last_frame\.jpeg)$/.exec(url.pathname);
  const id = match && decodeURIComponent(match[1]!);
  const plan = id ? decode(id) : undefined;
  if (!id || !plan || stateOf(id, plan, env) !== "done") return new Response(null, { status: 404 });
  if (match![2] === "last_frame.jpeg") {
    return new Response(Buffer.from(LAST_FRAME_JPEG, "base64"), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }
  const bytes = withDisplaySize(
    Buffer.from(plan.a ? VIDEO_WITH_SOUND : VIDEO_SILENT, "base64"),
    plan.w,
    plan.h,
  );
  return new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });
}

/**
 * The fixture with its video track's display size set to the size asked for, so the library sees
 * the shape a real video would have. The pictures inside stay 64×36; players scale them.
 */
function withDisplaySize(source: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(source.length));
  bytes.set(source);
  const view = new DataView(bytes.buffer);
  const moov = childBoxes(bytes).find((b) => b.type === "moov");
  if (!moov) return bytes;
  for (const trak of childBoxes(bytes, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (trak.type !== "trak") continue;
    const parts = childBoxes(bytes, trak.start + trak.headerSize, trak.start + trak.size);
    const tkhd = parts.find((p) => p.type === "tkhd");
    // Audio tracks have a 0×0 box.
    if (!tkhd || view.getUint32(tkhd.start + tkhd.size - 8) === 0) continue;
    view.setUint32(tkhd.start + tkhd.size - 8, width * 65536);
    view.setUint32(tkhd.start + tkhd.size - 4, height * 65536);
  }
  return bytes;
}

/** Checks a create body against the documented rules. BytePlus answers a bad one with a 400. */
function validate(body: Record<string, unknown> | undefined): Response | undefined {
  const bad = (param: string, message: string) =>
    json(400, { error: { code: "InvalidParameter", message, param, type: "BadRequest" } });
  if (!body || typeof body !== "object") return bad("body", "The request body is not valid JSON");
  for (const field of Object.keys(body))
    if (!FIELDS.has(field)) return bad(field, `Unknown parameter ${field}`);
  const rules = MODELS[String(body.model)];
  if (!rules) {
    return json(404, {
      error: {
        code: "InvalidEndpointOrModel.NotFound",
        message: `The model or endpoint ${String(body.model)} does not exist or you do not have access to it.`,
        type: "NotFound",
      },
    });
  }
  const content = body.content;
  if (!Array.isArray(content) || content.length === 0) return bad("content", "content is required");
  const texts = content.filter((c) => c?.type === "text");
  const images = content.filter((c) => c?.type === "image_url");
  if (texts.length > 1 || texts.some((c) => typeof c.text !== "string" || !c.text.trim()))
    return bad("content", "At most one non-empty text item");
  if (content.length !== texts.length + images.length) return bad("content", "Only text and image_url items");
  for (const image of images) {
    const url = image?.image_url?.url;
    if (typeof url !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(url))
      return bad("image_url", "The image must be a data URL of a png, jpeg or webp");
  }
  const roles = images.map((i) => i.role);
  if (images.length > 2) return bad("content", "At most a first and a last frame");
  if (images.length === 2) {
    if (roles[0] !== "first_frame" || roles[1] !== "last_frame")
      return bad("content", "Two frames need the roles first_frame and last_frame");
    if (!rules.lastFrame) return bad("content", `${body.model} doesn't take a last frame`);
  }
  if (images.length === 1 && roles[0] !== undefined && roles[0] !== "first_frame")
    return bad("content", "One image is the first frame");
  if (!texts.length && !images.length) return bad("content", "A prompt or a frame is required");

  if (body.resolution !== undefined && !rules.resolutions.includes(String(body.resolution)))
    return bad("resolution", `resolution must be one of ${rules.resolutions.join(", ")}`);
  if (body.ratio !== undefined) {
    if (!RATIOS.includes(String(body.ratio))) return bad("ratio", "ratio isn't a supported value");
    if (body.ratio === "adaptive" && !images.length && !rules.adaptiveText)
      return bad("ratio", `${body.model} doesn't support adaptive for text to video`);
    if (images.length && rules.adaptiveOnlyWithFrame && body.ratio !== "adaptive")
      return bad("ratio", "With a first frame, ratio only supports adaptive");
  }
  if (body.duration !== undefined) {
    const d = body.duration;
    const [low, high] = rules.seconds;
    const ok =
      Number.isInteger(d) &&
      (((d as number) >= low && (d as number) <= high) || (rules.autoSeconds && d === -1));
    if (!ok) return bad("duration", `duration must be between ${low} and ${high}`);
  }
  if (body.generate_audio !== undefined && (!rules.audio || typeof body.generate_audio !== "boolean"))
    return bad("generate_audio", `${body.model} doesn't support generate_audio`);
  if (body.seed !== undefined) {
    const s = body.seed;
    if (!rules.seedAndCamera || !Number.isInteger(s) || (s as number) < -1 || (s as number) > 2_147_483_647)
      return bad("seed", "seed isn't supported or is out of range");
  }
  if (body.camera_fixed !== undefined && (!rules.seedAndCamera || typeof body.camera_fixed !== "boolean"))
    return bad("camera_fixed", `${body.model} doesn't support camera_fixed`);
  for (const flag of ["watermark", "return_last_frame"]) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean")
      return bad(flag, `${flag} must be a boolean`);
  }
  const expires = body.execution_expires_after;
  if (
    expires !== undefined &&
    (!Number.isInteger(expires) || (expires as number) < 3600 || (expires as number) > 259_200)
  )
    return bad("execution_expires_after", "execution_expires_after must be in [3600, 259200]");
  return undefined;
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

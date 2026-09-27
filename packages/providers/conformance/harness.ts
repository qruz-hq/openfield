import {
  type CredentialValues,
  type GenerateRequest,
  isTerminalState,
  type JobHandle,
  type ModelManifest,
  newId,
  type SettingValue,
} from "@openfield/core";
import { normalize } from "../src/normalize";
import { builtinProviders, fakeOnlyProviders } from "../src/registry";
import { createTestContext, type TestContext } from "../src/testing/context";
import { builtinFakes, createFakeFetch } from "../src/testing/fake-fetch";
import { gradientPng } from "../src/testing/png";
import type { FakeRoute, FakeScenario } from "../src/testing/types";
import type { FetchLike, ImageModel, JobUpdate, Provider } from "../src/types";

// One kit per built-in adapter: the provider, its fake API and a key the suite hunts for in logs.
// A new adapter joins the suite by being in builtinProviders with a fake in builtinFakes. The
// fake-mode test company runs it too, offline only: it's how a resumable adapter is held to the
// same rules before a real one ships.

export interface Kit {
  provider: Provider;
  fake: FakeRoute;
  credentials: CredentialValues;
  /** Every credential value, for the "no key anywhere" checks. */
  secrets: string[];
  /** Has a real API behind it, so OPENFIELD_CONFORMANCE=live runs it. */
  live: boolean;
}

const kitFor = (provider: Provider, live: boolean): Kit => {
  const fake = builtinFakes.find((f) => f.providerId === provider.meta.id);
  if (!fake)
    throw new Error(`${provider.meta.id} has no fake in src/testing/, so it can't run the suite offline`);
  const credentials = Object.fromEntries(
    provider.credentials.fields.map((f) => [f.name, `conformance-${provider.meta.id}-${f.name}-7f3a9c2e1b`]),
  );
  return { provider, fake, credentials, secrets: Object.values(credentials), live };
};

export const kits: Kit[] = [
  ...builtinProviders.map((p) => kitFor(p, true)),
  ...fakeOnlyProviders.map((p) => kitFor(p, false)),
];

export interface Sent {
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON, or a marker for bodies that aren't JSON (multipart, say). */
  body: unknown;
}

/** A clock the fake API and the context both read, moved by hand so timelines take no real time. */
export interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

export interface Harness {
  ctx: TestContext;
  fetch: ReturnType<typeof createFakeFetch>;
  sent: Sent[];
  /** Absent when the test passed its own `now`. */
  clock?: ManualClock;
}

const EPOCH = Date.parse("2026-09-24T12:00:00.000Z");

export function harness(
  kit: Kit,
  opts: {
    scenario?: FakeScenario;
    delayMs?: number;
    signal?: AbortSignal;
    credentials?: CredentialValues;
    /** The fake's clock, for batch timelines. */
    now?: () => number;
  } = {},
): Harness {
  const clock = opts.now ? undefined : manualClock();
  const now = opts.now ?? clock!.now;
  const fake = createFakeFetch({
    routes: [kit.fake],
    delayMs: opts.delayMs ?? 0,
    maxEdge: 48,
    now,
    ...(opts.scenario && { scenario: opts.scenario }),
  });
  const sent: Sent[] = [];
  const spy: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    sent.push({ url, headers, body: parseBody(init?.body) });
    return fake(input, init);
  };
  const ctx = createTestContext({
    fetch: spy,
    credentials: opts.credentials ?? kit.credentials,
    now,
    ...(opts.signal && { signal: opts.signal }),
  });
  return { ctx, fetch: fake, sent, ...(clock && { clock }) };
}

function manualClock(): ManualClock {
  let at = EPOCH;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

function parseBody(body: unknown): unknown {
  // Multipart: each field in order, files by name and type (their sizes differ by OS, see below).
  if (body instanceof FormData) {
    return {
      form: [...body.entries()].map(([name, value]) =>
        typeof value === "string"
          ? [name, value]
          : [name, `<file ${(value as Blob & { name?: string }).name} ${(value as Blob).type}>`],
      ),
    };
  }
  if (typeof body !== "string") return body === undefined || body === null ? undefined : "[non-JSON body]";
  try {
    return JSON.parse(body);
  } catch {
    return "[non-JSON body]";
  }
}

export function defaultSize(manifest: ModelManifest): GenerateRequest["size"] {
  const size = manifest.capabilities.size;
  if (size.mode === "aspect")
    return size.default === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: size.default };
  return { kind: "pixels", ...size.default };
}

export function request(manifest: ModelManifest, overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    idempotencyKey: newId(),
    model: manifest.key,
    op: "generate",
    prompt: "A red kite over a green hill",
    size: defaultSize(manifest),
    batch: 1,
    source: "api",
    ...overrides,
  };
}

/**
 * Normalizes with the company's settings (`stored` is what the person changed), sets the context's
 * speed and settings from the frozen request as the runner does, then submits every call.
 */
export async function prepare(
  kit: Kit,
  manifest: ModelManifest,
  req: GenerateRequest,
  h: Harness,
  stored: Record<string, SettingValue> = {},
) {
  const normalized = await normalize(manifest, req, {
    jobSetId: newId(),
    settings: { ...(kit.provider.settings && { schema: kit.provider.settings }), stored },
    // A model that takes seeds gets one when none is asked for; a fixed one keeps golden payloads stable.
    randomSeed: () => 1234,
  });
  if (normalized.error) throw normalized.error;
  h.ctx.speed = normalized.request.speed;
  h.ctx.settings = normalized.request.providerSettings;
  return normalized;
}

/** Normalizes, then submits every call. Throws what submit throws. */
export async function generate(
  kit: Kit,
  manifest: ModelManifest,
  req: GenerateRequest,
  h: Harness,
  stored: Record<string, SettingValue> = {},
) {
  const normalized = await prepare(kit, manifest, req, h, stored);
  const model = kit.provider.model(manifest.key);
  const handles = [];
  for (const call of normalized.calls) handles.push(await model.submit(call, h.ctx));
  return { normalized, handles, model };
}

/**
 * Polls one handle until it ends, moving the harness clock between reads so a queue-style fake
 * walks its timeline in no real time. A blocking adapter's first poll already ends it.
 */
export async function finish(model: ImageModel, handle: JobHandle, h: Harness): Promise<JobUpdate> {
  if (!h.clock) throw new Error("finish() needs the harness's own clock");
  for (let i = 0; i < 500; i++) {
    const update = await model.poll(handle, h.ctx);
    if (isTerminalState(update.state)) return update;
    h.clock.advance(2_000);
  }
  throw new Error("The call never finished");
}

/**
 * Normalizes, submits every call and polls each to its end, as the runner would. Throws what
 * submit throws, or the first failed call's error, so tests read the same for blocking and
 * queue-style adapters.
 */
export async function run(
  kit: Kit,
  manifest: ModelManifest,
  req: GenerateRequest,
  h: Harness,
  stored: Record<string, SettingValue> = {},
) {
  const sent = await generate(kit, manifest, req, h, stored);
  const updates: JobUpdate[] = [];
  for (const handle of sent.handles) {
    const update = await finish(sent.model, handle, h);
    if (update.state !== "succeeded" && update.error) throw update.error;
    updates.push(update);
  }
  return { ...sent, updates };
}

/** A small real PNG in the asset store, for references and edit bases. */
export async function addImage(h: Harness, width = 24, height = 32): Promise<string> {
  return h.ctx.assets.add(await gradientPng(width, height, width * 31 + height));
}

/**
 * Replaces base64 image data so golden snapshots stay readable and stable. Not its length: the test
 * PNGs are deflated by the runtime's own zlib, which packs them to different sizes on each OS.
 */
export function withoutImageBytes(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => (key === "data" && typeof v === "string" ? "<base64 image>" : v)),
  );
}

/** Long unbroken base64 runs or data: URLs anywhere in a value. */
export function findBase64(value: unknown): string | undefined {
  const text = JSON.stringify(value) ?? "";
  return /data:[a-z]+\/[a-z0-9.+-]+;base64,/i.exec(text)?.[0] ?? /[A-Za-z0-9+/]{200,}={0,2}/.exec(text)?.[0];
}

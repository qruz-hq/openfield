import {
  type CredentialValues,
  type GenerateRequest,
  type ModelManifest,
  newId,
  type SettingValue,
} from "@openfield/core";
import { normalize } from "../src/normalize";
import { builtinProviders } from "../src/registry";
import { createTestContext, type TestContext } from "../src/testing/context";
import { builtinFakes, createFakeFetch } from "../src/testing/fake-fetch";
import { gradientPng } from "../src/testing/png";
import type { FakeRoute, FakeScenario } from "../src/testing/types";
import type { FetchLike, Provider } from "../src/types";

// One kit per built-in adapter: the provider, its fake API and a key the suite hunts for in logs.
// A new adapter joins the suite by being in builtinProviders with a fake in builtinFakes.

export interface Kit {
  provider: Provider;
  fake: FakeRoute;
  credentials: CredentialValues;
  /** Every credential value, for the "no key anywhere" checks. */
  secrets: string[];
}

export const kits: Kit[] = builtinProviders.map((provider) => {
  const fake = builtinFakes.find((f) => f.providerId === provider.meta.id);
  if (!fake)
    throw new Error(`${provider.meta.id} has no fake in src/testing/, so it can't run the suite offline`);
  const credentials = Object.fromEntries(
    provider.credentials.fields.map((f) => [f.name, `conformance-${provider.meta.id}-${f.name}-7f3a9c2e1b`]),
  );
  return { provider, fake, credentials, secrets: Object.values(credentials) };
});

export interface Sent {
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON, or a marker for bodies that aren't JSON (multipart, say). */
  body: unknown;
}

export interface Harness {
  ctx: TestContext;
  fetch: ReturnType<typeof createFakeFetch>;
  sent: Sent[];
}

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
  const fake = createFakeFetch({
    routes: [kit.fake],
    delayMs: opts.delayMs ?? 0,
    maxEdge: 48,
    ...(opts.scenario && { scenario: opts.scenario }),
    ...(opts.now && { now: opts.now }),
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
    ...(opts.signal && { signal: opts.signal }),
  });
  return { ctx, fetch: fake, sent };
}

function parseBody(body: unknown): unknown {
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

/** A small real PNG in the asset store, for references and edit bases. */
export async function addImage(h: Harness, width = 24, height = 32): Promise<string> {
  return h.ctx.assets.add(await gradientPng(width, height, width * 31 + height));
}

/** Replaces base64 image data so golden snapshots stay readable and stable. */
export function withoutImageBytes(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) =>
      key === "data" && typeof v === "string" ? `<${v.length} base64 chars>` : v,
    ),
  );
}

/** Long unbroken base64 runs or data: URLs anywhere in a value. */
export function findBase64(value: unknown): string | undefined {
  const text = JSON.stringify(value) ?? "";
  return /data:[a-z]+\/[a-z0-9.+-]+;base64,/i.exec(text)?.[0] ?? /[A-Za-z0-9+/]{200,}={0,2}/.exec(text)?.[0];
}

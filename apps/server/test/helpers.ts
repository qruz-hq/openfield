import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type JobSetAccepted,
  newId,
  SESSION_HEADER,
  type SseEvent,
  type SseEventType,
} from "@openfield/core";
import { createFakeFetch, type FetchLike } from "@openfield/providers/server";
import { createServer, type OpenfieldServer, type ServerOptions } from "../src/server";

// A real server on a temp OPENFIELD_HOME, driven through app.request(): no port, no network.

export const PORT = 4317;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://${HOST}`;
export const TEST_KEY = "AIzaTestKey-0123456789abcdefghij";

export interface TestServer extends OpenfieldServer {
  home: string;
  token: string;
  request(path: string, init?: RequestInit & { session?: boolean }): Promise<Response>;
  json<T = unknown>(
    path: string,
    init?: Omit<RequestInit, "body"> & { body?: unknown },
  ): Promise<{ status: number; body: T }>;
  /** Every event the hub published, in order. */
  events: { event: SseEventType; data: unknown }[];
  close(opts?: { keepHome?: boolean }): Promise<void>;
}

export async function startTestServer(
  opts: Omit<ServerOptions, "env"> & { env?: Record<string, string | undefined>; home?: string } = {},
): Promise<TestServer> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "openfield-test-"));
  const { env, home: _home, ...rest } = opts;
  const server = await createServer({
    console: false,
    port: PORT,
    webDist: null,
    fetch: createFakeFetch({ delayMs: 0 }),
    ...rest,
    queue: { retryDelaysMs: [5, 5, 5], heartbeatMs: 25, ...rest.queue },
    env: { OPENFIELD_HOME: home, ...env },
  });
  const events: TestServer["events"] = [];
  server.services.events.subscribe((event, data) => events.push({ event, data }));

  const request: TestServer["request"] = (path, init = {}) => {
    const { session, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (!headers.has("host")) headers.set("host", HOST);
    if (session !== false && !headers.has(SESSION_HEADER)) headers.set(SESSION_HEADER, server.services.token);
    return Promise.resolve(server.app.request(path, { ...rest, headers }));
  };

  return {
    ...server,
    home,
    token: server.services.token,
    events,
    request,
    async json(path, init = {}) {
      const { body, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (body !== undefined) headers.set("content-type", "application/json");
      const res = await request(path, {
        ...rest,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as never };
    },
    async close({ keepHome = false } = {}) {
      await server.stop({ drainMs: 200 });
      if (!keepHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function saveKey(server: TestServer, apiKey = TEST_KEY): Promise<void> {
  const res = await server.json("/api/settings/keys/google", { method: "PUT", body: { apiKey } });
  if (res.status !== 200) throw new Error(`Saving the key failed: ${JSON.stringify(res.body)}`);
}

export function generateBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: newId(),
    model: "google:gemini-3.1-flash-image",
    op: "generate",
    prompt: "a lighthouse at dusk",
    size: { kind: "aspect", ratio: "3:4" },
    batch: 1,
    source: "composer",
    ...overrides,
  };
}

export async function generate(
  server: TestServer,
  overrides: Record<string, unknown> = {},
): Promise<JobSetAccepted> {
  const res = await server.json<JobSetAccepted>("/api/generate", {
    method: "POST",
    body: generateBody(overrides),
  });
  if (res.status !== 202) throw new Error(`Generate failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
}

/** Waits for job_set.completed for this set and returns its payload. */
export function completed(server: TestServer, jobSetId: string, timeoutMs = 5_000) {
  return waitFor(() => {
    const hit = server.events.find(
      (e) => e.event === "job_set.completed" && (e.data as { jobSetId: string }).jobSetId === jobSetId,
    );
    return hit?.data as Extract<SseEvent, { event: "job_set.completed" }>["data"] | undefined;
  }, timeoutMs);
}

export const isGenerateCall = (input: string | URL | Request) =>
  String(input instanceof Request ? input.url : input).includes(":generateContent");

/**
 * A fetch whose image calls wait until released, to hold work in flight. Tracks the most at once.
 * Model list calls pass straight through.
 */
export function gatedFetch(inner: FetchLike = createFakeFetch({ delayMs: 0 })) {
  let open = false;
  let waiters: (() => void)[] = [];
  const state = { active: 0, max: 0, calls: 0 };
  const fetch: FetchLike = async (input, init) => {
    if (!isGenerateCall(input)) return inner(input, init);
    state.calls++;
    state.active++;
    state.max = Math.max(state.max, state.active);
    try {
      if (!open) {
        await new Promise<void>((resolve, reject) => {
          waiters.push(resolve);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return await inner(input, init);
    } finally {
      state.active--;
    }
  };
  return {
    fetch,
    state,
    release() {
      open = true;
      for (const resolve of waiters) resolve();
      waiters = [];
    },
  };
}

/** A Google-shaped error response. */
export function googleError(status: number, grpcStatus: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message, status: grpcStatus } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface Frame {
  id?: number;
  event: string;
  data: string;
}

/** Reads text/event-stream frames until `until` says stop. */
export async function readFrames(
  res: Response,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 5_000,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const timer = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame: Frame = { event: "", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data += line.slice(6);
        }
        if (frame.event) frames.push(frame);
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return frames;
}

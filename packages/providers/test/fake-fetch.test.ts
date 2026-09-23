import { describe, expect, test } from "bun:test";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { crc32, encodePng, gradientPng, probeImage } from "../src/testing/png";

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta";
const headers = { "x-goog-api-key": "fake-key-123", "content-type": "application/json" };

const generate = (
  fetch: ReturnType<typeof createFakeFetch>,
  text: string,
  imageConfig?: object,
  init: RequestInit = {},
) =>
  fetch(`${URL_BASE}/models/gemini-3.1-flash-image:generateContent`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseModalities: ["IMAGE"], ...(imageConfig && { imageConfig }) },
    }),
    ...init,
  });

const imageOf = async (res: Response) => {
  const body = (await res.json()) as {
    candidates: { content: { parts: { inlineData: { data: string } }[] } }[];
  };
  return new Uint8Array(Buffer.from(body.candidates[0]!.content.parts[0]!.inlineData.data, "base64"));
};

describe("png", () => {
  test("encodes a valid PNG: signature, sizes and chunk checksums", async () => {
    const png = await gradientPng(40, 30, 12345);
    expect(probeImage(png)).toEqual({ mimeType: "image/png", width: 40, height: 30 });
    const view = new DataView(png.buffer, png.byteOffset);
    let pos = 8;
    const types: string[] = [];
    while (pos < png.length) {
      const length = view.getUint32(pos);
      const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
      expect(view.getUint32(pos + 8 + length)).toBe(crc32(png.subarray(pos + 4, pos + 8 + length)));
      types.push(type);
      pos += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  test("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("still encodes without CompressionStream", async () => {
    const original = globalThis.CompressionStream;
    // @ts-expect-error: simulate a runtime without it
    globalThis.CompressionStream = undefined;
    try {
      const png = await encodePng(2, 2, new Uint8Array(12).fill(200));
      expect(probeImage(png)).toMatchObject({ width: 2, height: 2 });
    } finally {
      globalThis.CompressionStream = original;
    }
  });
});

describe("createFakeFetch", () => {
  test("answers generateContent with a real image at the requested shape", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 64 });
    const res = await generate(fetch, "a boat", { aspectRatio: "16:9", imageSize: "2K" });
    expect(res.status).toBe(200);
    expect(probeImage(await imageOf(res))).toEqual({ mimeType: "image/png", width: 64, height: 36 });
  });

  test("the same prompt twice gives two different images", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32 });
    const a = await imageOf(await generate(fetch, "same prompt"));
    const b = await imageOf(await generate(fetch, "same prompt"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("rejects what the real API rejects", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    expect((await generate(fetch, "x", { aspectRatio: "7:3" })).status).toBe(400);
    expect((await generate(fetch, "x", { imageSize: "1k" })).status).toBe(400);
    const pro = await fetch(`${URL_BASE}/models/gemini-3-pro-image:generateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:8" } },
      }),
    });
    expect(pro.status).toBe(400);
  });

  test("a #fake: tag or a key containing 'invalid' picks a failure", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    expect((await generate(fetch, "a boat #fake:rate_limited")).status).toBe(429);
    const bad = await fetch(`${URL_BASE}/models`, { headers: { "x-goog-api-key": "my-invalid-key" } });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${URL_BASE}/models`, { headers: { "x-goog-api-key": "fine" } });
    expect(ok.status).toBe(200);
  });

  test("a missing key or a key in the URL is refused", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    expect((await fetch(`${URL_BASE}/models`)).status).toBe(403);
    expect((await fetch(`${URL_BASE}/models?key=abc`, { headers: { "x-goog-api-key": "abc" } })).status).toBe(
      400,
    );
  });

  test("aborting during the delay rejects with the signal's reason", async () => {
    const fetch = createFakeFetch({ delayMs: 5000 });
    const controller = new AbortController();
    const pending = generate(fetch, "slow", undefined, { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  test("unknown hosts fail like a network error, and every call is recorded", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    await expect(fetch("https://example.com/x")).rejects.toThrow(TypeError);
    expect(fetch.calls.map((c) => c.host)).toEqual(["example.com"]);
  });
});

describe("fake speeds", () => {
  const withTier = (
    fetch: ReturnType<typeof createFakeFetch>,
    model: string,
    text: string,
    serviceTier?: string,
  ) =>
    fetch(`${URL_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
        ...(serviceTier && { serviceTier }),
      }),
    });
  const tierOf = async (res: Response) =>
    ((await res.json()) as { usageMetadata: { serviceTier?: string } }).usageMetadata.serviceTier;

  test("Flex and Priority only where Google's pricing page lists them", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    const flex = await withTier(fetch, "gemini-3-pro-image", "x", "flex");
    expect([flex.status, await tierOf(flex)]).toEqual([200, "flex"]);
    expect(await tierOf(await withTier(fetch, "gemini-3-pro-image", "x"))).toBe("standard");
    const refused = await withTier(fetch, "gemini-3.1-flash-image", "x", "flex");
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("service_tier");
    expect((await withTier(fetch, "gemini-3-pro-image", "x", "turbo")).status).toBe(400);
  });

  test("#fake:flex_busy answers every other Flex call busy, so a retry gets through", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    const prompt = "a kite #fake:flex_busy";
    const busy = await withTier(fetch, "gemini-3-pro-image", prompt, "flex");
    expect([busy.status, busy.headers.get("retry-after")]).toEqual([503, "2"]);
    expect((await withTier(fetch, "gemini-3-pro-image", prompt, "flex")).status).toBe(200);
    expect((await withTier(fetch, "gemini-3-pro-image", prompt, "flex")).status).toBe(503);
    // Only Flex is ever busy.
    expect((await withTier(fetch, "gemini-3-pro-image", prompt)).status).toBe(200);
  });

  test("#fake:priority_standard serves Priority at Standard", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    const res = await withTier(fetch, "gemini-3-pro-image", "x #fake:priority_standard", "priority");
    expect(await tierOf(res)).toBe("standard");
  });
});

describe("fake batches", () => {
  const create = (fetch: ReturnType<typeof createFakeFetch>, text: string, keys = ["job-a", "job-b"]) =>
    fetch(`${URL_BASE}/models/gemini-3.1-flash-image:batchGenerateContent`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        batch: {
          displayName: "openfield-run",
          inputConfig: {
            requests: {
              requests: keys.map((key) => ({
                request: {
                  contents: [{ parts: [{ text }] }],
                  generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
                },
                metadata: { key },
              })),
            },
          },
        },
      }),
    });
  interface Op {
    name: string;
    done?: boolean;
    metadata: {
      state: string;
      displayName: string;
      batchStats: Record<string, string>;
      output?: {
        inlinedResponses: {
          inlinedResponses: { metadata: { key: string }; response?: unknown; error?: unknown }[];
        };
      };
    };
  }
  const get = async (fetch: ReturnType<typeof createFakeFetch>, name: string) => {
    const res = await fetch(`${URL_BASE}/${name}`, { headers });
    return { status: res.status, op: (await res.json()) as Op };
  };

  test("pending, then running, then succeeded, on the fake's clock", async () => {
    let now = 1_000_000;
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 32, now: () => now });
    const made = (await (await create(fetch, "a lighthouse")).json()) as Op;
    expect(made.name).toMatch(/^batches\/fake/);
    expect(made.metadata.state).toBe("BATCH_STATE_PENDING");
    now += 2_000;
    const running = await get(fetch, made.name);
    expect(running.op.metadata.state).toBe("BATCH_STATE_RUNNING");
    expect(running.op.metadata.output).toBeUndefined();
    now += 3_000;
    const done = await get(fetch, made.name);
    expect(done.op.done).toBe(true);
    expect(done.op.metadata.state).toBe("BATCH_STATE_SUCCEEDED");
    expect(done.op.metadata.batchStats).toMatchObject({ requestCount: "2", successfulRequestCount: "2" });
    const items = done.op.metadata.output?.inlinedResponses.inlinedResponses ?? [];
    expect(items.map((i) => i.metadata.key)).toEqual(["job-a", "job-b"]);
    const first = items[0]!.response as {
      candidates: { content: { parts: { inlineData: { data: string } }[] } }[];
    };
    const image = first.candidates[0]!.content.parts[0]!.inlineData.data;
    expect(probeImage(new Uint8Array(Buffer.from(image, "base64")))).toMatchObject({ width: 32, height: 18 });
  });

  test("a batch survives a server restart: a new fake still answers for it", async () => {
    let now = 5_000_000;
    const before = createFakeFetch({ delayMs: 0, maxEdge: 16, now: () => now });
    const made = (await (await create(before, "a harbour")).json()) as Op;
    now += 10_000;
    const after = createFakeFetch({ delayMs: 0, maxEdge: 16, now: () => now });
    expect((await get(after, made.name)).op.metadata.state).toBe("BATCH_STATE_SUCCEEDED");
  });

  test("cancel keeps what finished first; delete removes the batch", async () => {
    let now = 0;
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16, now: () => now });
    const made = (await (await create(fetch, "slow #fake:batch_slow", ["a", "b", "c", "d"])).json()) as Op;
    now = 5_000 + 13_000; // two of four done
    expect((await fetch(`${URL_BASE}/${made.name}:cancel`, { method: "POST", headers })).status).toBe(200);
    now += 60_000;
    const { op } = await get(fetch, made.name);
    expect(op.metadata.state).toBe("BATCH_STATE_CANCELLED");
    expect(op.metadata.output?.inlinedResponses.inlinedResponses.map((i) => i.metadata.key)).toEqual([
      "a",
      "b",
    ]);
    expect((await fetch(`${URL_BASE}/${made.name}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await get(fetch, made.name)).status).toBe(404);
  });

  test("tags: partial fails every other image, expired and failed end with none", async () => {
    let now = 0;
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16, now: () => now });
    const partial = (await (await create(fetch, "p #fake:batch_partial", ["a", "b", "c", "d"])).json()) as Op;
    const expired = (await (await create(fetch, "e #fake:batch_expired")).json()) as Op;
    const failed = (await (await create(fetch, "f #fake:batch_failed")).json()) as Op;
    now = 60_000;
    const items =
      (await get(fetch, partial.name)).op.metadata.output?.inlinedResponses.inlinedResponses ?? [];
    expect(
      items.map((i) =>
        "error" in i
          ? "error"
          : (i.response as { promptFeedback?: unknown }).promptFeedback
            ? "blocked"
            : "ok",
      ),
    ).toEqual(["ok", "error", "ok", "blocked"]);
    const exp = (await get(fetch, expired.name)).op;
    expect([exp.metadata.state, exp.metadata.output]).toEqual(["BATCH_STATE_EXPIRED", undefined]);
    const fail = (await get(fetch, failed.name)).op as Op & { error?: { code: number } };
    expect([fail.metadata.state, fail.error?.code]).toEqual(["BATCH_STATE_FAILED", 13]);
  });

  test("the list finds batches by display name", async () => {
    const fetch = createFakeFetch({ delayMs: 0, maxEdge: 16 });
    const made = (await (await create(fetch, "x")).json()) as Op;
    const list = (await (await fetch(`${URL_BASE}/batches?pageSize=100`, { headers })).json()) as {
      operations: Op[];
    };
    expect(list.operations.map((o) => [o.name, o.metadata.displayName])).toEqual([
      [made.name, "openfield-run"],
    ]);
  });

  test("a create over 20 MB is refused, like the real API", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const res = await create(fetch, "x".repeat(21 * 1024 * 1024));
    expect(res.status).toBe(400);
  });

  test("files: a resumable upload, then delete", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
      method: "POST",
      headers: {
        ...headers,
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-type": "image/png",
      },
      body: JSON.stringify({ file: { display_name: "ref" } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url")!;
    expect(new URL(uploadUrl).host).toBe("generativelanguage.googleapis.com");
    const done = await fetch(uploadUrl, {
      method: "POST",
      headers: { "x-goog-api-key": "k", "x-goog-upload-command": "upload, finalize" },
      body: new Uint8Array([1, 2, 3]),
    });
    const file = ((await done.json()) as { file: { name: string; uri: string; sizeBytes: string } }).file;
    expect([file.sizeBytes, file.uri.endsWith(file.name)]).toEqual(["3", true]);
    expect((await fetch(`${URL_BASE}/${file.name}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await fetch(`${URL_BASE}/${file.name}`, { method: "DELETE", headers })).status).toBe(404);
  });
});

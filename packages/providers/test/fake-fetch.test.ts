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

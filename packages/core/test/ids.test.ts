// biome-ignore lint/style/noRestrictedImports: tests run under Bun, not in the browser.
import { describe, expect, test } from "bun:test";
import {
  assetThumbUrl,
  canvasSource,
  decodeCursor,
  encodeCursor,
  formatModelKey,
  isModelKey,
  isUlid,
  jobIdempotencyKey,
  newId,
  parseCanvasSource,
  parseModelKey,
  resolveThumbRung,
  safeParseModelKey,
  thumbCacheKey,
  ulidTime,
} from "../src/ids";

describe("ModelKey", () => {
  test("formats and parses", () => {
    const key = formatModelKey("google", "gemini-3-pro-image");
    expect(key).toBe("google:gemini-3-pro-image");
    expect(parseModelKey(key)).toEqual({ providerId: "google", modelId: "gemini-3-pro-image" });
  });

  test("splits at the first colon, so model ids may carry one", () => {
    expect(parseModelKey("replicate:owner/model:5c7d5dc6")).toEqual({
      providerId: "replicate",
      modelId: "owner/model:5c7d5dc6",
    });
  });

  test("round-trips", () => {
    for (const key of ["openai:gpt-image-2.5-flare", "higgsfield:soul-v2-standard", "fal:fal-ai/flux/dev"]) {
      const { providerId, modelId } = parseModelKey(key);
      expect(formatModelKey(providerId, modelId)).toBe(key as `${string}:${string}`);
    }
  });

  test("rejects anything else", () => {
    for (const bad of [
      "",
      "google",
      ":model",
      "google:",
      "Google:x",
      "goo gle:x",
      "google:a b",
      "google/gemini",
    ]) {
      expect(safeParseModelKey(bad)).toBeNull();
      expect(isModelKey(bad)).toBe(false);
      expect(() => parseModelKey(bad)).toThrow(TypeError);
    }
    expect(() => formatModelKey("open:ai", "x")).toThrow(TypeError);
    expect(() => formatModelKey("openai", "")).toThrow(TypeError);
  });
});

describe("ULIDs", () => {
  test("are valid and sort in creation order, even within one millisecond", () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect(ids.every(isUlid)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(Math.abs(ulidTime(ids[0]!) - Date.now())).toBeLessThan(5000);
  });
});

describe("addresses", () => {
  test("idempotency and canvas provenance", () => {
    expect(jobIdempotencyKey("01K6BQ8A1C4D7E9F2G3H4J5K6M", 2)).toBe("01K6BQ8A1C4D7E9F2G3H4J5K6M:2");
    const source = canvasSource("01K6BQ8A1C4D7E9F2G3H4J5K6M", "n_gen_1");
    expect(parseCanvasSource(source)).toEqual({ canvasId: "01K6BQ8A1C4D7E9F2G3H4J5K6M", nodeId: "n_gen_1" });
    expect(parseCanvasSource("upload")).toBeNull();
  });

  test("thumb rungs round up and cap at the largest", () => {
    expect(resolveThumbRung(1)).toBe(200);
    expect(resolveThumbRung(456)).toBe(456);
    expect(resolveThumbRung(457)).toBe(640);
    expect(resolveThumbRung(5000)).toBe(640);
    expect(thumbCacheKey("3f9c", { h: 456 })).toBe("3f9c@h456.webp");
    expect(thumbCacheKey("3f9c", { h: 456, dpr: 2 })).toBe("3f9c@h456@2x.webp");
    expect(thumbCacheKey("3f9c", { p: 1440 })).toBe("3f9c@p1440.webp");
    expect(assetThumbUrl("A1", { h: 300, dpr: 2 })).toBe("/files/thumb/A1?h=360&dpr=2");
    expect(assetThumbUrl("A1", "preview")).toBe("/files/thumb/A1?p=1440");
  });

  test("cursors round-trip and reject junk", () => {
    const createdAt = "2026-09-23T12:44:01.882Z";
    const id = "01K6BQ8A1C4D7E9F2G3H4J5K6M";
    const cursor = encodeCursor(createdAt, id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ createdAt, id });
    for (const length of [1, 2, 3, 4]) {
      const text = "x".repeat(length);
      expect(decodeCursor(encodeCursor(text, text))).toEqual({ createdAt: text, id: text });
    }
    expect(decodeCursor("not a cursor!")).toBeNull();
    expect(decodeCursor(encodeCursor("", "x"))).toBeNull();
  });
});

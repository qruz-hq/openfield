import { describe, expect, test } from "bun:test";
import { providerErrorDataSchema } from "@openfield/core";
import { HIDDEN, redact } from "../src/redact";
import {
  errorCodeForStatus,
  errorFromFetchFailure,
  ProviderError,
  readBody,
  retryAfterFromHeaders,
} from "../src/types";

describe("ProviderError", () => {
  test("retryable follows the code, and the copy comes from the catalogue", () => {
    const err = new ProviderError("rate_limited", { retryAfterMs: 5000, httpStatus: 429, providerCode: "X" });
    expect(err.retryable).toBe(true);
    expect(err.userMessage).toBe("Too many requests. Try again in a minute.");
    expect(new ProviderError("auth_invalid").retryable).toBe(false);
    expect(providerErrorDataSchema.parse(err.toJSON())).toEqual(err.toJSON());
  });

  test("fetch failures: timeouts, cancels and network errors", () => {
    expect(errorFromFetchFailure(new DOMException("t", "TimeoutError")).code).toBe("timeout");
    const timedOut = AbortSignal.abort(new DOMException("t", "TimeoutError"));
    expect(errorFromFetchFailure(new DOMException("a", "AbortError"), timedOut).code).toBe("timeout");
    expect(errorFromFetchFailure(new DOMException("a", "AbortError")).code).toBe("canceled");
    expect(errorFromFetchFailure(new TypeError("fetch failed")).code).toBe("network");
    const own = new ProviderError("auth_missing");
    expect(errorFromFetchFailure(own)).toBe(own);
  });

  test("status fallbacks", () => {
    expect([401, 402, 403, 413, 429, 500, 503, 504, 418].map(errorCodeForStatus)).toEqual([
      "auth_invalid",
      "billing_required",
      "auth_forbidden",
      "payload_too_large",
      "rate_limited",
      "provider_unavailable",
      "provider_unavailable",
      "timeout",
      "unknown",
    ]);
  });

  test("Retry-After in seconds or as a date", () => {
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "12" }))).toBe(12_000);
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "Wed, 23 Sep 2026 12:00:30 GMT" }), now)).toBe(
      30_000,
    );
    expect(retryAfterFromHeaders(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
  });

  test("readBody never throws", async () => {
    expect(await readBody(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await readBody(new Response("oops"))).toBe("oops");
    expect(await readBody(new Response(""))).toBeUndefined();
  });
});

describe("redact", () => {
  test("hides loaded keys, auth headers and key-shaped strings", () => {
    const key = "super-secret-key-123";
    const out = redact(
      {
        url: `https://x.example/?q=${key}`,
        headers: new Headers({ "x-goog-api-key": key, accept: "json" }),
        nested: [
          { Authorization: `Bearer ${key}` },
          "sk-abcdefghijklmnopqrstu",
          "AIzaSyD0123456789abcdefghijk",
        ],
        bytes: new Uint8Array(10),
        err: new Error(`failed with ${key}`),
      },
      [key],
    );
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.headers).toEqual({ "x-goog-api-key": HIDDEN, accept: "json" } as never);
    expect(out.nested).toEqual([{ Authorization: HIDDEN }, HIDDEN, HIDDEN] as never);
    expect(out.bytes).toBe("[10 bytes]" as never);
    expect((out.err as unknown as { message: string }).message).toBe(`failed with ${HIDDEN}`);
  });

  test("doesn't change its input, and survives cycles", () => {
    const input: Record<string, unknown> = { a: "keep" };
    input.self = input;
    const out = redact(input) as Record<string, unknown>;
    expect(out.self).toBe("[circular]");
    expect(input.self).toBe(input);
  });

  test("short values aren't treated as keys", () => {
    expect(redact("the cat sat", ["cat"])).toBe("the cat sat");
  });
});

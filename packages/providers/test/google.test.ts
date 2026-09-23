import { describe, expect, test } from "bun:test";
import { type NormalizedRequest, newId } from "@openfield/core";
import { createGoogleProvider } from "../src/google";
import success from "../src/google/__fixtures__/generate-success.json";
import { manifestFor, recognise, variantOf } from "../src/google/discovery";
import { mapError, refusal } from "../src/google/errors";
import { toGeminiRequest } from "../src/google/map-request";
import { pickImage, toJobResult, usageOf, withoutImageData } from "../src/google/map-response";
import { GOOGLE_MODELS } from "../src/google/models";
import { createTestContext } from "../src/testing/context";
import { createFakeFetch } from "../src/testing/fake-fetch";
import { googleFake } from "../src/testing/google";
import { ProviderError } from "../src/types";

const byId = (id: string) => GOOGLE_MODELS.find((m) => m.modelId === id)!;
const pro = byId("gemini-3-pro-image");
const flash = byId("gemini-3.1-flash-image");
const lite = byId("gemini-3.1-flash-lite-image");

const call = (overrides: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  idempotencyKey: newId(),
  model: pro.key,
  op: "generate",
  prompt: "A fox in snow",
  promptAfterPreset: "A fox in snow",
  size: { aspect: "16:9" },
  resolution: "2K",
  batch: 1,
  source: "api",
  jobId: newId(),
  jobSetId: newId(),
  batchIndex: 0,
  manifestVersion: "1",
  paramsHash: `sha256:${"a".repeat(64)}`,
  speed: "standard",
  speedRequested: "standard",
  providerSettings: {},
  ...overrides,
});

const fixtureResponse = (name: keyof typeof googleFake.fixtures) => {
  const exchange = googleFake.fixtures[name]!;
  return new Response(JSON.stringify(exchange.response.body), {
    status: exchange.response.status,
    headers: exchange.response.headers,
  });
};

describe("catalog", () => {
  test("uses the Nano Banana names and the verified ids", () => {
    expect(GOOGLE_MODELS.map((m) => [m.displayName, m.key])).toEqual([
      ["Nano Banana Pro", "google:gemini-3-pro-image"],
      ["Nano Banana 2", "google:gemini-3.1-flash-image"],
      ["Nano Banana 2 Lite", "google:gemini-3.1-flash-lite-image"],
    ]);
  });

  test("ratios and tiers follow Google's tables", () => {
    const ratios = (id: string) => {
      const size = byId(id).capabilities.size;
      return size.mode === "aspect" ? size.ratios : [];
    };
    expect(ratios("gemini-3-pro-image")).not.toContain("1:8");
    expect(ratios("gemini-3.1-flash-image")).toEqual(expect.arrayContaining(["1:4", "4:1", "1:8", "8:1"]));
    expect(ratios("gemini-3.1-flash-image")).toHaveLength(15);
    expect(flash.capabilities.resolution?.tiers).toEqual(["512", "1K", "2K", "4K"]);
    expect(lite.capabilities.resolution?.tiers).toEqual(["1K"]);
  });

  test("copy stays short and never uses an em dash", () => {
    for (const m of GOOGLE_MODELS) {
      const strings = [m.displayName, m.description ?? "", ...(m.capabilities.safety?.notices ?? [])];
      for (const s of Object.values(m.capabilities.unsupported ?? {})) strings.push(s?.reason ?? "");
      for (const f of Object.values(m.capabilities.extraSchema?.properties ?? {})) {
        strings.push(f.title, f.description ?? "");
      }
      for (const s of strings) expect(s).not.toContain("—");
      expect((m.description ?? "").length).toBeLessThanOrEqual(90);
    }
  });
});

describe("toGeminiRequest", () => {
  test("text first, then the base and references, image-only output", () => {
    const body = toGeminiRequest(pro, call({ op: "edit" }), [
      { mimeType: "image/png", data: "AAAA" },
      { mimeType: "image/jpeg", data: "BBBB" },
    ]);
    expect(body).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { text: "A fox in snow" },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
            { inlineData: { mimeType: "image/jpeg", data: "BBBB" } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
      },
    });
  });

  test("auto leaves the ratio out; a one-size model gets no imageSize", () => {
    expect(
      toGeminiRequest(pro, call({ size: { aspect: "auto" }, resolution: "1K" }), []).generationConfig,
    ).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: "1K" },
    });
    const liteBody = toGeminiRequest(
      lite,
      call({ model: lite.key, size: { aspect: "auto" }, resolution: "1K" }),
      [],
    );
    expect(liteBody.generationConfig.imageConfig).toBeUndefined();
  });

  test("Advanced fields reach the wire only on models that declare them", () => {
    const options = { thinking: "high", grounding: true };
    const onFlash = toGeminiRequest(flash, call({ model: flash.key, providerOptions: options }), []);
    expect(onFlash.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
    expect(onFlash.tools).toEqual([{ googleSearch: {} }]);
    const onPro = toGeminiRequest(pro, call({ providerOptions: options }), []);
    expect(onPro.generationConfig.thinkingConfig).toBeUndefined();
    expect(onPro.tools).toEqual([{ googleSearch: {} }]);
    const onLite = toGeminiRequest(lite, call({ model: lite.key, providerOptions: options }), []);
    expect(onLite.tools).toBeUndefined();
  });
});

describe("responses", () => {
  test("takes the last image that isn't a thought", () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, inlineData: { mimeType: "image/png", data: "draft" } },
              { text: "Here you go" },
              { inlineData: { mimeType: "image/jpeg", data: "final" } },
            ],
          },
        },
      ],
    };
    expect(pickImage(body)).toEqual({ mimeType: "image/jpeg", data: "final" });
    expect(pickImage({ candidates: [{ content: { parts: [{ text: "no" }] } }] })).toBeUndefined();
  });

  test("the documented success shape becomes a saved asset", async () => {
    const ctx = createTestContext({ fetch: createFakeFetch({ delayMs: 0 }) });
    const body = success.response.body;
    const image = pickImage(body)!;
    const result = await toJobResult(body, image, call({ batchIndex: 2 }), ctx, 1000);
    expect(result.images).toEqual([
      expect.objectContaining({ index: 2, width: 12, height: 16, mimeType: "image/png" }),
    ]);
    expect(ctx.assets.written[0]?.bytes.byteLength).toBe(result.images[0]?.bytes);
    expect(result.usage?.outputImageTokens).toBe(1120);
    expect(JSON.stringify(result.providerRaw)).not.toContain(image.data);
  });

  test("an image URL is refused: images only arrive inline", () => {
    expect(() => pickImage(googleFake.fixtures.foreign_asset?.response.body)).toThrow(ProviderError);
  });

  test("usage splits tokens by modality and keeps thinking for reconciliation", () => {
    expect(usageOf(successBody())).toEqual({
      imagesBilled: 1,
      inputTextTokens: 14,
      outputImageTokens: 1120,
      raw: {
        promptTokenCount: 14,
        candidatesTokenCount: 1120,
        thoughtsTokenCount: 212,
        totalTokenCount: 1346,
      },
    });
  });

  test("the stored payload swaps image data for its size", () => {
    const stored = JSON.stringify(withoutImageData(successBody()));
    expect(stored).toContain("bytes]");
    expect(stored).not.toContain("iVBORw0KGgo");
  });
});

function successBody() {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAA" } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 14,
      candidatesTokenCount: 1120,
      thoughtsTokenCount: 212,
      totalTokenCount: 1346,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 14 }],
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    },
  };
}

describe("mapError", () => {
  const cases: [keyof typeof googleFake.fixtures, string, boolean][] = [
    ["bad_key", "auth_invalid", false],
    ["forbidden", "auth_forbidden", false],
    ["invalid", "invalid_request", false],
    ["rate_limited", "rate_limited", true],
    ["no_billing", "billing_required", false],
    ["server_error", "provider_unavailable", true],
    ["unavailable", "provider_unavailable", true],
    ["blocked", "content_refused", false],
    ["refused", "content_refused", false],
    ["no_image", "content_refused", false],
  ];
  for (const [fixture, code, retryable] of cases) {
    test(`${fixture} → ${code}`, async () => {
      const err = await mapError(fixtureResponse(fixture));
      expect(err.code).toBe(code as never);
      expect(err.retryable).toBe(retryable);
      expect(err.userMessage).toBeTruthy();
      expect(err.providerCode).toBeTruthy();
    });
  }

  test("rate limits read RetryInfo and say when", async () => {
    const err = await mapError(fixtureResponse("rate_limited"));
    expect(err.retryAfterMs).toBe(12_000);
    expect(err.userMessage).toBe("Too many requests. Trying again in 12s.");
    expect(err.providerCode).toBe("RESOURCE_EXHAUSTED");
  });

  test("a Retry-After header wins over the body", async () => {
    const body = googleFake.fixtures.rate_limited?.response.body;
    const res = new Response(JSON.stringify(body), { status: 429, headers: { "retry-after": "3" } });
    expect((await mapError(res)).retryAfterMs).toBe(3000);
  });

  test("a daily quota isn't retried", async () => {
    const body = {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Quota exceeded",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel", quotaValue: "250" }],
          },
        ],
      },
    };
    const err = await mapError(new Response(JSON.stringify(body), { status: 429 }), body);
    expect(err.code).toBe("quota_exceeded");
    expect(err.retryable).toBe(false);
  });

  test("a 400 about one setting names the field", async () => {
    const body = {
      error: { code: 400, status: "INVALID_ARGUMENT", message: "Unsupported aspect ratio: 7:3" },
    };
    const err = await mapError(new Response(JSON.stringify(body), { status: 400 }));
    expect([err.code, err.field]).toEqual(["unsupported_param", "size"]);
  });

  test("the Interactions-style codes map too", async () => {
    const body = { error: { code: "payment_required", message: "Your Prepay credit balance is depleted." } };
    expect((await mapError(new Response(JSON.stringify(body), { status: 402 }))).code).toBe(
      "billing_required",
    );
  });

  test("an unsupported country is access, not credit", async () => {
    const body = {
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "User location is not supported for the API use.",
      },
    };
    expect((await mapError(new Response(JSON.stringify(body), { status: 400 }))).code).toBe("auth_forbidden");
  });

  test("non-JSON bodies and odd statuses still map", async () => {
    expect((await mapError(new Response("<html>bad gateway</html>", { status: 502 }))).code).toBe(
      "provider_unavailable",
    );
    expect((await mapError(new Response("", { status: 504 }))).code).toBe("timeout");
    expect((await mapError(new Response("{}", { status: 418 }))).code).toBe("unknown");
  });

  test("keys never survive into the message", async () => {
    const body = {
      error: { code: 400, status: "INVALID_ARGUMENT", message: "bad key=AIzaSyDexample1234567890abcdefghij" },
    };
    const err = await mapError(new Response(JSON.stringify(body), { status: 400 }));
    expect(err.message).not.toContain("AIzaSy");
  });

  test("a 200 with an image isn't a refusal; one without is", () => {
    expect(
      refusal({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Sorry" }] } }] })?.code,
    ).toBe("content_refused");
    expect(refusal({ candidates: [{ finishReason: "IMAGE_OTHER" }] })?.code).toBe("provider_error");
    expect(refusal({})).toBeUndefined();
  });
});

describe("discovery", () => {
  test("recognises families, previews and snapshots, and nothing else", () => {
    for (const id of ["gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-09-2026"]) {
      expect(recognise(id)).toBe(true);
    }
    for (const id of [
      "gemini-3.8-flash",
      "gemini-2.5-flash-image",
      "imagen-4.0-generate",
      "gemini-3-pro-image-x",
    ]) {
      expect(recognise(id)).toBe(false);
    }
  });

  test("a recognised new id borrows its family's capabilities", () => {
    const preview = manifestFor("gemini-3-pro-image-preview");
    expect(preview).toMatchObject({
      key: "google:gemini-3-pro-image-preview",
      displayName: "Nano Banana Pro (preview)",
      badges: ["preview"],
      source: "discovered",
    });
    expect(preview?.capabilities).toEqual(pro.capabilities);
    expect(manifestFor("gemini-3.8-flash")).toBeUndefined();
  });

  test("a preview of a model the key also lists isn't a second model", async () => {
    const provider = createGoogleProvider();
    const ctx = createTestContext({
      fetch: createFakeFetch({ delayMs: 0 }),
      credentials: { apiKey: "test-key-123456" },
    });
    const models = await provider.listModels(ctx);
    expect(models.map((m) => m.modelId)).toEqual([
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
    ]);
    expect(await provider.verifyCredentials(ctx)).toEqual({ ok: true, modelCount: 3 });
  });

  test("a preview shows when the key only lists the preview", async () => {
    const provider = createGoogleProvider();
    const ctx = createTestContext({
      fetch: createFakeFetch({ delayMs: 0, hiddenModels: ["gemini-3-pro-image"] }),
      credentials: { apiKey: "test-key-123456" },
    });
    const models = await provider.listModels(ctx);
    expect(models.map((m) => m.modelId)).toContain("gemini-3-pro-image-preview");
    expect(variantOf("gemini-3-pro-image-preview")).toBe("gemini-3-pro-image");
    expect(variantOf("gemini-3.1-flash-image-09-2026")).toBe("gemini-3.1-flash-image");
    expect(variantOf("gemini-3-pro-image")).toBeUndefined();
  });

  test("no key means auth_missing, before any request", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const ctx = createTestContext({ fetch, credentials: {} });
    const err = await createGoogleProvider()
      .verifyCredentials(ctx)
      .catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("auth_missing");
    expect(fetch.calls).toHaveLength(0);
  });

  test("model() binds cataloged and recognised keys and refuses the rest", () => {
    const provider = createGoogleProvider();
    expect(provider.model("google:gemini-3.1-flash-image").displayName).toBe("Nano Banana 2");
    expect(provider.model("google:gemini-3.1-flash-image-preview").source).toBe("discovered");
    expect(() => provider.model("google:gemini-3.8-flash")).toThrow("Unknown model");
    expect(() => provider.model("openai:gpt-image-2")).toThrow("Unknown model");
  });

  test("validateCredentials only checks shape", () => {
    const provider = createGoogleProvider();
    expect(provider.validateCredentials({ apiKey: "anything" })).toEqual([]);
    expect(provider.validateCredentials({ apiKey: "  " })[0]).toMatchObject({
      level: "error",
      field: "apiKey",
    });
  });
});

describe("submit", () => {
  const provider = createGoogleProvider();
  const model = provider.model(pro.key);

  test("an already-canceled run fails as canceled without a request", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const ctx = createTestContext({
      fetch,
      credentials: { apiKey: "k-123456789" },
      signal: AbortSignal.abort(),
    });
    const err = await model.submit(call(), ctx).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("canceled");
    expect(fetch.calls).toHaveLength(0);
  });

  test("a missing reference is a bad request, not a network error", async () => {
    const fetch = createFakeFetch({ delayMs: 0 });
    const ctx = createTestContext({ fetch, credentials: { apiKey: "k-123456789" } });
    const err = await model
      .submit(call({ references: [{ assetId: newId(), role: "style" }] }), ctx)
      .catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("invalid_request");
    expect(fetch.calls).toHaveLength(0);
  });

  test("a reference over the size limit says how big it can be", async () => {
    const small = {
      ...pro,
      capabilities: { ...pro.capabilities, references: { ...pro.capabilities.references, maxBytes: 10 } },
    };
    const ctx = createTestContext({
      fetch: createFakeFetch({ delayMs: 0 }),
      credentials: { apiKey: "k-123456789" },
    });
    const id = await ctx.assets.add(new Uint8Array(64), "image/png");
    const err = await provider
      .model(pro.key, small)
      .submit(call({ references: [{ assetId: id, role: "style" }] }), ctx)
      .catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("payload_too_large");
    expect((err as ProviderError).userMessage).toContain("The limit is");
  });

  test("ops Gemini can't do are refused before any request", async () => {
    const ctx = createTestContext({
      fetch: createFakeFetch({ delayMs: 0 }),
      credentials: { apiKey: "k-123456789" },
    });
    const err = await model.submit(call({ op: "upscale" }), ctx).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("capability_unsupported");
  });
});

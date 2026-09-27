// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { type ModelListItem, t } from "@openfield/core";
import { estimateRun, generateState, resolveValues } from "@openfield/providers/manifest";
import { speedPrice } from "../src/lib/cost";
import { askedPrice, isPricePending } from "../src/lib/remote-price";
import { banana } from "./fixtures";

// A model its company prices per request (Higgsfield) is asked through the server's estimate
// route (§6.9). Until the answer lands the price is pending (no price, never "Cost unknown"), then
// it's the company's answer, kept for repeats. The server here is a stub that prices $0.004 an image.

const realFetch = globalThis.fetch;
const asked: { batch: number; resolution?: string }[] = [];
let failing = false;

// The typed client reads the session token from the page; this one has none.
const hadDocument = "document" in globalThis;
if (!hadDocument) globalThis.document = { querySelector: () => null } as unknown as Document;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")));
  asked.push({ batch: body.batch, resolution: body.resolution });
  if (failing) throw new TypeError("Failed to fetch");
  const each = body.resolution === "2K" ? 0.006 : 0.004;
  return Response.json({
    currency: "USD",
    min: each * body.batch,
    max: each * body.batch,
    confidence: "estimated",
    basis: `${body.batch} × $${each.toFixed(3)} (0.05 credits)`,
    pricedAt: "2026-09-27",
  });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  if (!hadDocument) Reflect.deleteProperty(globalThis, "document");
});

let n = 0;
/** A fresh model each test, so answers kept by earlier tests don't leak in. */
function perRequest(overrides: Partial<ModelListItem> = {}): ModelListItem {
  n++;
  return {
    ...banana,
    key: `higgsfield:model-${n}`,
    providerId: "higgsfield",
    modelId: `model-${n}`,
    price: {
      kind: "provider_estimate",
      currency: "USD",
      pricedAt: "2026-09-27",
      sourceUrl: "https://open.higgsfield.ai/pricing",
    },
    ...overrides,
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const run = (model: ModelListItem, batch = 1, resolution?: "1K" | "2K", prompt = "a kite") =>
  estimateRun(
    model,
    resolveValues(model.capabilities, resolution ? { resolution } : {}, batch),
    prompt,
    "standard",
    {},
    askedPrice,
  );

beforeEach(() => {
  asked.length = 0;
  failing = false;
});

describe("prices a company answers per request", () => {
  test("pending until the company answers, then its answer, asked once whatever the prompt", async () => {
    const model = perRequest();
    const first = run(model);
    expect(isPricePending(first)).toBe(true);
    // The Generate button shows no price line yet, not "Cost unknown".
    const resolved = resolveValues(model.capabilities, {}, 1);
    expect(
      generateState({ model, anyReady: true, prompt: "a kite", resolved, askPrice: askedPrice }),
    ).toEqual({
      kind: "ready",
      estimate: undefined,
    });
    // Settings shows nothing rather than "Cost unknown" while it's asked.
    expect(
      speedPrice(model, {
        speed: "standard",
        requested: "standard",
        fellBack: false,
        name: "",
        requestedName: "",
      }),
    ).toEqual({ pending: true });

    await settle();
    const answered = run(model);
    expect(answered).toMatchObject({ min: 0.004, max: 0.004, confidence: "estimated" });
    expect(answered.basis).toBe("1 × $0.004 (0.05 credits)");
    expect(run(model, 1, undefined, "a lighthouse at dusk")).toEqual(answered);
    expect(asked).toHaveLength(1);
  });

  test("another image count shows the last price for that many while its own answer comes", async () => {
    const model = perRequest();
    run(model);
    await settle();
    const three = run(model, 3);
    expect(isPricePending(three)).toBe(false);
    expect(three).toMatchObject({ min: 0.012, max: 0.012, basis: "3 × $0.004" });
    await settle();
    expect(run(model, 3).basis).toBe("3 × $0.004 (0.05 credits)");
    // Another resolution is another price.
    run(model, 1, "2K");
    await settle();
    expect(run(model, 1, "2K")).toMatchObject({ min: 0.006 });
    expect(asked.map((a) => a.batch)).toEqual([1, 3, 1]);
  });

  test("with no key the company isn't asked, and the price is plainly unknown", async () => {
    const model = perRequest({ ready: false });
    const cost = run(model);
    expect(cost.confidence).toBe("unknown");
    expect(isPricePending(cost)).toBe(false);
    await settle();
    expect(asked).toHaveLength(0);
  });

  test("a server that can't be reached reads as unknown, not as waiting forever", async () => {
    failing = true;
    const model = perRequest();
    expect(isPricePending(run(model))).toBe(true);
    await settle();
    const cost = run(model);
    expect(isPricePending(cost)).toBe(false);
    expect(cost).toMatchObject({ confidence: "unknown", basis: t("cost.unknown") });
  });
});

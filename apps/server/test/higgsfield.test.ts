import { afterEach, describe, expect, test } from "bun:test";
import {
  type CanvasDetail,
  type CostEstimate,
  canvasRunResponseSchema,
  type ModelsListResponse,
  type ProviderSummary,
  type Settings,
  t,
} from "@openfield/core";
import { getJobSet, jobsOf } from "@openfield/db";
import {
  builtinProviders,
  createFakeFetch,
  type FetchLike,
  type Provider,
} from "@openfield/providers/server";
import { call, item, newCanvas } from "./canvas-helpers";
import { completed, generate, startTestServer, type TestServer } from "./helpers";

// The Higgsfield adapter through the whole server, against its fake: a queue call that the runner
// follows by id, an image downloaded from the declared image host past the host allow-list, and
// prices asked of Higgsfield's estimate endpoint (§6.9), which answers SOUL V2 at $0.004 at 1K and
// $0.006 at 2K, as it did live.

const HF_KEY = "hf-test-id:hf-test-secret-4d1a";
const SOUL_V2 = "higgsfield:soul-v2";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The fake, counting calls to Higgsfield's estimate endpoint. `down` answers them with a 500. */
function counting(opts: { down?: boolean } = {}) {
  const inner = createFakeFetch({ delayMs: 0 });
  const seen = { estimates: 0, higgsfield: 0 };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.host === "api.higgsfield.ai") seen.higgsfield++;
    if (url.host === "api.higgsfield.ai" && url.pathname.startsWith("/estimate/")) {
      seen.estimates++;
      if (opts.down)
        return new Response(JSON.stringify({ detail: "Internal Server Error" }), { status: 500 });
    }
    return inner(input, init);
  };
  return { fetch, seen };
}

async function withKey(s: TestServer): Promise<void> {
  const saved = await s.json("/api/settings/keys/higgsfield", { method: "PUT", body: { apiKey: HF_KEY } });
  expect(saved.status).toBe(200);
}

const price = (s: TestServer, body: Record<string, unknown>, model = "soul-v2") =>
  s.json<CostEstimate>(`/api/models/higgsfield/${model}/estimate`, {
    method: "POST",
    body: { op: "generate", batch: 1, ...body },
  });

describe("Higgsfield through the runner", () => {
  test("a SOUL V2 image is followed by its request id, saved from the image host, and costed", async () => {
    server = await startTestServer();
    await withKey(server);

    const accepted = await generate(server, {
      model: SOUL_V2,
      size: { kind: "aspect", ratio: "3:4" },
      batch: 2,
    });
    const done = await completed(server, accepted.jobSet.id, 20_000);
    expect(done.status).toBe("succeeded");

    const db = server.services.db;
    const set = getJobSet(db, accepted.jobSet.id);
    expect(set?.providerId).toBe("higgsfield");
    // Priced as it was sent: two images at Higgsfield's $0.004.
    expect(set?.costEstimateUsd).toBe(0.008);
    const [job] = jobsOf(db, accepted.jobSet.id);
    // Resumable: the request id was stored before the first status read.
    expect(job?.providerJobId).toBeTruthy();
    const usage = db.$client
      .query<{ outcome: string; cost_usd: number; cost_source: string }, [string]>(
        "SELECT outcome, cost_usd, cost_source FROM usage_log WHERE job_set_id = ? ORDER BY batch_index",
      )
      .all(accepted.jobSet.id);
    expect(usage).toEqual([
      { outcome: "succeeded", cost_usd: 0.004, cost_source: "estimated" },
      { outcome: "succeeded", cost_usd: 0.004, cost_source: "estimated" },
    ]);
  }, 30_000);

  test("Run again keeps the price its run was sent at, without asking again", async () => {
    const { fetch, seen } = counting();
    server = await startTestServer({ fetch });
    await withKey(server);
    const first = await generate(server, { model: SOUL_V2, size: { kind: "aspect", ratio: "1:1" } });
    await completed(server, first.jobSet.id, 20_000);
    const asked = seen.estimates;

    const again = await server.json<{ jobSet: { id: string } }>(`/api/job-sets/${first.jobSet.id}/recreate`, {
      method: "POST",
    });
    expect(again.status).toBe(202);
    expect(getJobSet(server.services.db, again.body.jobSet.id)?.costEstimateUsd).toBe(0.004);
    expect(seen.estimates).toBe(asked);
  }, 30_000);

  test("an image from an undeclared host fails the run at once, with the reason", async () => {
    server = await startTestServer();
    await withKey(server);
    const accepted = await generate(server, {
      model: SOUL_V2,
      prompt: "A kite #fake:foreign_asset",
      size: { kind: "aspect", ratio: "1:1" },
    });
    const started = Date.now();
    const done = await completed(server, accepted.jobSet.id, 20_000);
    expect(done.status).toBe("failed");
    // The fake finishes within two seconds; re-reading until the deadline would take far longer.
    expect(Date.now() - started).toBeLessThan(10_000);
    const [job] = jobsOf(server.services.db, accepted.jobSet.id);
    expect(job).toMatchObject({ status: "failed", errorCode: "provider_error" });
    expect(job?.errorReason).toBe(t("errors.imageBlocked"));
  }, 30_000);
});

describe("Higgsfield's prices come from its estimate endpoint", () => {
  test("the estimate route answers Higgsfield's price for the settings, in dollars with credits in the note", async () => {
    server = await startTestServer();
    await withKey(server);
    const two = await price(server, { batch: 2, size: { kind: "aspect", ratio: "1:1" }, resolution: "1K" });
    expect(two.status).toBe(200);
    expect(two.body).toMatchObject({ currency: "USD", min: 0.008, max: 0.008, confidence: "estimated" });
    expect(two.body.basis).toBe("2 × $0.004 (0.05 credits)");
    // 2K is 1080p on SOUL, which Higgsfield prices higher.
    const sharper = await price(server, { size: { kind: "aspect", ratio: "1:1" }, resolution: "2K" });
    expect(sharper.body).toMatchObject({ min: 0.006, max: 0.006 });
  });

  test("the same request is asked once a day, whatever its prompt or image count", async () => {
    const { fetch, seen } = counting();
    server = await startTestServer({ fetch });
    await withKey(server);
    const size = { kind: "aspect", ratio: "3:4" };
    await price(server, { size, prompt: "A kite over wheat fields" });
    await price(server, { size, prompt: "A lighthouse at dusk", batch: 4 });
    await Promise.all([price(server, { size }), price(server, { size })]);
    expect(seen.estimates).toBe(1);
    // Another resolution is another price.
    await price(server, { size, resolution: "2K" });
    expect(seen.estimates).toBe(2);
  });

  test("with no key, or when Higgsfield can't answer, the price is unknown and nothing breaks", async () => {
    const { fetch, seen } = counting({ down: true });
    server = await startTestServer({ fetch });
    const size = { kind: "aspect", ratio: "1:1" };
    const noKey = await price(server, { size });
    expect(noKey.status).toBe(200);
    expect(noKey.body.confidence).toBe("unknown");
    expect(seen.estimates).toBe(0);

    await withKey(server);
    const down = await price(server, { size });
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ confidence: "unknown", basis: t("cost.unknown") });
    // A run still goes out, priced as unknown.
    const accepted = await generate(server, { model: SOUL_V2, size });
    expect(getJobSet(server.services.db, accepted.jobSet.id)?.costEstimateUsd).toBeNull();
    await completed(server, accepted.jobSet.id, 20_000);
  }, 30_000);

  test("a token-priced model's estimate has no amount, so it stays unknown", async () => {
    server = await startTestServer();
    await withKey(server);
    const res = await price(server, { size: { kind: "auto" } }, "marketing-studio-image-2.5-flare");
    expect(res.body.confidence).toBe("unknown");
  });

  test("a model's usual price is its defaults' price, for Settings", async () => {
    const { fetch, seen } = counting();
    server = await startTestServer({ fetch });
    await withKey(server);
    // No size and no resolution: SOUL V2's own defaults (1:1 at 1K, so 720p).
    const usual = await price(server, {});
    expect(usual.body).toMatchObject({ min: 0.004, confidence: "estimated" });
    await price(server, {});
    expect(seen.estimates).toBe(1);
  });

  test("a canvas run's preview prices a Higgsfield node from the same answer", async () => {
    server = await startTestServer();
    await withKey(server);
    const canvas = await newCanvas(server);
    const plan = [
      item("n_gen", {
        model: SOUL_V2,
        calls: [call({ model: SOUL_V2, batch: 3, size: { kind: "aspect", ratio: "1:1" } })],
      }),
    ];
    const res = canvasRunResponseSchema.parse(
      (
        await server.json(`/api/canvases/${canvas.id}/run`, {
          method: "POST",
          body: { scope: "node", nodeIds: ["n_gen"], plan, dryRun: true },
        })
      ).body,
    );
    expect(res.nodes[0]?.estimate).toMatchObject({ min: 0.012, max: 0.012, confidence: "estimated" });
  });
});

describe("Higgsfield is a regular company now", () => {
  test("its key card and models show without Settings > Experimental", async () => {
    server = await startTestServer();
    const providers = (await server.json<ProviderSummary[]>("/api/providers")).body;
    expect(providers.find((p) => p.id === "higgsfield")?.meta.stable).toBe(true);
    const models = (await server.json<ModelsListResponse>("/api/models")).body.models;
    expect(models.some((m) => m.key === SOUL_V2)).toBe(true);
  });

  test("its first working key picks its first model as the default, like any company's", async () => {
    server = await startTestServer();
    const check = await server.json("/api/settings/keys/higgsfield/test", {
      method: "POST",
      body: { apiKey: HF_KEY },
    });
    expect(check.body).toMatchObject({ ok: true });
    expect((await server.json<Settings>("/api/settings")).body.defaultModel).toBe("higgsfield:soul");
  });
});

// The mechanism stays for companies whose adapter isn't checked against the real API yet. A copy
// of Higgsfield marked early stands in for one.
describe("an early company (meta.stable false)", () => {
  const early = (): Provider[] => {
    const higgsfield = builtinProviders.find((p) => p.meta.id === "higgsfield")!;
    return [
      ...builtinProviders.filter((p) => p !== higgsfield),
      { ...higgsfield, meta: { ...higgsfield.meta, stable: false } },
    ];
  };
  const earlyModels = async (s: TestServer) =>
    (await s.json<ModelsListResponse>("/api/models")).body.models.filter(
      (m) => m.providerId === "higgsfield",
    );

  test("its models stay off the list until Show early models is on", async () => {
    server = await startTestServer({ providers: early() });
    expect(await earlyModels(server)).toEqual([]);
    expect((await server.json(`/api/models/higgsfield/soul-v2`)).status).toBe(404);
    // The company itself stays listed, so its name still labels past work and spending.
    const providers = (await server.json<ProviderSummary[]>("/api/providers")).body;
    expect(providers.find((p) => p.id === "higgsfield")?.meta.stable).toBe(false);

    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    const shown = await earlyModels(server);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((m) => !m.ready)).toBe(true);
  });

  test("while hidden, the model check never calls it, even with a key", async () => {
    const { fetch, seen } = counting();
    server = await startTestServer({ providers: early(), fetch });
    await withKey(server);
    await server.json("/api/models/refresh", { method: "POST", body: {} });
    expect(seen.higgsfield).toBe(0);

    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    await server.json("/api/models/refresh", { method: "POST", body: {} });
    expect(seen.higgsfield).toBeGreaterThan(0);
  });

  test("a working key never makes it the default model", async () => {
    server = await startTestServer({ providers: early() });
    await server.json("/api/settings", { method: "PATCH", body: { showExperimental: true } });
    const check = await server.json("/api/settings/keys/higgsfield/test", {
      method: "POST",
      body: { apiKey: HF_KEY },
    });
    expect(check.body).toMatchObject({ ok: true });
    expect((await earlyModels(server)).every((m) => m.ready)).toBe(true);
    expect((await server.json<Settings>("/api/settings")).body.defaultModel).toBeNull();

    // A new canvas has nothing to fill its Generate node with either.
    const canvas = await server.json<CanvasDetail>("/api/canvases", {
      method: "POST",
      body: { templateId: "storyboard" },
    });
    expect(canvas.status).toBe(201);
    expect(canvas.body.graph.nodes.some((n) => typeof n.params.model === "string")).toBe(false);
  });
});

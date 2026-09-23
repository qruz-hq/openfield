import { afterEach, describe, expect, test } from "bun:test";
import {
  type CostEstimate,
  type JobSetAccepted,
  type UsageResponse,
  usageResponseSchema,
} from "@openfield/core";
import { getJob, getJobSet } from "@openfield/db";
import { createFakeFetch, type FetchLike } from "@openfield/providers/server";
import {
  completed,
  gatedFetch,
  generate,
  googleError,
  isGenerateCall,
  saveKey,
  startTestServer,
  type TestServer,
  waitFor,
} from "./helpers";

// §0.3, §0.4, §0.12 and §0.13: speeds come only from company settings, a model without the chosen
// speed runs at Standard, Flex waits out busy answers or switches, and cost follows the speed served.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PRO = "google:gemini-3-pro-image";
const NB2 = "google:gemini-3.1-flash-image";

interface Sent {
  model: string;
  serviceTier?: string;
}

/** The fake, plus every image call's model and speed. `busy` answers Flex calls with a 503 while it returns true. */
function recordingFetch(busy: (n: number) => boolean = () => false) {
  const fake = createFakeFetch({ delayMs: 0 });
  const sent: Sent[] = [];
  let flexCalls = 0;
  const fetch: FetchLike = async (input, init) => {
    if (!isGenerateCall(input)) return fake(input, init);
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { serviceTier?: string };
    sent.push({
      model: /models\/([^:]+):/.exec(url)![1]!,
      ...(body.serviceTier && { serviceTier: body.serviceTier }),
    });
    if (body.serviceTier === "flex" && busy(++flexCalls)) {
      return googleError(503, "UNAVAILABLE", "The service is currently unavailable.");
    }
    return fake(input, init);
  };
  return { fetch, sent };
}

const setSpeed = (s: TestServer, values: Record<string, string>) =>
  s.json("/api/providers/google/settings", { method: "PATCH", body: { values } });

const usageRows = (s: TestServer) =>
  s.services.db.$client
    .query<
      {
        outcome: string;
        cost_usd: number | null;
        speed: string | null;
        simulated: number;
        discarded: number;
      },
      []
    >("SELECT outcome, cost_usd, speed, simulated, discarded FROM usage_log ORDER BY id")
    .all();

describe("speed per model", () => {
  test("a model without the chosen speed runs at Standard; one that has it runs at it", async () => {
    const rec = recordingFetch();
    server = await startTestServer({ fetch: rec.fetch });
    await saveKey(server);
    await setSpeed(server, { speed: "flex" });

    const nb2 = await generate(server, { model: NB2 });
    expect(nb2.jobSet.speed).toBe("standard");
    const pro = await generate(server, { model: PRO });
    expect(pro.jobSet.speed).toBe("flex");
    await completed(server, nb2.jobSet.id);
    await completed(server, pro.jobSet.id);

    const frozen = getJobSet(server.services.db, nb2.jobSet.id)!.requestJson;
    expect([frozen.speed, frozen.speedRequested]).toEqual(["standard", "flex"]);
    expect(frozen.providerSettings).toEqual({ speed: "standard", flexBusy: "wait" });
    expect(rec.sent).toEqual([
      { model: "gemini-3.1-flash-image" },
      { model: "gemini-3-pro-image", serviceTier: "flex" },
    ]);

    // Priced and billed at the speed each one ran at: NB2 at Standard, Pro at Flex (half price).
    expect(nb2.jobSet.costEstimateUsd).toBe(0.067);
    expect(pro.jobSet.costEstimateUsd).toBe(0.067);
    expect(usageRows(server).map((r) => [r.speed, r.cost_usd])).toEqual([
      ["standard", 0.067],
      ["flex", 0.067],
    ]);
    expect(getJob(server.services.db, pro.jobs[0]!.id)!.speedUsed).toBe("flex");
  });

  test("the estimate route prices at the speed the settings resolve to for that model", async () => {
    server = await startTestServer();
    await setSpeed(server, { speed: "batch" });
    const body = { op: "generate", batch: 2, size: { kind: "aspect", ratio: "1:1" } };
    const nb2 = await server.json<CostEstimate>("/api/models/google/gemini-3.1-flash-image/estimate", {
      method: "POST",
      body,
    });
    expect(nb2.status).toBe(200);
    expect(nb2.body).toMatchObject({ min: 0.068, max: 0.068, confidence: "exact" });
    expect(nb2.body.basis).toContain("Batch");

    await setSpeed(server, { speed: "priority" });
    const lite = await server.json<CostEstimate>("/api/models/google/gemini-3.1-flash-lite-image/estimate", {
      method: "POST",
      body,
    });
    // Lite has no Priority, so it's priced at Standard, and the basis names no speed.
    expect(lite.body).toMatchObject({ min: 0.0672, max: 0.0672 });
    expect(lite.body.basis).not.toContain("Priority");
    const pro = await server.json<CostEstimate>("/api/models/google/gemini-3-pro-image/estimate", {
      method: "POST",
      body,
    });
    expect(pro.body.max).toBeCloseTo(0.48384, 6);
    expect(pro.body.basis).toContain("Priority");
  });

  test("settings are frozen at submit: a change applies to new runs, and Recreate replays the old speed", async () => {
    const gate = gatedFetch(recordingFetch().fetch);
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await setSpeed(server, { speed: "priority" });
    const run = await generate(server, { model: PRO });
    await waitFor(() => gate.state.active === 1);
    await setSpeed(server, { speed: "standard" });
    gate.release();
    await completed(server, run.jobSet.id);
    expect(getJob(server.services.db, run.jobs[0]!.id)!.speedUsed).toBe("priority");

    const again = await server.json<JobSetAccepted>(`/api/job-sets/${run.jobSet.id}/recreate`, {
      method: "POST",
    });
    expect(again.body.jobSet.speed).toBe("priority");
    const fresh = await generate(server, { model: PRO });
    expect(fresh.jobSet.speed).toBe("standard");
  });

  test("Priority served at Standard bills Standard", async () => {
    server = await startTestServer();
    await saveKey(server);
    await setSpeed(server, { speed: "priority" });
    const run = await generate(server, { model: PRO, prompt: "a pier #fake:priority_standard" });
    expect(run.jobSet.costEstimateUsd).toBeCloseTo(0.24192, 6);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(getJob(server.services.db, run.jobs[0]!.id)!.speedUsed).toBe("standard");
    expect(usageRows(server).map((r) => [r.speed, r.cost_usd])).toEqual([["standard", 0.134]]);
  });
});

describe("Flex busy", () => {
  test("keep trying: the job waits and goes again, without spending an attempt", async () => {
    const rec = recordingFetch((n) => n <= 2);
    server = await startTestServer({ fetch: rec.fetch, queue: { flexBusyDelaysMs: [20, 40] } });
    await saveKey(server);
    await setSpeed(server, { speed: "flex" });
    const run = await generate(server, { model: PRO });
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");

    const waits = server.events.filter((e) => e.event === "job.queued" && (e.data as { busy?: true }).busy);
    expect(waits).toHaveLength(2);
    expect(waits.every((e) => typeof (e.data as { retryAt?: string }).retryAt === "string")).toBe(true);
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.status, job.attempt, job.speedUsed]).toEqual(["succeeded", 1, "flex"]);
    expect(rec.sent.map((s) => s.serviceTier)).toEqual(["flex", "flex", "flex"]);
    expect(usageRows(server).map((r) => [r.outcome, r.speed, r.cost_usd])).toEqual([
      ["succeeded", "flex", 0.067],
    ]);
  });

  test("switch to Standard: the adapter sends it again at once and it bills Standard", async () => {
    const rec = recordingFetch((n) => n === 1);
    server = await startTestServer({ fetch: rec.fetch });
    await saveKey(server);
    await setSpeed(server, { speed: "flex", flexBusy: "standard" });
    const run = await generate(server, { model: PRO });
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");

    expect(server.events.some((e) => e.event === "job.queued" && (e.data as { busy?: true }).busy)).toBe(
      false,
    );
    expect(rec.sent).toEqual([
      { model: "gemini-3-pro-image", serviceTier: "flex" },
      { model: "gemini-3-pro-image" },
    ]);
    expect(getJob(server.services.db, run.jobs[0]!.id)!.speedUsed).toBe("standard");
    expect(usageRows(server).map((r) => [r.speed, r.cost_usd])).toEqual([["standard", 0.134]]);
  });

  test("still busy at the Flex deadline: the run fails with our own final reason", async () => {
    const rec = recordingFetch(() => true);
    server = await startTestServer({
      fetch: rec.fetch,
      queue: { flexBusyDelaysMs: [20], flexJobDeadlineMs: 250 },
    });
    await saveKey(server);
    await setSpeed(server, { speed: "flex" });
    const run = await generate(server, { model: PRO });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.errorCode, job.errorReason, job.errorAction]).toEqual([
      "provider_unavailable",
      "Flex stayed busy for an hour. Try again, or choose Standard in Google settings.",
      "try-again",
    ]);
    // Far more tries than maxAttempts: busy answers never count.
    expect(rec.sent.length).toBeGreaterThan(3);
    expect(usageRows(server).map((r) => [r.outcome, r.cost_usd])).toEqual([["failed", 0]]);
  });

  test("a speed Google won't take for the model points at Google's settings", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    const fetch: FetchLike = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { serviceTier?: string };
      if (!isGenerateCall(input) || body.serviceTier !== "flex") return fake(input, init);
      const message = "Service tier flex is not supported for models/gemini-3-pro-image.";
      return Response.json(
        {
          error: {
            code: 400,
            message,
            status: "INVALID_ARGUMENT",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                fieldViolations: [{ field: "service_tier", description: message }],
              },
            ],
          },
        },
        { status: 400 },
      );
    };
    server = await startTestServer({ fetch });
    await saveKey(server);
    await setSpeed(server, { speed: "flex" });
    const run = await generate(server, { model: PRO });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.errorCode, job.errorReason, job.errorAction]).toEqual([
      "unsupported_param",
      "Google doesn't offer Flex for this model. Choose another speed in Google settings.",
      "open-settings",
    ]);
  });

  test("canceling a job that's waiting out a busy answer costs nothing", async () => {
    const rec = recordingFetch(() => true);
    server = await startTestServer({ fetch: rec.fetch, queue: { flexBusyDelaysMs: [60_000] } });
    await saveKey(server);
    await setSpeed(server, { speed: "flex" });
    const run = await generate(server, { model: PRO });
    await waitFor(() =>
      server!.events.some((e) => e.event === "job.queued" && (e.data as { busy?: true }).busy),
    );
    const res = await server.json<{ canceled: string[] }>(`/api/job-sets/${run.jobSet.id}/cancel`, {
      method: "POST",
    });
    expect(res.body.canceled).toEqual([run.jobs[0]!.id]);
    expect((await completed(server, run.jobSet.id)).status).toBe("canceled");
    expect(usageRows(server)).toEqual([]);
  });
});

describe("fake mode", () => {
  test("records $0, marks rows simulated, and never counts toward spend, but counts its images", async () => {
    server = await startTestServer({ env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    await saveKey(server);
    const run = await generate(server, { batch: 2 });
    // Estimates still show real prices, so the app looks right.
    expect(run.jobSet.costEstimateUsd).toBe(0.134);
    const done = await completed(server, run.jobSet.id);
    expect(done).toMatchObject({ status: "succeeded", costActualUsd: 0 });
    expect(usageRows(server).map((r) => [r.cost_usd, r.simulated])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    const usage = usageResponseSchema.parse((await server.json<UsageResponse>("/api/usage")).body);
    expect(usage.totalUsd).toBe(0);
    expect(
      usage.rows.map(({ runs, images, usd, usdDiscarded }) => ({ runs, images, usd, usdDiscarded })),
    ).toEqual([{ runs: 2, images: 2, usd: 0, usdDiscarded: 0 }]);
  });

  test("a cancel after submit is logged as discarded, still at $0", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch, env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    await saveKey(server);
    const run = await generate(server);
    await waitFor(() => gate.state.active === 1);
    await server.json(`/api/job-sets/${run.jobSet.id}/cancel`, { method: "POST" });
    gate.release();
    await completed(server, run.jobSet.id);
    expect(usageRows(server)).toEqual([
      { outcome: "canceled", cost_usd: 0, speed: "standard", simulated: 1, discarded: 1 },
    ]);
    expect((await server.json<UsageResponse>("/api/usage")).body.discardedUsd).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";
import type { JobSetsListResponse } from "@openfield/core";
import { feedPage, getAsset, getJob, getJobSet, jobsOf, transitionJob, usageRollup } from "@openfield/db";
import { createFakeFetch, type FetchLike } from "@openfield/providers/server";
import {
  completed,
  gatedFetch,
  generate,
  generateBody,
  googleError,
  isGenerateCall,
  saveKey,
  startTestServer,
  type TestServer,
  waitFor,
} from "./helpers";

// §8.4 and §0.12 with fake providers: caps, retries, timeouts, cancel and crash recovery.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const usageRows = (s: TestServer) =>
  s.services.db.$client
    .query<{ outcome: string; cost_usd: number | null; discarded: number; cost_source: string }, []>(
      "SELECT outcome, cost_usd, discarded, cost_source FROM usage_log ORDER BY id",
    )
    .all();

describe("caps", () => {
  test("never more calls at once than settings.globalConcurrency", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 2 } });
    const a = await generate(server, { batch: 4 });
    const b = await generate(server, { batch: 2 });
    await waitFor(() => gate.state.active === 2);
    await Bun.sleep(80);
    expect(gate.state.active).toBe(2);
    const queued = server.events.filter((e) => e.event === "job.queued");
    expect(queued.length).toBeGreaterThan(0);

    gate.release();
    await completed(server, a.jobSet.id);
    await completed(server, b.jobSet.id);
    expect(gate.state.max).toBe(2);
    expect(gate.state.calls).toBe(6);
  });

  test("the per-company cap holds even when the global cap is higher", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const patch = await server.json<{ concurrencyCap: number }>("/api/providers/google", {
      method: "PATCH",
      body: { concurrencyCap: 1 },
    });
    expect(patch.body.concurrencyCap).toBe(1);
    const run = await generate(server, { batch: 3 });
    await waitFor(() => gate.state.active === 1);
    await Bun.sleep(80);
    gate.release();
    await completed(server, run.jobSet.id);
    expect(gate.state.max).toBe(1);
  });

  test("jobs run in submit order within the same priority", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 1 } });
    const first = await generate(server);
    const second = await generate(server);
    gate.release();
    await completed(server, second.jobSet.id);
    const started = server.events
      .filter((e) => e.event === "job.started")
      .map((e) => (e.data as { jobSetId: string }).jobSetId);
    expect(started).toEqual([first.jobSet.id, second.jobSet.id]);
  });
});

describe("retries", () => {
  test("a retryable failure is tried again and then succeeds", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    let failures = 1;
    const flaky: FetchLike = async (input, init) => {
      if (isGenerateCall(input) && failures-- > 0) return googleError(429, "RESOURCE_EXHAUSTED", "Slow down");
      return fake(input, init);
    };
    server = await startTestServer({ fetch: flaky });
    await saveKey(server);
    const run = await generate(server);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect(job.attempt).toBe(2);
    expect(job.errorCode).toBeNull();
    expect(usageRows(server).map((r) => r.outcome)).toEqual(["succeeded"]);
  });

  test("retryable failures stop after three attempts", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    let calls = 0;
    const down: FetchLike = async (input, init) => {
      if (!isGenerateCall(input)) return fake(input, init);
      calls++;
      return googleError(503, "UNAVAILABLE", "The model is overloaded");
    };
    server = await startTestServer({ fetch: down });
    await saveKey(server);
    const run = await generate(server);
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    expect(calls).toBe(3);
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.status, job.errorCode, job.attempt]).toEqual(["failed", "provider_unavailable", 3]);
    expect(usageRows(server)).toEqual([
      { outcome: "failed", cost_usd: 0, discarded: 0, cost_source: "unknown" },
    ]);
  });

  test("a refusal fails at once, with no retry", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server, { prompt: "something #fake:refused" });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.errorCode, job.attempt]).toEqual(["content_refused", 1]);
    const failed = server.events.find((e) => e.event === "job.failed")!.data as { error: { code: string } };
    expect(failed.error.code).toBe("content_refused");
  });

  test("an adapter's own copy reaches the tile; the code's usual words stay out of the row", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server, { prompt: "a cat #fake:foreign_asset" });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.errorCode, job.errorReason]).toEqual([
      "provider_error",
      "Image blocked. It came from an unknown site.",
    ]);
    const failed = server.events.find((e) => e.event === "job.failed")!.data as {
      error: { reason?: string };
    };
    expect(failed.error.reason).toBe("Image blocked. It came from an unknown site.");

    const refused = await generate(server, { prompt: "a cat #fake:refused" });
    await completed(server, refused.jobSet.id);
    expect(getJob(server.services.db, refused.jobs[0]!.id)!.errorReason).toBeNull();
  });

  test("a company that's turned off makes no calls: new runs are refused, queued ones wait", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await server.json("/api/providers/google", { method: "PATCH", body: { concurrencyCap: 1 } });
    // One image in flight, one waiting behind the cap.
    const first = await generate(server);
    const waiting = await generate(server);
    await waitFor(() => gate.state.active === 1);

    const off = await server.json("/api/providers/google", { method: "PATCH", body: { enabled: false } });
    expect(off.status).toBe(200);
    const refused = await server.json<{ error: { code: string; userMessage?: string } }>("/api/generate", {
      method: "POST",
      body: generateBody(),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("capability_unsupported");
    expect(refused.body.error.userMessage).toBe("Google is turned off, so its models can't run.");
    const models = await server.json<{ models: { ready: boolean }[] }>("/api/models");
    expect(models.body.models.some((m) => m.ready)).toBe(false);

    // The call already out finishes; the waiting run doesn't start while the company is off.
    gate.release();
    await completed(server, first.jobSet.id);
    await Bun.sleep(80);
    expect(gate.state.calls).toBe(1);
    expect(getJob(server.services.db, waiting.jobs[0]!.id)!.status).toBe("pending");

    await server.json("/api/providers/google", { method: "PATCH", body: { enabled: true } });
    expect((await completed(server, waiting.jobSet.id)).status).toBe("succeeded");
  });

  test("a custom server address isn't accepted in v1", async () => {
    server = await startTestServer();
    const res = await server.json<{ error: { code: string } }>("/api/providers/google", {
      method: "PATCH",
      body: { baseUrl: "https://example.com" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  test("a call that runs past its timeout is retried, then fails as a timeout", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    // Ignores the abort signal, like a badly behaved adapter: the runner must still move on.
    const slow: FetchLike = async (input, init) => {
      if (isGenerateCall(input)) await Bun.sleep(2_000);
      return fake(input, init);
    };
    server = await startTestServer({ fetch: slow, queue: { attemptTimeoutMs: 40 } });
    await saveKey(server);
    const run = await generate(server);
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = getJob(server.services.db, run.jobs[0]!.id)!;
    expect([job.errorCode, job.attempt]).toEqual(["timeout", 3]);
  });

  test("with no key, the run fails with auth_missing and isn't retried", async () => {
    server = await startTestServer();
    const run = await generate(server);
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    expect(getJob(server.services.db, run.jobs[0]!.id)!.errorCode).toBe("auth_missing");
  });
});

describe("cancel", () => {
  test("waiting jobs cancel at no cost; a job in flight is recorded as billed and discarded", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 1 } });
    const run = await generate(server, { batch: 2 });
    await waitFor(() => gate.state.active === 1);

    const res = await server.json<{ canceled: string[]; notCancelable: string[] }>(
      `/api/job-sets/${run.jobSet.id}/cancel`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(res.body.canceled.sort()).toEqual(run.jobs.map((j) => j.id).sort());
    expect(res.body.notCancelable).toEqual([]);

    const canceled = server.events
      .filter((e) => e.event === "job.canceled")
      .map((e) => e.data as { discarded: boolean });
    expect(canceled.map((c) => c.discarded).sort()).toEqual([false, true]);
    expect((await completed(server, run.jobSet.id)).status).toBe("canceled");

    // The aborted call ends and leaves nothing behind.
    gate.release();
    await waitFor(() => server!.services.runner.inFlight === 0);
    expect(feedPage(server.services.db).items).toEqual([]);
    const rows = usageRows(server);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "canceled", discarded: 1, cost_source: "estimated" });
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
    expect(usageRollup(server.services.db, { from: "2000-01-01" })[0]!.usdDiscarded).toBeGreaterThan(0);
  });

  test("canceling one image keeps the others", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => gate.state.active === 2);
    const cancel = await server.json(`/api/jobs/${run.jobs[1]!.id}/cancel`, { method: "POST" });
    expect(cancel.body).toEqual({ ok: true });
    gate.release();
    expect((await completed(server, run.jobSet.id)).status).toBe("partial");
    expect(feedPage(server.services.db).items).toHaveLength(1);
  });

  test("canceling a finished run changes nothing", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    const res = await server.json<{ canceled: string[]; notCancelable: string[] }>(
      `/api/job-sets/${run.jobSet.id}/cancel`,
      { method: "POST" },
    );
    expect(res.body).toEqual({ canceled: [], notCancelable: [run.jobs[0]!.id] });
    expect(getJobSet(server.services.db, run.jobSet.id)!.status).toBe("succeeded");
  });
});

describe("job sets", () => {
  test("the same idempotency key returns the same run", async () => {
    server = await startTestServer();
    await saveKey(server);
    const body = { idempotencyKey: "01K6BQ8A1C4D7E9F0000000001" };
    const a = await generate(server, body);
    const b = await generate(server, body);
    expect(b.jobSet.id).toBe(a.jobSet.id);
    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    expect(list.body.items).toHaveLength(1);
  });

  test("?status=active lists only unfinished runs", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const run = await generate(server);
    const active = await server.json<JobSetsListResponse>("/api/job-sets?status=active");
    expect(active.body.items.map((i) => i.jobSet.id)).toEqual([run.jobSet.id]);
    gate.release();
    await completed(server, run.jobSet.id);
    expect((await server.json<JobSetsListResponse>("/api/job-sets")).body.items).toEqual([]);
  });

  test("retry sends only the failed images again", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server, { prompt: "x #fake:refused", batch: 2 });
    await completed(server, run.jobSet.id);
    const retry = await server.json<{ jobSet: { id: string; batchSize: number } }>(
      `/api/job-sets/${run.jobSet.id}/retry`,
      { method: "POST", body: { onlyFailed: true } },
    );
    expect(retry.status).toBe(202);
    expect(retry.body.jobSet.batchSize).toBe(2);
    expect(retry.body.jobSet.id).not.toBe(run.jobSet.id);

    // A second click, or the run's other failed tile, doesn't bill the run again.
    const again = await server.json(`/api/job-sets/${run.jobSet.id}/retry`, {
      method: "POST",
      body: { onlyFailed: true },
    });
    expect(again.status).toBe(409);
  });
});

describe("crash recovery", () => {
  test("a file missing from the library folder is marked at boot, and found again later", async () => {
    server = await startTestServer();
    await saveKey(server);
    const run = await generate(server);
    await completed(server, run.jobSet.id);
    await server.services.thumbs.idle();
    const asset = feedPage(server.services.db).items[0]!;
    const file = join(server.home, asset.path);
    const home = server.home;
    await server.close({ keepHome: true });

    renameSync(file, `${file}.moved`);
    server = await startTestServer({ home });
    expect(getAsset(server.services.db, asset.id)!.fileState).toBe("missing");
    await server.close({ keepHome: true });

    renameSync(`${file}.moved`, file);
    server = await startTestServer({ home });
    expect(getAsset(server.services.db, asset.id)!.fileState).toBe("ok");
  });

  test("a Google call cut off mid-call runs again once, since it can't be picked up by id", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => gate.state.active === 2);
    // Simulate a crash: the server dies with one job running and one never picked up.
    transitionJob(server.services.db, run.jobs[1]!.id, "pending", {}, { from: ["submitting", "running"] });
    const home = server.home;
    await server.close({ keepHome: true });

    const calls = gatedFetch();
    calls.release();
    server = await startTestServer({ home, fetch: calls.fetch });
    await completed(server, run.jobSet.id);
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    expect(jobs.map((j) => j.rerunAt !== null)).toEqual([true, false]);
    expect(getJobSet(server.services.db, run.jobSet.id)!.status).toBe("succeeded");
    expect(calls.state.calls).toBe(2);
  });

  test("with running again turned off, a job cut off mid-call is interrupted and never sent again", async () => {
    const gate = gatedFetch();
    server = await startTestServer({ fetch: gate.fetch });
    await saveKey(server);
    await server.json("/api/settings", { method: "PATCH", body: { rerunInterrupted: false } });
    const run = await generate(server, { batch: 2 });
    await waitFor(() => gate.state.active === 2);
    transitionJob(server.services.db, run.jobs[1]!.id, "pending", {}, { from: ["submitting", "running"] });
    const home = server.home;
    await server.close({ keepHome: true });

    const calls = gatedFetch();
    calls.release();
    server = await startTestServer({ home, fetch: calls.fetch });
    await completed(server, run.jobSet.id);
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => j.status)).toEqual(["interrupted", "succeeded"]);
    expect(getJobSet(server.services.db, run.jobSet.id)!.status).toBe("partial");
    expect(calls.state.calls).toBe(1);
  });
});

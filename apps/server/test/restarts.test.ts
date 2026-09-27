import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AssetDetailResponse,
  type AssetsListResponse,
  isTerminalState,
  type JobSetsListResponse,
  type ModelManifest,
  type SseEvent,
  t,
  type UsageResponse,
} from "@openfield/core";
import {
  feedPage,
  getJob,
  getJobSet,
  getProvider,
  getProviderBatchForJobSet,
  type JobRow,
  jobsOf,
} from "@openfield/db";
import {
  createFakeFetch,
  type FakeFetch,
  type FetchLike,
  type Provider,
  ProviderError,
  providersFor,
} from "@openfield/providers/server";
import type { DrainNotice } from "../src/runner/runner";
import {
  generate,
  googleError,
  isGenerateCall,
  saveKey,
  startTestServer,
  type TestServer,
  waitFor,
} from "./helpers";

// §0.4, §0.12 and §8.4.5: an image is never lost to a restart. A resumable call has its handle
// stored before the first poll and is picked up by that id; a call that can't resume is waited for
// when the server stops, and after a crash runs again once, when the setting allows it.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const RESUMABLE = "fake:resumable-image";
const FAKE_KEY = "fake-test-key";
const FAKE_ENV = { OPENFIELD_FAKE_PROVIDERS: "1", OPENFIELD_FAKE_API_KEY: FAKE_KEY };
const QUEUE = { poll: { firstMs: 5, factor: 1, capMs: 5 } };

// The test company's timeline follows this clock: queued for 1 s, then running until 4 s.
const clock = { now: Date.now() };
const resumableFake = () => createFakeFetch({ delayMs: 0, now: () => clock.now });
const slowFake = (slowMs: number) => createFakeFetch({ delayMs: 0, slowMs });

interface StartOptions {
  home?: string;
  env?: Record<string, string>;
  queue?: Record<string, unknown>;
  providers?: readonly Provider[];
}

async function start(fetch: FetchLike, opts: StartOptions = {}): Promise<TestServer> {
  const s = await startTestServer({
    fetch,
    queue: { ...QUEUE, ...opts.queue },
    env: { ...FAKE_ENV, ...opts.env },
    ...(opts.home && { home: opts.home }),
    ...(opts.providers && { providers: opts.providers }),
  });
  if (!opts.home) await saveKey(s);
  return s;
}

/** Stops this server (after a drain or a cut already done) and starts another on its library. */
async function restart(s: TestServer, fetch: FetchLike, opts: Omit<StartOptions, "home"> = {}) {
  const home = s.home;
  await s.close({ keepHome: true });
  return start(fetch, { ...opts, home });
}

const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);
const READ = /\/v1\/images\/[^/]+$/;
const count = (fake: FakeFetch, method: string, pattern: RegExp) =>
  fake.calls.filter((c) => c.method === method && pattern.test(c.url)).length;
const creates = (fake: FakeFetch) => count(fake, "POST", /\/v1\/images$/);
const reads = (fake: FakeFetch) => count(fake, "GET", READ);
const cancels = (fake: FakeFetch) => count(fake, "POST", /\/cancel$/);
const generateCalls = (fake: FakeFetch) => count(fake, "POST", /:generateContent$/);

const job = (s: TestServer, id: string): JobRow => getJob(s.services.db, id)!;
const db = (s: TestServer) => s.services.db.$client;
const unavailable = () =>
  new Response(JSON.stringify({ error: { code: "unavailable", message: "Busy." } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
const stored = (s: TestServer, id: string) => waitFor(() => job(s, id).handle ?? undefined);
const NOTHING: DrainNotice = { finishing: 0, confirming: 0, stopping: 0, companies: [] };

/** Holds a call until the stop cuts it off. */
const untilCutOff = (signal?: AbortSignal | null) =>
  new Promise<Response>((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/**
 * The fake providers with the test company as one that ignores idempotency keys, so a create sent
 * again after a lost answer would start a second call there.
 */
function keyless(): readonly Provider[] {
  const strip = ({ idempotentSubmit: _, ...manifest }: ModelManifest): ModelManifest => manifest;
  return providersFor({ fake: true }).map((p) =>
    p.meta.id === "fake"
      ? {
          ...p,
          catalog: () => p.catalog().map(strip),
          listModels: async (ctx) => (await p.listModels(ctx)).map(strip),
        }
      : p,
  );
}

/** Waits for the run to end, from the database: events from boot can come before a test subscribes. */
const finished = (s: TestServer, jobSetId: string, timeoutMs = 5_000) =>
  waitFor(() => {
    const set = getJobSet(s.services.db, jobSetId);
    return set && isTerminalState(set.status) ? set : undefined;
  }, timeoutMs);

const usageRows = (s: TestServer) =>
  s.services.db.$client
    .query<{ outcome: string; rerun: number; discarded: number }, []>(
      "SELECT outcome, rerun, discarded FROM usage_log ORDER BY id",
    )
    .all();

const logLines = (s: TestServer, file: string) =>
  readFileSync(join(s.services.paths.logs, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const lastRecovery = (s: TestServer) =>
  logLines(s, "jobs.ndjson").findLast((l) => l.event === "startup.recovery");
const bootLines = (s: TestServer) => logLines(s, "openfield.log").map((l) => l.msg);

describe("a resumable call", () => {
  test("stores its handle before the first poll, then lands the image from that id", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let atFirstRead: { handle: string | null; resumable: number; provider_job_id: string | null } | null =
      null;
    const watching: FetchLike = (input, init) => {
      if (!atFirstRead && (init?.method ?? "GET") === "GET" && READ.test(urlOf(input))) {
        atFirstRead = server!.services.db.$client
          .query<{ handle: string | null; resumable: number; provider_job_id: string | null }, []>(
            "SELECT handle, resumable, provider_job_id FROM jobs",
          )
          .get();
      }
      return fake(input, init);
    };
    server = await start(watching);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    const handle = await stored(server, id);
    expect(job(server, id)).toMatchObject({
      status: "running",
      resumable: true,
      providerJobId: handle.providerRef,
    });

    clock.now += 5_000;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(atFirstRead).toMatchObject({ resumable: 1, provider_job_id: handle.providerRef });
    expect(atFirstRead!.handle).not.toBeNull();
    expect(creates(fake)).toBe(1);
    expect(feedPage(server.services.db).items).toHaveLength(1);

    // The handle never reaches the browser.
    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    const wire = list.body.items[0]!.jobs[0]!;
    expect(wire).not.toHaveProperty("handle");
    expect(wire).toMatchObject({ resumedAt: null, rerunAt: null });
  });

  test("is left running at the company when the server stops, and picked up by the same id at the next start", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    const handle = await stored(server, id);

    const notices: DrainNotice[] = [];
    const t0 = Date.now();
    const report = await server.services.runner.stop({ onDrain: (n) => notices.push(n) });
    // Nothing to wait for: the company keeps making it.
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(report).toEqual({ left: 1, cut: { rerun: 0, interrupted: 0 } });
    expect(notices).toEqual([NOTHING]);
    expect(job(server, id)).toMatchObject({ status: "running", resumedAt: null });

    clock.now += 5_000;
    server = await restart(server, fake);
    expect(job(server, id).resumedAt).not.toBeNull();
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(job(server, id)).toMatchObject({ providerJobId: handle.providerRef, attempt: 1, rerunAt: null });
    expect(creates(fake)).toBe(1);
    expect(usageRows(server)).toEqual([{ outcome: "succeeded", rerun: 0, discarded: 0 }]);
    expect(lastRecovery(server)).toMatchObject({ requeued: 0, resumed: 1, rerun: 0, interrupted: 0 });
    expect(bootLines(server)).toContain("Picking up 1 image where it left off.");

    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    expect(list.body.items[0]!.jobs[0]!.resumedAt).not.toBeNull();
  });

  test("a call the company no longer has fails with Try again, and is never sent again", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_gone a lighthouse" });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.services.runner.stop();

    // The company forgets it 10 s after it was made.
    clock.now += 11_000;
    server = await restart(server, fake);
    await finished(server, run.jobSet.id);
    expect(job(server, id)).toMatchObject({
      status: "failed",
      errorCode: "provider_error",
      errorReason: t("errors.resumeGone", { company: "Test company" }),
      errorAction: "try-again",
    });
    expect(creates(fake)).toBe(1);
  });

  test("a failed read reads the same id again, and never sends the call again", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let failures = 2;
    const flaky: FetchLike = async (input, init) => {
      if ((init?.method ?? "GET") === "GET" && READ.test(urlOf(input)) && failures > 0) {
        failures--;
        return new Response(JSON.stringify({ error: { code: "unavailable", message: "Busy." } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return fake(input, init);
    };
    server = await start(flaky);
    const run = await generate(server, { model: RESUMABLE });
    await waitFor(() => failures === 0);
    clock.now += 5_000;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(creates(fake)).toBe(1);
    expect(job(server, run.jobs[0]!.id).attempt).toBe(1);
  });

  test("picked up past its deadline, it's read once, then stopped at the company as a timeout", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.services.runner.stop();
    await Bun.sleep(30);
    const readsBefore = reads(fake);

    server = await restart(server, fake, { queue: { jobDeadlineMs: 20 } });
    await finished(server, run.jobSet.id);
    expect(job(server, id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      errorAction: "try-again",
    });
    expect(reads(fake)).toBe(readsBefore + 1);
    expect(cancels(fake)).toBe(1);
    expect(creates(fake)).toBe(1);
  });

  test("picked up past its deadline but already done, its image is saved", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
    await stored(server, run.jobs[0]!.id);
    await server.services.runner.stop();
    await Bun.sleep(30);

    clock.now += 61_000;
    server = await restart(server, fake, { queue: { jobDeadlineMs: 20 } });
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(cancels(fake)).toBe(0);
  });

  test("waits while its company has no key, and is picked up once there is one", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.services.runner.stop();
    const readsBefore = reads(fake);

    clock.now += 5_000;
    server = await restart(server, fake, { env: { OPENFIELD_FAKE_API_KEY: "" } });
    await Bun.sleep(100);
    expect(job(server, id).status).toBe("running");
    expect(reads(fake)).toBe(readsBefore);

    const saved = await server.json("/api/settings/keys/fake", { method: "PUT", body: { apiKey: FAKE_KEY } });
    expect(saved.status).toBe(200);
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(creates(fake)).toBe(1);
  });

  test("canceled, it's stopped at the company too", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await stored(server, id);

    const res = await server.json(`/api/job-sets/${run.jobSet.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    await waitFor(() => cancels(fake) === 1);
    expect(job(server, id).status).toBe("canceled");
    expect(usageRows(server)).toEqual([{ outcome: "canceled", rerun: 0, discarded: 1 }]);
  });

  test("picked up past its deadline, a first read that fails reads again, and the finished image lands", async () => {
    for (const failure of ["503", "network"] as const) {
      clock.now = Date.now();
      const fake = resumableFake();
      server = await start(fake);
      const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
      const id = run.jobs[0]!.id;
      await stored(server, id);
      await server.services.runner.stop();
      await Bun.sleep(30);

      // Finished at the company while Openfield was stopped, and the network isn't back yet.
      clock.now += 61_000;
      let failures = 1;
      const flaky: FetchLike = async (input, init) => {
        if ((init?.method ?? "GET") === "GET" && READ.test(urlOf(input)) && failures > 0) {
          failures--;
          if (failure === "network") throw new TypeError("fetch failed");
          return unavailable();
        }
        return fake(input, init);
      };
      server = await restart(server, flaky, { queue: { jobDeadlineMs: 20, batchPollMs: 5 } });
      expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
      expect(cancels(fake)).toBe(0);
      expect(creates(fake)).toBe(1);
      await server.close();
      server = undefined;
    }
  });

  test("past its deadline, reads that keep failing give up after several in a row, and never stop it at the company", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.services.runner.stop();
    await Bun.sleep(30);

    let failedReads = 0;
    const down: FetchLike = async (input, init) => {
      if ((init?.method ?? "GET") === "GET" && READ.test(urlOf(input))) {
        failedReads++;
        return unavailable();
      }
      return fake(input, init);
    };
    server = await restart(server, down, { queue: { jobDeadlineMs: 20, batchPollMs: 5 } });
    await finished(server, run.jobSet.id);
    expect(job(server, id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      errorReason: t("errors.resumeUnchecked", { company: "Test company" }),
      errorAction: "try-again",
    });
    expect(failedReads).toBe(3);
    expect(cancels(fake)).toBe(0);
    expect(creates(fake)).toBe(1);
  });

  test("an image that can't be saved yet (a full disk) waits at the company and lands once there's room", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const ingest = server.services.ingest as unknown as { stage: (...args: unknown[]) => Promise<unknown> };
    const stage = ingest.stage.bind(ingest);
    let full = 2;
    ingest.stage = async (...args: unknown[]) => {
      if (full-- > 0) throw new ProviderError("disk_full", { message: "The disk is full" });
      return stage(...args);
    };
    const run = await generate(server, { model: RESUMABLE });
    await stored(server, run.jobs[0]!.id);
    clock.now += 5_000;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(full).toBeLessThan(0);
    expect(creates(fake)).toBe(1);
  });

  test("a key rejected after a restart doesn't end it: once the key is put right, the image lands", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.services.runner.stop();

    clock.now += 5_000;
    let rejected = true;
    let refusals = 0;
    const rejecting: FetchLike = async (input, init) => {
      if (rejected && (init?.method ?? "GET") === "GET" && READ.test(urlOf(input))) {
        refusals++;
        return new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Bad key." } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return fake(input, init);
    };
    server = await restart(server, rejecting);
    await waitFor(() => refusals >= 3);
    expect(job(server, id).status).toBe("running");
    expect(getProvider(server.services.db, "fake")?.lastError).toBe("auth_invalid");

    rejected = false;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(creates(fake)).toBe(1);
  });

  test("canceled while its create call is out, it's stopped at the company once the id arrives", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding: FetchLike = async (input, init) => {
      if (init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) await gate;
      return fake(input, init);
    };
    server = await start(holding);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await waitFor(() => job(server!, id).status === "submitting" && server!.services.runner.inFlight === 1);

    const res = await server.json(`/api/job-sets/${run.jobSet.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(job(server, id).status).toBe("canceled");
    release();
    await waitFor(() => cancels(fake) === 1);
    await waitFor(() => server!.services.runner.inFlight === 0);
    expect(job(server, id)).toMatchObject({ status: "canceled", handle: null });
    expect(creates(fake)).toBe(1);
  });

  test("canceled while its create call is out, a cancel that doesn't get through is still sent after a restart", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelDown = true;
    let cancelCalls = 0;
    const holding: FetchLike = async (input, init) => {
      const url = urlOf(input);
      if (init?.method === "POST" && /\/v1\/images$/.test(url)) await gate;
      if (init?.method === "POST" && /\/cancel$/.test(url)) {
        cancelCalls++;
        if (cancelDown) return unavailable();
      }
      return fake(input, init);
    };
    server = await start(holding);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await waitFor(() => job(server!, id).status === "submitting" && server!.services.runner.inFlight === 1);

    await server.json(`/api/job-sets/${run.jobSet.id}/cancel`, { method: "POST" });
    release();
    // It's owed, and tried again while the company is still down: counted as at least, since a slow
    // machine can see the retries go by before it looks.
    await waitFor(() => cancelCalls >= 1);
    await waitFor(() => server!.services.runner.inFlight === 0);
    // Owed: the canceled job keeps the id until the company has been told.
    expect(job(server, id)).toMatchObject({ status: "canceled", resumable: true });
    expect(job(server, id).handle?.providerRef).toBeTruthy();

    server = await restart(server, holding);
    const beforeUp = cancelCalls;
    cancelDown = false;
    await waitFor(() => cancelCalls > beforeUp);
    await waitFor(() => job(server!, id).handle === null);
    expect(creates(fake)).toBe(1);
  });

  test("canceled while its company is off, it's stopped at the company once it's back, even after a restart", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const run = await generate(server, { model: RESUMABLE, prompt: "#fake:resume_slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await stored(server, id);
    await server.json("/api/providers/fake", { method: "PATCH", body: { enabled: false } });
    await waitFor(() => server!.services.runner.inFlight === 0);

    const res = await server.json(`/api/job-sets/${run.jobSet.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(job(server, id).status).toBe("canceled");
    // Still owed: the job keeps its handle until the company has been told.
    expect(job(server, id).handle).not.toBeNull();

    server = await restart(server, fake);
    expect(cancels(fake)).toBe(0);
    await server.json("/api/providers/fake", { method: "PATCH", body: { enabled: true } });
    await waitFor(() => cancels(fake) === 1);
    await waitFor(() => job(server!, id).handle === null);
    expect(creates(fake)).toBe(1);
  });

  test("a create still out when the server stops is waited for until its id is stored, then left, and the stop says so", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    const slowCreate: FetchLike = async (input, init) => {
      if (init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) await Bun.sleep(300);
      return fake(input, init);
    };
    server = await start(slowCreate);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await waitFor(() => job(server!, id).status === "submitting" && server!.services.runner.inFlight === 1);

    const notices: DrainNotice[] = [];
    const report = await server.services.runner.stop({ onDrain: (n) => notices.push(n) });
    // Not "finishing": it's left at the company once the id is stored.
    expect(notices).toEqual([{ ...NOTHING, confirming: 1, companies: ["Test company"] }]);
    expect(report).toEqual({ left: 1, cut: { rerun: 0, interrupted: 0 } });
    expect(job(server, id).handle).not.toBeNull();
    const stopped = logLines(server, "jobs.ndjson").findLast((l) => l.event === "server.stopped");
    expect(stopped).toMatchObject({ forced: false, left: 1, cut: { rerun: 0, interrupted: 0 } });
  });

  test("cut off before the company's id arrived, the same create goes again with the same key and gets the first call back", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let firstId: string | undefined;
    // The company takes the create, but its answer never comes back before the stop cuts it off.
    const lost: FetchLike = async (input, init) => {
      if (!firstId && init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) {
        firstId = ((await (await fake(input, init)).json()) as { id: string }).id;
        return untilCutOff(init.signal);
      }
      return fake(input, init);
    };
    server = await start(lost);
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await waitFor(() => firstId !== undefined && job(server!, id).status === "submitting");

    // The next start asks for it again, so it's left for then, not interrupted.
    expect(await server.services.runner.stop({ drainMs: 0 })).toEqual({
      left: 1,
      cut: { rerun: 0, interrupted: 0 },
    });
    expect(job(server, id)).toMatchObject({ status: "submitting", resumable: true, handle: null });

    server = await restart(server, fake);
    expect(lastRecovery(server)).toMatchObject({ resumed: 1, rerun: 0, interrupted: 0 });
    expect(bootLines(server)).toContain("Picking up 1 image where it left off.");
    expect((await stored(server, id)).providerRef).toBe(firstId);
    clock.now += 5_000;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(job(server, id)).toMatchObject({ providerJobId: firstId, attempt: 1, rerunAt: null });
    expect(job(server, id).resumedAt).not.toBeNull();
    // Two creates with one key: one call at the company, billed once.
    expect(creates(fake)).toBe(2);
    expect(usageRows(server)).toEqual([{ outcome: "succeeded", rerun: 0, discarded: 0 }]);
  });

  test("cut off before the id arrived, at a company that ignores the key, it's interrupted, never sent again, and logged as maybe billed", async () => {
    const fake = resumableFake();
    const holding: FetchLike = (input, init) => {
      if (init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) return untilCutOff(init.signal);
      return fake(input, init);
    };
    server = await start(holding, { providers: keyless() });
    const run = await generate(server, { model: RESUMABLE });
    const id = run.jobs[0]!.id;
    await waitFor(() => server!.services.runner.inFlight === 1 && job(server!, id).status === "submitting");

    const report = await server.services.runner.stop({ drainMs: 0 });
    expect(report).toEqual({ left: 0, cut: { rerun: 0, interrupted: 1 } });
    expect(job(server, id)).toMatchObject({ status: "submitting", resumable: true, handle: null });

    server = await restart(server, fake, { providers: keyless() });
    expect(job(server, id).status).toBe("interrupted");
    await Bun.sleep(50);
    expect(creates(fake)).toBe(0);
    expect(lastRecovery(server)).toMatchObject({ resumed: 0, rerun: 0, interrupted: 1 });
    // It had been sent, so the company may bill it: a row at no known cost says so.
    expect(usageRows(server)).toEqual([{ outcome: "failed", rerun: 0, discarded: 0 }]);
  });

  test("a create whose answer is lost on the way goes again only where the company honours the key", async () => {
    for (const sameKey of [true, false]) {
      clock.now = Date.now();
      const fake = resumableFake();
      let firstId: string | undefined;
      // It reaches the company, then the answer is lost.
      const flaky: FetchLike = async (input, init) => {
        const res = await fake(input, init);
        if (!firstId && init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) {
          firstId = ((await res.json()) as { id: string }).id;
          throw new TypeError("fetch failed");
        }
        return res;
      };
      server = await start(flaky, sameKey ? {} : { providers: keyless() });
      const run = await generate(server, { model: RESUMABLE });
      const id = run.jobs[0]!.id;
      if (sameKey) {
        expect((await stored(server, id)).providerRef).toBe(firstId);
        clock.now += 5_000;
        expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
        expect(creates(fake)).toBe(2);
      } else {
        // It may be at the company, so it's never sent a second time: it ends with Try again.
        await finished(server, run.jobSet.id);
        expect(job(server, id)).toMatchObject({ status: "failed", attempt: 1, errorAction: "try-again" });
        expect(creates(fake)).toBe(1);
        expect(usageRows(server)).toEqual([{ outcome: "failed", rerun: 0, discarded: 0 }]);
      }
      await server.close();
      server = undefined;
    }
  });

  test("a create the company plainly refused goes again, even where it ignores the key", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    let refusals = 1;
    const busy: FetchLike = async (input, init) => {
      if (refusals > 0 && init?.method === "POST" && /\/v1\/images$/.test(urlOf(input))) {
        refusals--;
        return unavailable();
      }
      return fake(input, init);
    };
    server = await start(busy, { providers: keyless() });
    const run = await generate(server, { model: RESUMABLE });
    await stored(server, run.jobs[0]!.id);
    clock.now += 5_000;
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(creates(fake)).toBe(1);
  });

  test("picked-up calls take their slots first, even past a cap lowered while the server was down", async () => {
    clock.now = Date.now();
    const fake = resumableFake();
    server = await start(fake);
    const picked = await generate(server, { model: RESUMABLE, batch: 2 });
    await waitFor(() => jobsOf(server!.services.db, picked.jobSet.id).every((j) => j.handle));
    await server.services.runner.stop();
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 1 } });
    const waiting = await generate(server);

    server = await restart(server, fake);
    await waitFor(() => server!.services.runner.inFlight === 2);
    expect(job(server, waiting.jobs[0]!.id).status).toBe("pending");

    clock.now += 5_000;
    expect((await finished(server, picked.jobSet.id)).status).toBe("succeeded");
    expect((await finished(server, waiting.jobSet.id)).status).toBe("succeeded");
    expect(creates(fake)).toBe(2);
  });
});

describe("a call that can't resume", () => {
  test("is waited for when the server stops, and its image is saved", async () => {
    server = await start(slowFake(300));
    const run = await generate(server, { prompt: "#fake:slow a lighthouse" });
    await waitFor(() => server!.services.runner.inFlight === 1);

    const notices: DrainNotice[] = [];
    const report = await server.services.runner.stop({ onDrain: (n) => notices.push(n) });
    expect(notices).toEqual([{ ...NOTHING, finishing: 1 }]);
    expect(report).toEqual({ left: 0, cut: { rerun: 0, interrupted: 0 } });
    expect(job(server, run.jobs[0]!.id).status).toBe("succeeded");
    expect(feedPage(server.services.db).items).toHaveLength(1);
  });

  test("a retryable failure while stopping starts no new attempt, and waits for the next start", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    let calls = 0;
    const failing: FetchLike = async (input, init) => {
      if (!isGenerateCall(input)) return fake(input, init);
      calls++;
      await Bun.sleep(100);
      return googleError(503, "UNAVAILABLE", "The model is overloaded.");
    };
    server = await start(failing);
    const run = await generate(server);
    await waitFor(() => calls === 1);
    await server.services.runner.stop();
    await Bun.sleep(50);
    expect(job(server, run.jobs[0]!.id)).toMatchObject({
      status: "pending",
      errorCode: "provider_unavailable",
    });
    expect(calls).toBe(1);
  });

  test("cut off by a forced stop, it runs again once at the next start, and says so", async () => {
    server = await start(slowFake(10_000));
    const run = await generate(server, { prompt: "#fake:slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await waitFor(() => server!.services.runner.inFlight === 1);
    const stopping = server.services.runner.stop();
    await Bun.sleep(20);
    server.services.runner.forceStop();
    expect(await stopping).toEqual({ left: 0, cut: { rerun: 1, interrupted: 0 } });
    // Held back at the next start until this test is listening for its events.
    await server.json("/api/providers/google", { method: "PATCH", body: { enabled: false } });

    const again = slowFake(0);
    server = await restart(server, again);
    expect(job(server, id)).toMatchObject({ status: "pending", attempt: 0, startedAt: null });
    expect(job(server, id).rerunAt).not.toBeNull();
    expect(lastRecovery(server)).toMatchObject({ resumed: 0, rerun: 1, interrupted: 0 });
    expect(bootLines(server)).toContain("Running 1 image again.");

    await server.json("/api/providers/google", { method: "PATCH", body: { enabled: true } });
    expect((await finished(server, run.jobSet.id)).status).toBe("succeeded");
    expect(job(server, id)).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(generateCalls(again)).toBe(1);
    const started = server.events.find((e) => e.event === "job.started")?.data as Extract<
      SseEvent,
      { event: "job.started" }
    >["data"];
    expect(started).toMatchObject({ jobId: id, rerun: true });

    // The tile and the usage log say it ran again, and so does the image, for as long as it's in the feed.
    expect(usageRows(server)).toEqual([{ outcome: "succeeded", rerun: 1, discarded: 0 }]);
    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    expect(list.body.items[0]!.jobs[0]!.rerunAt).not.toBeNull();
    const output = server.events.find((e) => e.event === "job.output")?.data as Extract<
      SseEvent,
      { event: "job.output" }
    >["data"];
    expect(output.asset.rerun).toBe(true);
    const assets = await server.json<AssetsListResponse>("/api/assets");
    expect(assets.body.items.map((a) => a.rerun)).toEqual([true]);
    const detail = await server.json<AssetDetailResponse>(`/api/assets/${output.asset.id}`);
    expect(detail.body.asset.rerun).toBe(true);
    const usage = await server.json<UsageResponse>("/api/usage?groupBy=model");
    expect(usage.body.rows).toEqual([expect.objectContaining({ images: 1, reruns: 1 })]);
  });

  test("cut off again while it runs again, it's interrupted, never sent a third time", async () => {
    server = await start(slowFake(10_000));
    const run = await generate(server, { prompt: "#fake:slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await waitFor(() => server!.services.runner.inFlight === 1);
    expect((await server.services.runner.stop({ drainMs: 0 })).cut).toEqual({ rerun: 1, interrupted: 0 });

    server = await restart(server, slowFake(10_000));
    await waitFor(() => server!.services.runner.inFlight === 1);
    expect(job(server, id).rerunAt).not.toBeNull();
    expect((await server.services.runner.stop({ drainMs: 0 })).cut).toEqual({ rerun: 0, interrupted: 1 });

    const third = slowFake(0);
    server = await restart(server, third);
    expect(job(server, id).status).toBe("interrupted");
    await Bun.sleep(50);
    expect(generateCalls(third)).toBe(0);
    // Two calls may be billed and there's no image: the usage log says it ran again, at no known cost.
    expect(usageRows(server)).toEqual([{ outcome: "failed", rerun: 1, discarded: 0 }]);
    const usage = await server.json<UsageResponse>("/api/usage?groupBy=model");
    expect(usage.body.rows).toEqual([expect.objectContaining({ images: 0, reruns: 1 })]);
  });

  test("with running again turned off, it's interrupted, and Try again sends it as a new run", async () => {
    server = await start(slowFake(10_000));
    await server.json("/api/settings", { method: "PATCH", body: { rerunInterrupted: false } });
    const run = await generate(server, { prompt: "#fake:slow a lighthouse" });
    const id = run.jobs[0]!.id;
    await waitFor(() => server!.services.runner.inFlight === 1);
    expect((await server.services.runner.stop({ drainMs: 0 })).cut).toEqual({ rerun: 0, interrupted: 1 });

    const again = slowFake(0);
    server = await restart(server, again);
    expect(job(server, id)).toMatchObject({ status: "interrupted", rerunAt: null });
    await Bun.sleep(50);
    expect(generateCalls(again)).toBe(0);

    const retry = await server.json<{ jobSet: { id: string } }>(`/api/job-sets/${run.jobSet.id}/retry`, {
      method: "POST",
      body: { onlyFailed: true },
    });
    expect(retry.status).toBe(202);
    expect((await finished(server, retry.body.jobSet.id)).status).toBe("succeeded");
  });
});

describe("stopping with a Batch run", () => {
  test("a Batch create in flight is waited for, so the company's id is stored", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding: FetchLike = async (input, init) => {
      if (urlOf(input).endsWith(":batchGenerateContent")) await gate;
      return fake(input, init);
    };
    server = await start(holding);
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "batch" } },
    });
    const run = await generate(server);
    await waitFor(() => server!.services.runner.inFlight === 1);

    const notices: DrainNotice[] = [];
    const stopping = server.services.runner.stop({ onDrain: (n) => notices.push(n) });
    await Bun.sleep(50);
    release();
    // Waited for only until the id is stored, then left at Google, so it isn't "finishing".
    expect(await stopping).toEqual({ left: 1, cut: { rerun: 0, interrupted: 0 } });
    expect(notices).toEqual([{ ...NOTHING, confirming: 1, companies: ["Google"] }]);
    expect(getProviderBatchForJobSet(server.services.db, run.jobSet.id)?.remoteId).toBeTruthy();
    expect(job(server, run.jobs[0]!.id).status).toBe("queued");
  });

  test("a create Google refused, waiting to try again, doesn't hold the stop up, and the next start sends it", async () => {
    const fake = createFakeFetch({ delayMs: 0 });
    let batchCreates = 0;
    const limited: FetchLike = async (input, init) => {
      if (urlOf(input).endsWith(":batchGenerateContent") && ++batchCreates === 1) {
        const res = googleError(429, "RESOURCE_EXHAUSTED", "Slow down.");
        return new Response(await res.text(), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        });
      }
      return fake(input, init);
    };
    server = await start(limited);
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "batch" } },
    });
    const run = await generate(server);
    const id = run.jobs[0]!.id;
    await waitFor(() => batchCreates === 1);
    await Bun.sleep(20);

    const t0 = Date.now();
    const notices: DrainNotice[] = [];
    await server.services.runner.stop({ onDrain: (n) => notices.push(n) });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(notices).toEqual([NOTHING]);
    // Nothing reached Google, so nothing is left to look up: it waits to be sent.
    expect(getProviderBatchForJobSet(server.services.db, run.jobSet.id)).toBeUndefined();
    expect(job(server, id)).toMatchObject({ status: "pending", errorCode: "rate_limited" });

    server = await restart(server, limited, { queue: { retryDelaysMs: [5, 5, 5] } });
    // Its Retry-After still holds at the next start, then it goes.
    db(server).run("UPDATE jobs SET next_attempt_at = NULL WHERE id = ?", [id]);
    server.services.runner.tick();
    await waitFor(() => getProviderBatchForJobSet(server!.services.db, run.jobSet.id)?.remoteId ?? undefined);
    expect(batchCreates).toBe(2);
    expect(job(server, id).status).not.toBe("interrupted");
  });
});

describe("the test company", () => {
  test("its card comes after the real companies', so first run still lands on Google's key field", async () => {
    server = await start(resumableFake());
    const { body } = await server.json<{ id: string }[]>("/api/providers");
    expect(body.map((p) => p.id)).toEqual(["google", "openai", "higgsfield", "fake"]);
  });
});

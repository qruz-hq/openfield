import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CancelResponse, type JobSetsListResponse, parseSseFrame, type SseEvent } from "@openfield/core";
import { feedPage, getJobSet, getProviderBatchForJobSet, jobsOf, type ProviderBatchRow } from "@openfield/db";
import { createFakeFetch, type FakeFetch, type FetchLike, ProviderError } from "@openfield/providers/server";
import { untilAborted } from "../src/runner/batches";
import {
  completed,
  generate,
  readFrames,
  saveKey,
  startTestServer,
  TEST_KEY,
  type TestServer,
  waitFor,
} from "./helpers";

// §0.4, §0.12 and §8.4.5: one provider batch per Batch run, polled, harvested by job id, canceled as
// a whole, resumed from its stored id after a restart, and announced once when it finishes.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

// The fake batch follows this clock: waiting 1.5 s, then each of the images in turn over 2.5 s.
const clock = { now: Date.now() };
const advance = (ms: number) => {
  clock.now += ms;
};
const batchFake = () => createFakeFetch({ delayMs: 0, now: () => clock.now });
const QUEUE = { batchPollMs: 15 };

async function batchServer(fetch: FetchLike, opts: { home?: string; env?: Record<string, string> } = {}) {
  const s = await startTestServer({ fetch, queue: QUEUE, ...opts });
  if (!opts.home) {
    await saveKey(s);
    await s.json("/api/providers/google/settings", { method: "PATCH", body: { values: { speed: "batch" } } });
  }
  return s;
}

const batchOf = (s: TestServer, jobSetId: string) => getProviderBatchForJobSet(s.services.db, jobSetId);
const statuses = (s: TestServer, jobSetId: string) => jobsOf(s.services.db, jobSetId).map((j) => j.status);
const sentAt = (s: TestServer, jobSetId: string) =>
  waitFor(() => {
    const row = batchOf(s, jobSetId);
    return row?.remoteId ? row : undefined;
  });
const callsTo = (fake: FakeFetch, method: string, pattern: RegExp) =>
  fake.calls.filter((c) => c.method === method && pattern.test(c.url)).length;
const batchFrames = (s: TestServer, jobSetId: string) =>
  s.events
    .filter((e) => e.event === "batch.updated" && (e.data as { jobSetId: string }).jobSetId === jobSetId)
    .map((e) => e.data as Extract<SseEvent, { event: "batch.updated" }>["data"]);
interface InlinedItem {
  response?: { candidates?: { content?: { parts?: { inlineData?: { data: string } }[] } }[] };
}
const usageRows = (s: TestServer) =>
  s.services.db.$client
    .query<{ outcome: string; cost_usd: number; speed: string; discarded: number }, []>(
      "SELECT outcome, cost_usd, speed, discarded FROM usage_log ORDER BY batch_index",
    )
    .all();

describe("a Batch run", () => {
  test("goes as one provider batch, waits, and lands every image at the Batch price", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    server = await batchServer(fake);
    const run = await generate(server, { batch: 2 });
    expect(run.jobSet.speed).toBe("batch");
    expect(run.jobSet.costEstimateUsd).toBe(0.068);

    const row = await sentAt(server, run.jobSet.id);
    expect(row).toMatchObject({ state: "queued", displayName: `openfield-${run.jobSet.id}`, itemCount: 2 });
    expect(statuses(server, run.jobSet.id)).toEqual(["queued", "queued"]);
    await Bun.sleep(60);
    expect(statuses(server, run.jobSet.id)).toEqual(["queued", "queued"]);

    advance(2_000);
    await waitFor(() => statuses(server!, run.jobSet.id).every((s) => s === "running"));
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");

    expect(feedPage(server.services.db).items).toHaveLength(2);
    expect(usageRows(server)).toEqual([
      { outcome: "succeeded", cost_usd: 0.034, speed: "batch", discarded: 0 },
      { outcome: "succeeded", cost_usd: 0.034, speed: "batch", discarded: 0 },
    ]);
    expect(jobsOf(server.services.db, run.jobSet.id).map((j) => j.speedUsed)).toEqual(["batch", "batch"]);
    expect(getJobSet(server.services.db, run.jobSet.id)!.costActualUsd).toBe(0.068);

    const frames = batchFrames(server, run.jobSet.id);
    expect(frames.map((f) => f.state)).toEqual(["submitting", "queued", "running", "succeeded"]);
    expect(frames.map((f) => f.finished)).toEqual([false, false, false, true]);
    expect(frames.at(-1)!.counts).toEqual({ total: 2, succeeded: 2, failed: 0, pending: 0 });

    // One create call, no sync calls, and the batch is tidied up at the company afterwards.
    const done = await waitFor(() => {
      const row = batchOf(server!, run.jobSet.id);
      return row?.cleanedAt ? row : undefined;
    });
    expect(done.state).toBe("succeeded");
    expect(callsTo(fake, "POST", /:batchGenerateContent$/)).toBe(1);
    expect(callsTo(fake, "POST", /:generateContent$/)).toBe(0);
    expect(callsTo(fake, "DELETE", /\/batches\//)).toBe(1);

    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    expect(list.body.items[0]!.batch).toMatchObject({ state: "succeeded" });
  });

  test("holds no slot while it waits, so other runs go ahead", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 1 } });
    const waiting = await generate(server);
    await sentAt(server, waiting.jobSet.id);
    await server.json("/api/providers/google/settings", {
      method: "PATCH",
      body: { values: { speed: "standard" } },
    });
    const now = await generate(server);
    expect((await completed(server, now.jobSet.id)).status).toBe("succeeded");
    expect(statuses(server, waiting.jobSet.id)).toEqual(["queued"]);
  });

  test("a failed item fails only its own tile, with the company's reason", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server, { batch: 2, prompt: "a harbour #fake:batch_partial" });
    await sentAt(server, run.jobSet.id);
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("partial");
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "failed"]);
    // Never retried on its own: resending could bill twice. The tile offers Try again instead.
    expect(jobs[1]!.attempt).toBe(1);
    expect([jobs[1]!.errorCode, jobs[1]!.errorAction]).toEqual(["provider_unavailable", "try-again"]);
  });

  test("an expired batch fails its images as a timeout, in Google's words", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server, { prompt: "a harbour #fake:batch_expired" });
    await sentAt(server, run.jobSet.id);
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = jobsOf(server.services.db, run.jobSet.id)[0]!;
    expect([job.errorCode, job.errorReason, job.errorAction]).toEqual([
      "timeout",
      "Google didn't finish this within 48 hours.",
      "try-again",
    ]);
    expect(batchOf(server, run.jobSet.id)!.state).toBe("expired");
  });
});

describe("cancel", () => {
  test("stops the whole batch at the company and keeps what finished first", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    server = await batchServer(fake);
    const run = await generate(server, { batch: 2 });
    await sentAt(server, run.jobSet.id);
    // The first image is done at 2.75 s, the second at 4 s.
    advance(3_000);
    await waitFor(() => statuses(server!, run.jobSet.id).every((s) => s === "running"));

    // Canceling one tile cancels the run: one provider batch can't lose one request.
    const res = await server.json(`/api/jobs/${run.jobs[1]!.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await completed(server, run.jobSet.id)).status).toBe("partial");
    expect(statuses(server, run.jobSet.id)).toEqual(["succeeded", "canceled"]);
    expect(feedPage(server.services.db).items).toHaveLength(1);
    expect(usageRows(server)).toEqual([
      { outcome: "succeeded", cost_usd: 0.034, speed: "batch", discarded: 0 },
      { outcome: "canceled", cost_usd: 0.034, speed: "batch", discarded: 1 },
    ]);
    expect(callsTo(fake, "POST", /\/batches\/[^/]+:cancel$/)).toBe(1);
    expect(batchOf(server, run.jobSet.id)).toMatchObject({ state: "canceled", errorCode: "canceled" });
  });

  test("before anything is made, every image is canceled and logged as possibly billed", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server, { batch: 2 });
    await sentAt(server, run.jobSet.id);
    const res = await server.json<CancelResponse>(`/api/job-sets/${run.jobSet.id}/cancel`, {
      method: "POST",
    });
    // Sent images end when the company stops, so they're stopping, not canceled yet.
    expect(res.body.canceled).toEqual([]);
    expect(res.body.stopping?.sort()).toEqual(run.jobs.map((j) => j.id).sort());
    const stopping = batchFrames(server, run.jobSet.id).find((f) => f.stopping);
    expect(stopping).toMatchObject({ state: "queued", stopping: true, finished: false });
    const list = await server.json<JobSetsListResponse>("/api/job-sets?status=all");
    expect(list.body.items.find((i) => i.jobSet.id === run.jobSet.id)?.batch?.stopping).toBe(true);

    expect((await completed(server, run.jobSet.id)).status).toBe("canceled");
    expect(usageRows(server).map((r) => [r.outcome, r.discarded, r.cost_usd])).toEqual([
      ["canceled", 1, 0.034],
      ["canceled", 1, 0.034],
    ]);
    const frames = batchFrames(server, run.jobSet.id);
    expect(frames.at(-1)).toMatchObject({ state: "canceled", finished: true });
  });
});

describe("cancel during the create call", () => {
  test("is sent once the company has the batch, so nothing is left running there", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: FetchLike = async (input, init) => {
      if (String(input).includes(":batchGenerateContent")) await held;
      return fake(input, init);
    };
    server = await batchServer(slow);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => batchOf(server!, run.jobSet.id));
    const res = await server.json<CancelResponse>(`/api/job-sets/${run.jobSet.id}/cancel`, {
      method: "POST",
    });
    expect(res.body.stopping?.sort()).toEqual(run.jobs.map((j) => j.id).sort());

    release();
    expect((await completed(server, run.jobSet.id)).status).toBe("canceled");
    expect(callsTo(fake, "POST", /\/batches\/[^/]+:cancel$/)).toBe(1);
    expect(batchOf(server, run.jobSet.id)!.remoteId).not.toBeNull();
    expect(usageRows(server).map((r) => [r.outcome, r.discarded])).toEqual([
      ["canceled", 1],
      ["canceled", 1],
    ]);
  });
});

describe("a key that can't read the batch", () => {
  // Google answers 403 to a batch read with a key from another project.
  const refusing = (fake: FakeFetch) => {
    const gate = { refuse: false, refused: 0 };
    const fetch: FetchLike = async (input, init) => {
      const read = /\/batches\/[^/:]+$/.test(String(input)) && (init?.method ?? "GET") === "GET";
      if (gate.refuse && read) {
        gate.refused++;
        const body = { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied" } };
        return Response.json(body, { status: 403 });
      }
      return fake(input, init);
    };
    return { gate, fetch };
  };

  test("keeps checking while another key is saved, and lands once the first one is back", async () => {
    clock.now = Date.now();
    const { gate, fetch } = refusing(batchFake());
    server = await batchServer(fetch);
    const run = await generate(server);
    await sentAt(server, run.jobSet.id);
    await saveKey(server, "AIzaAnotherKey-0123456789abcdefWXYZ");
    gate.refuse = true;
    advance(10_000);
    await waitFor(() => gate.refused >= 3);
    // The batch runs on at Google for up to 48 hours, so nothing fails yet.
    expect(statuses(server, run.jobSet.id)).toEqual(["queued"]);
    expect(batchOf(server, run.jobSet.id)!.finishedAt).toBeNull();

    gate.refuse = false;
    await saveKey(server, TEST_KEY);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
  });

  test("refused with the key it was sent with, the run is gone at the company", async () => {
    clock.now = Date.now();
    const { gate, fetch } = refusing(batchFake());
    server = await batchServer(fetch);
    const run = await generate(server);
    await sentAt(server, run.jobSet.id);
    gate.refuse = true;
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = jobsOf(server.services.db, run.jobSet.id)[0]!;
    expect([job.errorCode, job.errorReason, job.errorAction]).toEqual([
      "auth_forbidden",
      "Google can't find this run anymore.",
      "try-again",
    ]);
  });
});

describe("restart", () => {
  test("a batch waiting at the company is resumed from its id, never interrupted or sent again", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server, { batch: 2 });
    const row = await sentAt(server, run.jobSet.id);
    const home = server.home;
    // Left at Google, which the stop says it picks up next time.
    expect(await server.services.runner.stop()).toEqual({ left: 2, cut: { rerun: 0, interrupted: 0 } });
    await server.close({ keepHome: true });

    const after = batchFake();
    server = await batchServer(after, { home });
    expect(statuses(server, run.jobSet.id)).toEqual(["queued", "queued"]);
    // The boot line counts them, and their tiles keep saying they're waiting at Google.
    const log = (file: string) =>
      readFileSync(join(home, "logs", file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(log("jobs.ndjson").findLast((l) => l.event === "startup.recovery")).toMatchObject({
      resumed: 0,
      batched: 2,
      interrupted: 0,
    });
    expect(log("openfield.log").map((l) => l.msg)).toContain("Picking up 2 images where they left off.");
    expect(jobsOf(server.services.db, run.jobSet.id).map((j) => j.resumedAt)).toEqual([null, null]);
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(feedPage(server.services.db).items).toHaveLength(2);
    expect(callsTo(after, "POST", /:batchGenerateContent$/)).toBe(0);
    expect(batchOf(server, run.jobSet.id)!.remoteId).toBe(row.remoteId);
  });

  test("a create cut off before its id was stored is found by name and resumed", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    let hang = true;
    // The company makes the batch, but the answer never arrives before the server stops.
    const lost: FetchLike = async (input, init) => {
      const res = await fake(input, init);
      if (hang && String(input).includes(":batchGenerateContent")) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return res;
    };
    server = await batchServer(lost);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => callsTo(fake, "POST", /:batchGenerateContent$/) === 1);
    expect(batchOf(server, run.jobSet.id)).toMatchObject({ state: "submitting", remoteId: null });
    const home = server.home;
    await server.close({ keepHome: true });

    hang = false;
    server = await batchServer(lost, { home });
    const row = await sentAt(server, run.jobSet.id);
    expect(row.state).toBe("queued");
    expect(statuses(server, run.jobSet.id)).toEqual(["queued", "queued"]);
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(callsTo(fake, "POST", /:batchGenerateContent$/)).toBe(1);
  });

  test("a create that never reached the company is interrupted, never sent again", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    const stuck: FetchLike = async (input, init) => {
      if (String(input).includes(":batchGenerateContent")) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return fake(input, init);
    };
    server = await batchServer(stuck);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => batchOf(server!, run.jobSet.id));
    const home = server.home;
    await server.close({ keepHome: true });

    server = await batchServer(fake, { home });
    expect((await completed(server, run.jobSet.id)).status).toBe("interrupted");
    expect(statuses(server, run.jobSet.id)).toEqual(["interrupted", "interrupted"]);
    expect(batchOf(server, run.jobSet.id)!.state).toBe("failed");
    expect(callsTo(fake, "POST", /:batchGenerateContent$/)).toBe(0);
  });
});

describe("a lookup that can't run", () => {
  test("keeps the run waiting to be found, never interrupted, and resumes it once it can look", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    let hang = true;
    const lost: FetchLike = async (input, init) => {
      const res = await fake(input, init);
      if (hang && String(input).includes(":batchGenerateContent")) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        );
      }
      return res;
    };
    server = await batchServer(lost);
    const run = await generate(server, { batch: 2 });
    await waitFor(() => callsTo(fake, "POST", /:batchGenerateContent$/) === 1);
    const home = server.home;
    await server.close({ keepHome: true });

    // After the restart, listing batches fails until the network is back.
    hang = false;
    const offline = { on: true, lookups: 0 };
    const flaky: FetchLike = async (input, init) => {
      if (/\/v1beta\/batches(\?|$)/.test(String(input))) {
        offline.lookups++;
        if (offline.on) throw new TypeError("fetch failed");
      }
      return lost(input, init);
    };
    server = await batchServer(flaky, { home });
    await waitFor(() => offline.lookups >= 3);
    expect(statuses(server, run.jobSet.id)).toEqual(["submitting", "submitting"]);
    expect(batchOf(server, run.jobSet.id)).toMatchObject({ state: "submitting", finishedAt: null });

    offline.on = false;
    expect((await sentAt(server, run.jobSet.id)).state).toBe("queued");
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(callsTo(fake, "POST", /:batchGenerateContent$/)).toBe(1);
  });
});

describe("past the deadline", () => {
  /** Moves a waiting batch's dates back, as if Openfield had been closed for `hours`. */
  function ageBatch(home: string, jobSetId: string, hours: number) {
    const db = new Database(join(home, "openfield.db"));
    const back = (iso: string | null) => iso && new Date(Date.parse(iso) - hours * 3_600_000).toISOString();
    const row = db
      .query<{ created_at: string; submitted_at: string | null; expires_at: string | null }, [string]>(
        "SELECT created_at, submitted_at, expires_at FROM provider_batches WHERE job_set_id = ?",
      )
      .get(jobSetId)!;
    db.run(
      "UPDATE provider_batches SET created_at = ?, submitted_at = ?, expires_at = ? WHERE job_set_id = ?",
      [back(row.created_at), back(row.submitted_at), back(row.expires_at), jobSetId],
    );
    db.close();
  }

  /** A run sent, then Openfield closed for 55 hours: past Google's 48 and the 6-hour grace. */
  async function closedForAWeekend(prompt = "a lighthouse at dusk") {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server, { batch: 2, prompt });
    await sentAt(server, run.jobSet.id);
    const home = server.home;
    await server.close({ keepHome: true });
    ageBatch(home, run.jobSet.id, 55);
    return { run, home };
  }

  const batchReads = (input: string | URL | Request, init?: RequestInit) =>
    /\/batches\/[^/:?]+$/.test(String(input)) && (init?.method ?? "GET") === "GET";

  test("a run Google finished while Openfield was closed is collected and tidied up", async () => {
    const { run, home } = await closedForAWeekend();
    advance(10_000);
    const after = batchFake();
    server = await batchServer(after, { home });
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(feedPage(server.services.db).items).toHaveLength(2);
    const done = await waitFor(() => {
      const row = batchOf(server!, run.jobSet.id);
      return row?.cleanedAt ? row : undefined;
    });
    expect(done.state).toBe("succeeded");
    expect(callsTo(after, "DELETE", /\/batches\//)).toBe(1);
  });

  test("still waiting at Google: stopped there and failed as a timeout, with nothing deleted", async () => {
    const { run, home } = await closedForAWeekend("a harbour #fake:batch_slow");
    const after = batchFake();
    server = await batchServer(after, { home });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = jobsOf(server.services.db, run.jobSet.id)[0]!;
    expect([job.errorCode, job.errorReason]).toEqual([
      "timeout",
      "Google didn't finish this within 48 hours.",
    ]);
    const row = await waitFor(() => {
      const r = batchOf(server!, run.jobSet.id);
      return r?.cleanedAt ? r : undefined;
    });
    expect(row.state).toBe("expired");
    expect(callsTo(after, "POST", /\/batches\/[^/]+:cancel$/)).toBe(1);
    expect(callsTo(after, "DELETE", /\/batches\//)).toBe(0);
  });

  test("a check that fails at boot is tried again, so a finished run still lands", async () => {
    const { run, home } = await closedForAWeekend();
    advance(10_000);
    const after = batchFake();
    let failures = 2;
    const flaky: FetchLike = async (input, init) => {
      if (failures > 0 && batchReads(input, init)) {
        failures--;
        throw new TypeError("fetch failed");
      }
      return after(input, init);
    };
    server = await batchServer(flaky, { home });
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(failures).toBe(0);
  });

  test("checks that keep failing end the run in plain words, and nothing at Google is deleted", async () => {
    const { run, home } = await closedForAWeekend();
    const after = batchFake();
    const down: FetchLike = async (input, init) => {
      if (batchReads(input, init)) throw new TypeError("fetch failed");
      return after(input, init);
    };
    server = await batchServer(down, { home });
    expect((await completed(server, run.jobSet.id)).status).toBe("failed");
    const job = jobsOf(server.services.db, run.jobSet.id)[0]!;
    expect([job.errorReason, job.errorAction]).toEqual([
      "Openfield couldn't reach Google to check on this run.",
      "try-again",
    ]);
    expect(batchOf(server, run.jobSet.id)).toMatchObject({ state: "failed" });
    expect(after.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("saving a finished batch", () => {
  test("an image that isn't one fails only its own tile; the rest land and the run is tidied up", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    // The second result's bytes aren't an image.
    const corrupt: FetchLike = async (input, init) => {
      const res = await fake(input, init);
      if ((init?.method ?? "GET") !== "GET" || !/\/batches\/fake/.test(String(input))) return res;
      const body = (await res.json()) as {
        metadata?: { output?: { inlinedResponses?: { inlinedResponses?: InlinedItem[] } } };
        response?: unknown;
      };
      const items = body.metadata?.output?.inlinedResponses?.inlinedResponses;
      for (const part of items?.[1]?.response?.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData) part.inlineData.data = Buffer.from("not an image").toString("base64");
      }
      if (items) body.response = { inlinedResponses: { inlinedResponses: items } };
      return Response.json(body, { status: res.status });
    };
    server = await batchServer(corrupt);
    const run = await generate(server, { batch: 3 });
    await sentAt(server, run.jobSet.id);
    advance(10_000);
    expect((await completed(server, run.jobSet.id)).status).toBe("partial");
    const jobs = jobsOf(server.services.db, run.jobSet.id);
    expect(jobs.map((j) => [j.status, j.errorCode])).toEqual([
      ["succeeded", null],
      ["failed", "provider_error"],
      ["succeeded", null],
    ]);
    expect(feedPage(server.services.db).items).toHaveLength(2);
    await waitFor(() => batchOf(server!, run.jobSet.id)?.cleanedAt);
    expect(callsTo(fake, "DELETE", /\/batches\//)).toBe(1);
  });

  test("with the disk full, images wait at Google and land once there's room", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    server = await batchServer(fake);
    const ingest = server.services.ingest;
    const stage = ingest.stage.bind(ingest);
    const disk = { full: true, refused: 0 };
    ingest.stage = async (stream, opts) => {
      if (!disk.full) return stage(stream, opts);
      disk.refused++;
      await stream.cancel();
      throw new ProviderError("disk_full", { message: "The disk is full" });
    };
    const run = await generate(server, { batch: 2 });
    await sentAt(server, run.jobSet.id);
    advance(10_000);
    await waitFor(() => disk.refused >= 4);
    // Nothing failed and nothing was deleted: Google still holds them.
    expect(statuses(server, run.jobSet.id).every((s) => s === "running")).toBe(true);
    expect(batchOf(server, run.jobSet.id)!.finishedAt).toBeNull();
    expect(callsTo(fake, "DELETE", /\/batches\//)).toBe(0);

    disk.full = false;
    expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(feedPage(server.services.db).items).toHaveLength(2);
  });
});

describe("slots", () => {
  test("checks on waiting batches share the concurrency caps with every other call", async () => {
    clock.now = Date.now();
    const fake = batchFake();
    const reads = { active: 0, most: 0 };
    const tracked: FetchLike = async (input, init) => {
      if (!/\/batches\/[^/:?]+$/.test(String(input)) || (init?.method ?? "GET") !== "GET") {
        return fake(input, init);
      }
      reads.active++;
      reads.most = Math.max(reads.most, reads.active);
      try {
        await Bun.sleep(20);
        return await fake(input, init);
      } finally {
        reads.active--;
      }
    };
    server = await batchServer(tracked);
    await server.json("/api/settings", { method: "PATCH", body: { globalConcurrency: 1 } });
    const runs = [await generate(server), await generate(server), await generate(server)];
    for (const run of runs) await sentAt(server, run.jobSet.id);
    advance(10_000);
    for (const run of runs) expect((await completed(server, run.jobSet.id)).status).toBe("succeeded");
    expect(reads.most).toBe(1);
  });
});

describe("recovery", () => {
  test("a sent job with no live batch behind it can't be picked up again, so it's interrupted", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server);
    await sentAt(server, run.jobSet.id);
    server.services.db.$client.run("DELETE FROM provider_batches WHERE job_set_id = ?", [run.jobSet.id]);
    const home = server.home;
    await server.close({ keepHome: true });

    server = await batchServer(batchFake(), { home });
    expect(statuses(server, run.jobSet.id)).toEqual(["interrupted"]);
    expect(getJobSet(server.services.db, run.jobSet.id)!.status).toBe("interrupted");
  });
});

describe("the finish notice", () => {
  const snapshotBatches = async (s: TestServer) => {
    const [frame] = await readFrames(await s.request("/api/events"), (frames) => frames.length > 0);
    const parsed = parseSseFrame(frame!.event, frame!.data) as Extract<SseEvent, { event: "snapshot" }>;
    return parsed.data.batches;
  };
  const notified = (row: ProviderBatchRow | undefined) => row?.notifiedAt ?? null;

  test("waits in the snapshot for the first tab, then is marked as announced", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server);
    await sentAt(server, run.jobSet.id);
    // In flight: every snapshot lists it.
    expect((await snapshotBatches(server)).map((b) => [b.jobSetId, b.finished])).toEqual([
      [run.jobSet.id, false],
    ]);

    advance(10_000);
    await completed(server, run.jobSet.id);
    expect(notified(batchOf(server, run.jobSet.id))).toBeNull();

    const first = await snapshotBatches(server);
    expect(first).toEqual([
      expect.objectContaining({
        jobSetId: run.jobSet.id,
        providerId: "google",
        state: "succeeded",
        finished: true,
        counts: { total: 1, succeeded: 1, failed: 0, pending: 0 },
      }),
    ]);
    expect(notified(batchOf(server, run.jobSet.id))).not.toBeNull();
    expect(await snapshotBatches(server)).toEqual([]);
  });

  test("a tab that's open when it finishes gets the frame, and it's announced once", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake());
    const run = await generate(server);
    await sentAt(server, run.jobSet.id);
    const reading = readFrames(await server.request("/api/events"), (frames) =>
      frames.some((f) => f.event === "batch.updated" && JSON.parse(f.data).finished),
    );
    await Bun.sleep(20);
    advance(10_000);
    const frames = await reading;
    const finish = frames.find((f) => f.event === "batch.updated" && JSON.parse(f.data).finished)!;
    expect(parseSseFrame(finish.event, finish.data)).not.toBeNull();
    expect(notified(batchOf(server, run.jobSet.id))).not.toBeNull();
    expect(await snapshotBatches(server)).toEqual([]);
  });
});

describe("fake mode", () => {
  test("a Batch run costs nothing and never counts toward spend", async () => {
    clock.now = Date.now();
    server = await batchServer(batchFake(), { env: { OPENFIELD_FAKE_PROVIDERS: "1" } });
    const run = await generate(server, { batch: 2 });
    expect(run.jobSet.costEstimateUsd).toBe(0.068);
    await sentAt(server, run.jobSet.id);
    advance(10_000);
    expect(await completed(server, run.jobSet.id)).toMatchObject({ status: "succeeded", costActualUsd: 0 });
    expect(usageRows(server).map((r) => [r.cost_usd, r.speed])).toEqual([
      [0, "batch"],
      [0, "batch"],
    ]);
    expect((await server.json<{ totalUsd: number }>("/api/usage")).body.totalUsd).toBe(0);
  });
});

describe("a call made while the server stops", () => {
  test("isn't sent once the stop has begun, and one already out fails without taking the server down", async () => {
    const stopped = AbortSignal.abort(new DOMException("Shutting down", "AbortError"));
    let sent = 0;
    const call = async () => {
      sent++;
    };
    await expect(untilAborted(call, stopped)).rejects.toThrow("Shutting down");
    expect(sent).toBe(0);

    // Bun exits on an unhandled rejection. The late failure is handled, so this test lives on.
    let fail: (err: Error) => void = () => {};
    const out = new Promise<void>((_, reject) => {
      fail = reject;
    });
    await expect(untilAborted(out, stopped)).rejects.toThrow("Shutting down");
    fail(new ProviderError("canceled", { message: "The request was aborted" }));
    await Bun.sleep(10);
  });
});

// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { BatchUpdated, JobSetWithJobs } from "@openfield/core";
import { queryClient, queryKeys } from "../src/api/client";
import { applyEvent } from "../src/api/events";
import { addJobSet } from "../src/api/hooks/job-sets";
import { waitKind } from "../src/image/feed-items";
import { useLive } from "../src/lib/live";
import { at, jobSet } from "./fixtures";

// The feed's cache as the stream and the 202 race to fill it (§2.3): whichever lands last, a job
// never moves backwards.

const cached = () => queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets("image")) ?? [];

beforeEach(() => queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets("image"), []));

describe("a new run in the cache", () => {
  test("job_set.created, then job.started, then the 202: the started job stays started", () => {
    const accepted = jobSet(at(0), ["pending", "pending"], { speed: "flex", status: "pending" });
    const [first] = accepted.jobs;
    applyEvent({ event: "job_set.created", data: accepted });
    applyEvent({
      event: "job.started",
      data: { jobSetId: accepted.jobSet.id, jobId: first!.id, idx: 0, startedAt: at(1) },
    });
    addJobSet(accepted);

    const [run] = cached();
    expect(cached()).toHaveLength(1);
    expect(run!.jobs.map((j) => j.status)).toEqual(["running", "pending"]);
    // So the Flex tile waits for Google from the first moment, not only after a reload.
    expect(waitKind(run!.jobSet, run!.jobs[0]!, undefined)).toBe("flex");
  });

  test("the 202 first, when the stream hasn't sent the run yet", () => {
    const accepted = jobSet(at(0), ["pending"], { status: "pending" });
    addJobSet(accepted);
    expect(cached().map((s) => s.jobSet.id)).toEqual([accepted.jobSet.id]);
    applyEvent({ event: "job_set.created", data: accepted });
    expect(cached()).toHaveLength(1);
  });
});

describe("after a restart", () => {
  test("job.started with rerun marks the job, so its tile warns it may be charged twice", () => {
    const run = jobSet(at(0), ["pending", "pending"]);
    applyEvent({ event: "job_set.created", data: run });
    const [first, second] = run.jobs;
    applyEvent({
      event: "job.started",
      data: { jobSetId: run.jobSet.id, jobId: first!.id, idx: 0, startedAt: at(2), rerun: true },
    });
    applyEvent({
      event: "job.started",
      data: { jobSetId: run.jobSet.id, jobId: second!.id, idx: 1, startedAt: at(2) },
    });
    const jobs = cached()[0]!.jobs;
    expect(jobs.map((j) => j.rerunAt ?? null)).toEqual([at(2), null]);
  });

  test("the server's own rerunAt from the snapshot stays", () => {
    const run = jobSet(at(0), ["pending"]);
    run.jobs[0]!.rerunAt = at(1);
    applyEvent({ event: "snapshot", data: { activeJobSets: [run], serverTime: at(2), batches: [] } });
    applyEvent({
      event: "job.started",
      data: { jobSetId: run.jobSet.id, jobId: run.jobs[0]!.id, idx: 0, startedAt: at(3), rerun: true },
    });
    expect(cached()[0]!.jobs[0]!.rerunAt).toBe(at(1));
  });
});

describe("Batch runs in flight", () => {
  const frame = (jobSetId: string, over: Partial<BatchUpdated> = {}): BatchUpdated => ({
    jobSetId,
    providerId: "google",
    modelKey: "google:gemini-3-pro-image",
    state: "queued",
    submittedAt: at(1),
    expiresAt: at(2),
    finished: false,
    ...over,
  });

  test("canvas nodes see a run until it ends, and each snapshot starts the list over", () => {
    const first = jobSet(at(0), ["running"]).jobSet.id;
    const second = jobSet(at(1), ["running"]).jobSet.id;
    applyEvent({ event: "batch.updated", data: frame(first, { canvasId: first }) });
    expect(useLive.getState().batches[first]).toEqual({
      providerId: "google",
      state: "queued",
      stopping: false,
    });
    applyEvent({ event: "batch.updated", data: frame(first, { state: "canceled", finished: true }) });
    expect(useLive.getState().batches[first]).toBeUndefined();

    applyEvent({ event: "batch.updated", data: frame(second, { stopping: true }) });
    expect(useLive.getState().batches[second]?.stopping).toBe(true);
    // It ended while the stream was down: the next snapshot no longer lists it.
    applyEvent({ event: "snapshot", data: { activeJobSets: [], serverTime: at(3), batches: [] } });
    expect(useLive.getState().batches).toEqual({});
  });
});

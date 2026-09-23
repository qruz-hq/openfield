// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { JobSetWithJobs } from "@openfield/core";
import { queryClient, queryKeys } from "../src/api/client";
import { applyEvent } from "../src/api/events";
import { addJobSet } from "../src/api/hooks/job-sets";
import { waitKind } from "../src/image/feed-items";
import { at, jobSet } from "./fixtures";

// The feed's cache as the stream and the 202 race to fill it (§2.3): whichever lands last, a job
// never moves backwards.

const cached = () => queryClient.getQueryData<JobSetWithJobs[]>(queryKeys.jobSets) ?? [];

beforeEach(() => queryClient.setQueryData<JobSetWithJobs[]>(queryKeys.jobSets, []));

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

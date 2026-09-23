// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import type { ErrorAction } from "@openfield/core";
import { buildFeed, failedAction, jobTileState, waitKind } from "../src/image/feed-items";
import { asset, at, jobSet } from "./fixtures";

const none = new Set<string>();

describe("buildFeed", () => {
  test("newest first, runs and images together", () => {
    const old = asset(at(0));
    const run = jobSet(at(10), ["running", "pending"]);
    const fresh = asset(at(20));
    const items = buildFeed({
      assets: [fresh, old],
      jobSets: [run],
      dismissed: none,
      includeJobs: true,
      hasMoreAssets: false,
    });
    expect(items.map((i) => i.key)).toEqual([
      `asset:${fresh.id}`,
      `job:${run.jobs[0]!.id}`,
      `job:${run.jobs[1]!.id}`,
      `asset:${old.id}`,
    ]);
  });

  test("a finished image sorts with its run, in batch order", () => {
    const run = jobSet(at(10), ["succeeded", "running"]);
    const made = asset(at(30), { jobSetId: run.jobSet.id, jobId: run.jobs[0]!.id });
    const later = asset(at(20));
    const items = buildFeed({
      assets: [made, later],
      jobSets: [run],
      dismissed: none,
      includeJobs: true,
      hasMoreAssets: false,
    });
    expect(items.map((i) => i.key)).toEqual([
      `asset:${later.id}`,
      `asset:${made.id}`,
      `job:${run.jobs[1]!.id}`,
    ]);
  });

  test("dismissed failures and succeeded jobs don't show as run tiles", () => {
    const run = jobSet(at(10), ["succeeded", "failed", "failed"]);
    const items = buildFeed({
      assets: [],
      jobSets: [run],
      dismissed: new Set([run.jobs[1]!.id]),
      includeJobs: true,
      hasMoreAssets: false,
    });
    expect(items.map((i) => i.key)).toEqual([`job:${run.jobs[2]!.id}`]);
  });

  test("filtered feeds show images only", () => {
    const run = jobSet(at(10), ["running"]);
    expect(
      buildFeed({ assets: [], jobSets: [run], dismissed: none, includeJobs: false, hasMoreAssets: false }),
    ).toEqual([]);
  });

  test("runs older than the last loaded image wait for the next page", () => {
    const run = jobSet(at(1), ["failed"]);
    const items = buildFeed({
      assets: [asset(at(5))],
      jobSets: [run],
      dismissed: none,
      includeJobs: true,
      hasMoreAssets: true,
    });
    expect(items.every((i) => i.kind === "asset")).toBe(true);
  });
});

describe("jobTileState", () => {
  const [job] = jobSet(at(0), ["pending"]).jobs;
  test("maps job states to tiles", () => {
    expect(jobTileState({ ...job!, status: "running" }, undefined)).toBe("generating");
    expect(jobTileState({ ...job!, status: "pending" }, undefined)).toBe("generating");
    expect(jobTileState({ ...job!, status: "pending" }, 2)).toBe("queued");
    expect(jobTileState({ ...job!, status: "queued" }, undefined)).toBe("queued");
    expect(jobTileState({ ...job!, status: "canceled" }, undefined)).toBe("failed");
    expect(jobTileState({ ...job!, status: "interrupted" }, undefined)).toBe("failed");
  });
});

describe("waitKind", () => {
  const job = (status: Parameters<typeof jobSet>[1][number], nextAttemptAt: string | null = null) => ({
    status,
    nextAttemptAt,
  });

  test("a Batch run's own batch says whether it's being sent or waiting", () => {
    const set = { speed: "batch" } as const;
    // The stream starts the jobs as the create call goes out, before the call returns.
    expect(waitKind(set, job("running"), undefined, { state: "submitting" })).toBe("batch-sending");
    expect(waitKind(set, job("submitting"), undefined, { state: "submitting" })).toBe("batch-sending");
    expect(waitKind(set, job("queued"), undefined, { state: "queued" })).toBe("batch");
    expect(waitKind(set, job("running"), undefined, { state: "running" })).toBe("batch");
    expect(waitKind(set, job("failed"), undefined, { state: "running" })).toBeNull();
  });

  test("a Batch job waiting for a free slot is only queued here: nothing was sent", () => {
    const set = { speed: "batch" } as const;
    expect(waitKind(set, job("pending"), undefined)).toBeNull();
    expect(jobTileState(jobSet(at(0), ["pending"]).jobs[0]!, undefined, set)).toBe("queued");
    // Moved on by the stream before the batch frame arrived.
    expect(waitKind(set, job("running"), undefined)).toBe("batch-sending");
  });

  test("Flex waits while its call is open or a busy answer is waited out", () => {
    const flex = { speed: "flex" } as const;
    expect(waitKind(flex, job("running"), undefined)).toBe("flex");
    expect(waitKind(flex, job("queued"), undefined)).toBeNull();
    expect(waitKind(flex, job("queued"), { busy: true })).toBe("flex-busy");
    expect(waitKind(flex, job("queued"), { busy: false })).toBeNull();
    // After a reload only the next attempt is known.
    expect(waitKind(flex, job("pending", at(5)), undefined)).toBe("flex-busy");
  });

  test("Standard and Priority keep the generating tile", () => {
    expect(waitKind({ speed: "standard" }, job("running"), undefined)).toBeNull();
    expect(waitKind({ speed: "priority" }, job("running"), undefined)).toBeNull();
  });
});

describe("failedAction", () => {
  const failed = (errorAction: ErrorAction | null = null) => ({ status: "failed" as const, errorAction });

  // §0.5: the reasons speeds and billing add, each with its button.
  test("a speed or billing reason gets the button the server saved on the job", () => {
    expect(failedAction(failed(), "billing_required")).toBe("open-billing");
    expect(failedAction(failed("try-again"), "provider_unavailable")).toBe("try-again");
    expect(failedAction(failed("open-settings"), "unsupported_param")).toBe("open-settings");
    expect(failedAction(failed("try-again"), "timeout")).toBe("try-again");
    expect(failedAction(failed("try-again"), "auth_forbidden")).toBe("try-again");
  });

  test("otherwise the code's usual button, and Try again after a restart", () => {
    expect(failedAction(failed(), "provider_unavailable")).toBe("details");
    expect(failedAction(failed(), "unsupported_param")).toBe("reuse");
    expect(failedAction({ status: "interrupted", errorAction: null }, "unknown")).toBe("try-again");
  });
});

// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { describe, expect, test } from "bun:test";
import { buildFeed, jobTileState } from "../src/image/feed-items";
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

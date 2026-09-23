import type { AssetListItem, Job, JobSet, JobSetWithJobs } from "@openfield/core";

// The feed is one list, newest first: finished images plus the runs still working or that
// failed (§2.3, §2.4). An image sorts with the run that made it, so a batch stays together.

export type FeedItem =
  | { kind: "asset"; key: string; asset: AssetListItem; sort: number; idx: number }
  | {
      kind: "job";
      key: string;
      jobSet: JobSet;
      job: Job;
      /** Every job in the run, so one failed tile can act for the whole run. */
      jobs: readonly Job[];
      sort: number;
      idx: number;
    };

export interface FeedInput {
  assets: readonly AssetListItem[];
  jobSets: readonly JobSetWithJobs[];
  /** Failed tiles the person dismissed. */
  dismissed: ReadonlySet<string>;
  /** Runs only show on the unfiltered feed. */
  includeJobs: boolean;
  /** More images to page in: runs older than the last loaded image wait until they arrive. */
  hasMoreAssets: boolean;
}

const time = (iso: string) => Date.parse(iso);

export function buildFeed({ assets, jobSets, dismissed, includeJobs, hasMoreAssets }: FeedInput): FeedItem[] {
  const setTime = new Map<string, number>();
  const jobIdx = new Map<string, number>();
  for (const { jobSet, jobs } of jobSets) {
    setTime.set(jobSet.id, time(jobSet.createdAt));
    for (const job of jobs) jobIdx.set(job.id, job.idx);
  }

  const items: FeedItem[] = assets.map((asset) => ({
    kind: "asset",
    key: `asset:${asset.id}`,
    asset,
    sort: (asset.jobSetId && setTime.get(asset.jobSetId)) || time(asset.createdAt),
    idx: (asset.jobId && jobIdx.get(asset.jobId)) || 0,
  }));

  if (includeJobs) {
    const oldestAsset = items.reduce((min, item) => Math.min(min, item.sort), Number.POSITIVE_INFINITY);
    for (const { jobSet, jobs } of jobSets) {
      const sort = time(jobSet.createdAt);
      if (hasMoreAssets && sort < oldestAsset) continue;
      for (const job of jobs) {
        // A finished job is its image now; the asset list carries it.
        if (job.status === "succeeded" || dismissed.has(job.id)) continue;
        items.push({ kind: "job", key: `job:${job.id}`, jobSet, job, jobs, sort, idx: job.idx });
      }
    }
  }

  return items.sort((a, b) => b.sort - a.sort || a.idx - b.idx || a.key.localeCompare(b.key));
}

export type JobTileState = "generating" | "queued" | "failed";

/** Jobs in a run that ended without an image: failed, canceled or interrupted. */
export const endedWithoutImage = (jobs: readonly Job[]) =>
  jobs.filter((job) => jobTileState(job, undefined) === "failed");

export function jobTileState(job: Job, position: number | undefined): JobTileState {
  switch (job.status) {
    case "failed":
    case "canceled":
    case "interrupted":
      return "failed";
    case "queued":
      return "queued";
    case "pending":
      return position ? "queued" : "generating";
    default:
      return "generating";
  }
}

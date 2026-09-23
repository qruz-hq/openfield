import {
  type AssetListItem,
  type BatchSummary,
  ERROR_PRIMARY_ACTION,
  type ErrorAction,
  type ErrorCode,
  type Job,
  type JobSet,
  type JobSetWithJobs,
} from "@openfield/core";

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
      /** A Batch run's provider batch, once it has one. */
      batch?: BatchSummary | undefined;
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
    for (const { jobSet, jobs, batch } of jobSets) {
      const sort = time(jobSet.createdAt);
      if (hasMoreAssets && sort < oldestAsset) continue;
      for (const job of jobs) {
        // A finished job is its image now; the asset list carries it.
        if (job.status === "succeeded" || dismissed.has(job.id)) continue;
        items.push({ kind: "job", key: `job:${job.id}`, jobSet, job, jobs, batch, sort, idx: job.idx });
      }
    }
  }

  return items.sort((a, b) => b.sort - a.sort || a.idx - b.idx || a.key.localeCompare(b.key));
}

export type JobTileState = "generating" | "queued" | "failed";

/**
 * The tile for a run at a slower speed (§2.4, design RWSvj and LGwLk). Batch shows Sending while the
 * company's create call is out, then Waiting until the images land. Flex waits while its call is
 * open, or while a busy answer is waited out.
 */
export type WaitKind = "batch-sending" | "batch" | "flex" | "flex-busy";

export function waitKind(
  jobSet: Pick<JobSet, "speed">,
  job: Pick<Job, "status" | "nextAttemptAt">,
  retry: { busy: boolean } | undefined,
  batch?: Pick<BatchSummary, "state"> | undefined,
): WaitKind | null {
  switch (job.status) {
    case "pending":
    case "submitting":
    case "queued":
    case "running":
      break;
    default:
      return null;
  }
  if (jobSet.speed === "batch") {
    // The run's batch says where it is: the stream moves jobs on before the create call returns.
    if (batch) return batch.state === "submitting" ? "batch-sending" : "batch";
    // Nothing sent yet: a pending job is waiting its turn here, a submitting one is being sent.
    return job.status === "pending" ? null : "batch-sending";
  }
  if (jobSet.speed !== "flex") return null;
  // After a reload the stream's busy flag is gone; a Flex job with a next attempt is the same wait.
  if (retry ? retry.busy : !!job.nextAttemptAt && job.status !== "running") return "flex-busy";
  return job.status === "running" || job.status === "submitting" ? "flex" : null;
}

/** Jobs in a run that ended without an image: failed, canceled or interrupted. */
export const endedWithoutImage = (jobs: readonly Job[]) =>
  jobs.filter((job) => jobTileState(job, undefined) === "failed");

/**
 * A Batch run's job that hasn't gone to the company waits its turn in line, never "Generating":
 * nothing is being made until the batch is sent.
 */
export function jobTileState(
  job: Job,
  position: number | undefined,
  jobSet?: Pick<JobSet, "speed">,
): JobTileState {
  switch (job.status) {
    case "failed":
    case "canceled":
    case "interrupted":
      return "failed";
    case "queued":
      return "queued";
    case "pending":
      return position || jobSet?.speed === "batch" ? "queued" : "generating";
    default:
      return "generating";
  }
}

/**
 * The failed tile's button (§0.5): the one the server saved on the job when it isn't the code's
 * usual one (Try again on a Batch image or after Flex stayed busy), else the code's.
 */
export function failedAction(job: Pick<Job, "status" | "errorAction">, code: ErrorCode): ErrorAction {
  if (job.status === "interrupted") return "try-again";
  return job.errorAction ?? ERROR_PRIMARY_ACTION[code];
}

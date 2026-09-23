import type { BatchUpdated, JobSetWithJobs } from "@openfield/core";
import {
  activeProviderBatches,
  type Db,
  type JobSetBundle,
  jobsOf,
  markBatchNotified,
  providerBatchesForJobSets,
  unannouncedBatches,
} from "@openfield/db";
import { toBatchUpdated, toJobSetWithJobs } from "../mappers/job";

// Job sets as the browser sees them: a Batch run carries its provider batch (§8.3).

export function jobSetViews(db: Db, bundles: readonly JobSetBundle[]): JobSetWithJobs[] {
  const batchRuns = bundles.filter((b) => b.jobSet.speed === "batch").map((b) => b.jobSet.id);
  const batches = providerBatchesForJobSets(db, batchRuns);
  return bundles.map((b) => toJobSetWithJobs({ ...b, batch: batches.get(b.jobSet.id) }));
}

/** snapshot.batches: every batch in flight, plus finished ones no tab has heard about yet (§0.6). */
export function batchSnapshot(db: Db): BatchUpdated[] {
  const rows = [...activeProviderBatches(db), ...unannouncedBatches(db)];
  return rows.map((row) => toBatchUpdated(row, jobsOf(db, row.jobSetId)));
}

/** A tab got the snapshot, so each finished batch in it has now been announced once. */
export function markAnnounced(db: Db, batches: readonly BatchUpdated[]): void {
  const finished = new Set(batches.filter((b) => b.finished).map((b) => b.jobSetId));
  if (finished.size === 0) return;
  for (const row of unannouncedBatches(db)) {
    if (finished.has(row.jobSetId)) markBatchNotified(db, row.id);
  }
}

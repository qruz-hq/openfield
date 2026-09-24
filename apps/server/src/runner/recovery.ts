import { existsSync } from "node:fs";
import { isTerminalState } from "@openfield/core";
import {
  activeJobs,
  assetFiles,
  type Db,
  insertUsage,
  type JobRow,
  type JobSetRow,
  listJobSets,
  markJobResumed,
  providerBatchesForJobSets,
  refreshJobSetStatus,
  rerunJob,
  resendJob,
  restartPath,
  setFileStates,
  transitionJob,
} from "@openfield/db";
import { absolutePath, type HomePaths } from "../config/home";

// Crash recovery (§8.4.5), run at boot before the listener accepts traffic. Resume first, run again
// second, interrupt last (§0.4): a sent call the model declared resumable is picked up by its stored
// id (or, cut off before the id came back, asked for it again with the same idempotency key when the
// company honours it), one that couldn't resume is sent again once when the setting allows it, and
// the rest are interrupted. It decides from each row and the model's manifest, so it needs no
// network: the runner binds the model later, when it picks a call up or sends it. A Batch run lives
// at the company, so the batch watcher resumes it from its row instead.

export interface RecoveryReport {
  requeued: number;
  /**
   * Picked up where they left off: by the company's id, which the runner follows before sending
   * anything new, or by the same create sent again with the same key, which gets that id back.
   */
  resumed: number;
  /** Images of Batch runs still at the company, which the batch watcher picks up from their row. */
  batched: number;
  /**
   * Sent again, once, because their call couldn't resume. Counts a rerun a start that failed before
   * sending anything (its port was taken) left waiting, since this start is the one that sends it.
   */
  rerun: number;
  interrupted: number;
  jobSets: number;
  missingFiles: number;
}

const INTERRUPTED = "Openfield stopped while this image was being made";

export interface RecoveryOptions {
  rerunInterrupted: boolean;
  simulated?: boolean;
  /** Whether a model's create honours the idempotency key (the manifest's idempotentSubmit). */
  idempotentSubmit?: (modelKey: string) => boolean;
}

export function recover(db: Db, paths: HomePaths, opts: RecoveryOptions): RecoveryReport {
  const report: RecoveryReport = {
    requeued: 0,
    resumed: 0,
    batched: 0,
    rerun: 0,
    interrupted: 0,
    jobSets: 0,
    missingFiles: 0,
  };
  const interrupt = (job: JobRow, jobSet: JobSetRow) => {
    const moved = db.transaction((tx) => {
      const row = transitionJob(tx, job.id, "interrupted", { errorMessage: INTERRUPTED });
      // Every job interrupted here had been sent, so the company may bill it and there's no image:
      // a row at no known cost says so (§0.13). Cut off again while it ran again, two calls may be
      // billed, and the row says it ran again. The first call a rerun replaced wrote no row.
      if (row) {
        insertUsage(tx, {
          providerId: jobSet.providerId,
          modelId: jobSet.modelId,
          jobSetId: jobSet.id,
          jobId: row.id,
          batchIndex: row.idx,
          operation: jobSet.op,
          outcome: "failed",
          costUsd: 0,
          costSource: "unknown",
          speed: jobSet.speed,
          simulated: opts.simulated ?? false,
          rerun: row.rerunAt !== null,
        });
      }
      return row;
    });
    if (moved) report.interrupted++;
  };

  for (const { job, jobSet } of activeJobs(db, { skipBatch: true })) {
    const idempotentSubmit = opts.idempotentSubmit?.(`${jobSet.providerId}:${jobSet.modelId}`) ?? false;
    switch (restartPath(job, { rerunInterrupted: opts.rerunInterrupted, idempotentSubmit })) {
      case "requeue":
        if (job.status === "pending") {
          // A rerun no call has gone out for yet goes out now.
          if (job.rerunAt !== null && job.attempt === 0) report.rerun++;
          else report.requeued++;
          // "queued" with no provider id never left this computer, so it's safe to send. A retry
          // backoff keeps its next_attempt_at.
        } else if (transitionJob(db, job.id, "pending", {}, { from: ["queued"] })) {
          report.requeued++;
        }
        break;
      case "resume":
        if (markJobResumed(db, job.id)) report.resumed++;
        break;
      case "resend":
        if (resendJob(db, job.id)) report.resumed++;
        else interrupt(job, jobSet);
        break;
      case "rerun":
        // Refused for a resumable job or one that already ran again, so it can't loop.
        if (rerunJob(db, job.id)) report.rerun++;
        else interrupt(job, jobSet);
        break;
      case "interrupt":
        interrupt(job, jobSet);
        break;
      case null:
        break;
    }
  }

  // Batch runs: jobs still waiting to be sent stay pending, and jobs covered by a live provider
  // batch keep their state. A sent job with no live batch behind it can't be picked up again.
  const batchJobs = activeJobs(db).filter(({ jobSet }) => jobSet.speed === "batch");
  const live = providerBatchesForJobSets(db, [...new Set(batchJobs.map(({ jobSet }) => jobSet.id))]);
  for (const { job, jobSet } of batchJobs) {
    if (job.status === "pending") {
      report.requeued++;
      continue;
    }
    const batch = live.get(jobSet.id);
    if (batch && batch.finishedAt === null) {
      report.batched++;
      continue;
    }
    // Never run again: a batch is resumable, so the company may still have it (§0.4).
    interrupt(job, jobSet);
  }

  // Sets whose jobs all finished while the server was down, or that just lost their last job.
  for (let cursor: string | null = null; ; ) {
    const page = listJobSets(db, { status: "active", cursor, limit: 200 });
    for (const { jobSet } of page.items) {
      const after = refreshJobSetStatus(db, jobSet.id);
      if (after && isTerminalState(after.status)) report.jobSets++;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const missing: string[] = [];
  const found: string[] = [];
  for (const file of assetFiles(db)) {
    const exists = existsSync(absolutePath(paths, file.path));
    if (!exists && file.fileState === "ok") missing.push(file.id);
    if (exists && file.fileState === "missing") found.push(file.id);
  }
  setFileStates(db, missing, "missing");
  setFileStates(db, found, "ok");
  report.missingFiles = missing.length;
  return report;
}

import { existsSync } from "node:fs";
import { isTerminalState } from "@openfield/core";
import {
  activeJobs,
  assetFiles,
  type Db,
  listJobSets,
  providerBatchesForJobSets,
  refreshJobSetStatus,
  setFileStates,
  transitionJob,
} from "@openfield/db";
import { absolutePath, type HomePaths } from "../config/home";

// Crash recovery (§8.4.5), run at boot before the listener accepts traffic.
// No launch adapter can pick a sync call up again after a restart, so anything that was already
// sent becomes interrupted and is never sent again on its own: that could bill twice. A Batch run
// lives at the company, so the batch watcher resumes it from its row instead.

export interface RecoveryReport {
  requeued: number;
  interrupted: number;
  jobSets: number;
  missingFiles: number;
}

export function recover(db: Db, paths: HomePaths): RecoveryReport {
  const report: RecoveryReport = { requeued: 0, interrupted: 0, jobSets: 0, missingFiles: 0 };

  for (const { job } of activeJobs(db, { skipBatch: true })) {
    if (job.status === "pending") {
      report.requeued++;
      continue;
    }
    // "queued" with no provider id never left this computer, so it's safe to send.
    if (job.status === "queued" && !job.providerJobId) {
      if (transitionJob(db, job.id, "pending", {}, { from: ["queued"] })) report.requeued++;
      continue;
    }
    const moved = transitionJob(db, job.id, "interrupted", {
      errorMessage: "Openfield stopped while this image was being made",
    });
    if (moved) report.interrupted++;
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
    if (batch && batch.finishedAt === null) continue;
    const moved = transitionJob(db, job.id, "interrupted", {
      errorMessage: "Openfield stopped while this image was being made",
    });
    if (moved) report.interrupted++;
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

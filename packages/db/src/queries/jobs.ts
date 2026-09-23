import {
  ACTIVE_JOB_STATES,
  isTerminalState,
  type JobSetState,
  type JobState,
  jobIdempotencyKey,
} from "@openfield/core";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { AssetRow, JobRow, JobSetRow, NewJobRow, NewJobSetRow } from "../rows";
import { jobSets, jobs } from "../schema";
import { type Draft, nowIso, olderThan, type Page, type PageQuery, pageSize, toPage } from "./_util";
import { assetsForJobSets } from "./assets";

export interface JobSetBundle {
  jobSet: JobSetRow;
  /** In idx order. */
  jobs: JobRow[];
  /** Live assets made by this job set, so a job's asset can be found by assets.jobId. */
  assets: AssetRow[];
}

export type JobSetDraft = Draft<NewJobSetRow, "createdAt" | "batchSize">;
/** jobSetId comes from the set. The per-job idempotency key is derived from the set's (§0.2). */
export type JobDraft = Draft<Omit<NewJobRow, "jobSetId">, "createdAt" | "updatedAt" | "idempotencyKey">;

/** Job columns the runner may set with a transition or a progress update. */
export type JobPatch = Partial<
  Pick<
    NewJobRow,
    | "providerJobId"
    | "progress"
    | "seed"
    | "attempt"
    | "nextAttemptAt"
    | "errorCode"
    | "errorMessage"
    | "errorReason"
    | "errorAction"
    | "latencyMs"
    | "speedUsed"
  >
>;

export type JobSetPatch = Partial<
  Pick<
    NewJobSetRow,
    "status" | "costEstimateUsd" | "costActualUsd" | "errorCode" | "errorMessage" | "startedAt" | "finishedAt"
  >
>;

const STARTED_STATES: readonly JobState[] = ["submitting", "queued", "running"];

/**
 * Writes one job set and its N jobs in one transaction (§8.4.1). A repeated idempotency key
 * returns the existing set instead of creating a second one (§8.3.1).
 */
export function createJobSet(
  db: Executor,
  input: { jobSet: JobSetDraft; jobs: JobDraft[] },
): { jobSet: JobSetRow; jobs: JobRow[]; created: boolean } {
  const batchSize = input.jobSet.batchSize ?? input.jobs.length;
  if (batchSize !== input.jobs.length) {
    throw new RangeError(`batchSize ${batchSize} doesn't match ${input.jobs.length} jobs`);
  }
  return db.transaction((tx) => {
    const key = input.jobSet.idempotencyKey ?? null;
    if (key) {
      const existing = getJobSetByIdempotencyKey(tx, key);
      if (existing) return { jobSet: existing, jobs: jobsOf(tx, existing.id), created: false };
    }
    const at = input.jobSet.createdAt ?? nowIso();
    const jobSet = tx
      .insert(jobSets)
      .values({ ...input.jobSet, batchSize, createdAt: at })
      .returning()
      .get();
    const rows = tx
      .insert(jobs)
      .values(
        input.jobs.map((job) => ({
          ...job,
          jobSetId: jobSet.id,
          idempotencyKey: job.idempotencyKey ?? (key ? jobIdempotencyKey(key, job.idx) : null),
          createdAt: job.createdAt ?? at,
          updatedAt: job.updatedAt ?? at,
        })),
      )
      .returning()
      .all()
      .sort((a, b) => a.idx - b.idx);
    return { jobSet, jobs: rows, created: true };
  });
}

export function getJobSet(db: Executor, id: string): JobSetRow | undefined {
  return db.select().from(jobSets).where(eq(jobSets.id, id)).get();
}

export function getJobSetByIdempotencyKey(db: Executor, key: string): JobSetRow | undefined {
  return db.select().from(jobSets).where(eq(jobSets.idempotencyKey, key)).get();
}

export function getJob(db: Executor, id: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function jobsOf(db: Executor, jobSetId: string): JobRow[] {
  return db.select().from(jobs).where(eq(jobs.jobSetId, jobSetId)).orderBy(asc(jobs.idx)).all();
}

/** GET /api/job-sets/:id */
export function getJobSetBundle(db: Executor, id: string): JobSetBundle | undefined {
  const jobSet = getJobSet(db, id);
  return jobSet ? bundle(db, [jobSet])[0] : undefined;
}

/** GET /api/job-sets, newest first. "active" means not finished yet. */
export function listJobSets(
  db: Executor,
  q: PageQuery & { status?: "active" | "all" } = {},
): Page<JobSetBundle> {
  const limit = pageSize(q.limit);
  const sets = db
    .select()
    .from(jobSets)
    .where(
      and(
        q.status === "all" ? undefined : inArray(jobSets.status, [...ACTIVE_JOB_STATES]),
        olderThan(jobSets.createdAt, jobSets.id, q.cursor),
      ),
    )
    .orderBy(desc(jobSets.createdAt), desc(jobSets.id))
    .limit(limit + 1)
    .all();
  const page = toPage(sets, limit, (s) => s);
  return { items: bundle(db, page.items), nextCursor: page.nextCursor };
}

/** Every unfinished job set in scheduler order, for the SSE snapshot (§8.3.2). */
export function activeJobSets(db: Executor): JobSetBundle[] {
  const sets = db
    .select()
    .from(jobSets)
    .where(inArray(jobSets.status, [...ACTIVE_JOB_STATES]))
    .orderBy(desc(jobSets.priority), asc(jobSets.createdAt))
    .all();
  return bundle(db, sets);
}

/**
 * Every unfinished job with its set, in scheduler order: priority DESC, created_at, idx (§0.12).
 * The queue scan and crash recovery (§8.4.5) both start here. `skipBatch` leaves Batch runs to
 * the batch watcher, which owns them once their provider batch exists.
 */
export function activeJobs(
  db: Executor,
  opts: { skipBatch?: boolean } = {},
): { job: JobRow; jobSet: JobSetRow }[] {
  return db
    .select({ job: jobs, jobSet: jobSets })
    .from(jobs)
    .innerJoin(jobSets, eq(jobSets.id, jobs.jobSetId))
    .where(
      and(
        inArray(jobs.status, [...ACTIVE_JOB_STATES]),
        opts.skipBatch ? ne(jobSets.speed, "batch") : undefined,
      ),
    )
    .orderBy(desc(jobSets.priority), asc(jobSets.createdAt), asc(jobs.idx))
    .all();
}

/**
 * Moves a job to `to` only if it is still in one of `from` (default: any unfinished state), so
 * a late result can never overwrite a cancel (§0.12). Returns the row, or undefined if the job
 * had already moved on.
 */
export function transitionJob(
  db: Executor,
  id: string,
  to: JobState,
  patch: JobPatch = {},
  opts: { from?: readonly JobState[]; at?: string } = {},
): JobRow | undefined {
  return db
    .update(jobs)
    .set(transitionValues(to, patch, opts.at ?? nowIso()))
    .where(and(eq(jobs.id, id), inArray(jobs.status, [...(opts.from ?? ACTIVE_JOB_STATES)])))
    .returning()
    .get();
}

/** The same guarded move for every job in a set, e.g. cancel what hasn't started. */
export function transitionJobsInSet(
  db: Executor,
  jobSetId: string,
  to: JobState,
  opts: { from?: readonly JobState[]; at?: string; patch?: JobPatch } = {},
): JobRow[] {
  return db
    .update(jobs)
    .set(transitionValues(to, opts.patch ?? {}, opts.at ?? nowIso()))
    .where(and(eq(jobs.jobSetId, jobSetId), inArray(jobs.status, [...(opts.from ?? ACTIVE_JOB_STATES)])))
    .returning()
    .all();
}

function transitionValues(to: JobState, patch: JobPatch, at: string) {
  return {
    ...patch,
    status: to,
    updatedAt: at,
    ...(STARTED_STATES.includes(to) ? { startedAt: sql`coalesce(${jobs.startedAt}, ${at})` } : {}),
    // A retry goes back to pending, so an unfinished state clears finished_at.
    finishedAt: isTerminalState(to) ? at : null,
  };
}

/** Progress, provider ids and the like, without a state change. Ignored once the job is done. */
export function updateJob(db: Executor, id: string, patch: JobPatch, at = nowIso()): JobRow | undefined {
  return db
    .update(jobs)
    .set({ ...patch, updatedAt: at })
    .where(and(eq(jobs.id, id), inArray(jobs.status, [...ACTIVE_JOB_STATES])))
    .returning()
    .get();
}

export function updateJobSet(db: Executor, id: string, patch: JobSetPatch): JobSetRow | undefined {
  return db.update(jobSets).set(patch).where(eq(jobSets.id, id)).returning().get();
}

/**
 * A job set's state from its jobs (§0.4). Unfinished while any job is; then succeeded, partial
 * when only some succeeded, or the most telling of failed, interrupted and canceled.
 */
export function deriveJobSetStatus(states: readonly JobState[]): JobSetState {
  if (states.length === 0) return "pending";
  const has = (s: JobState) => states.includes(s);
  const unfinished = states.some((s) => !isTerminalState(s));
  if (unfinished) {
    if (has("running")) return "running";
    if (has("queued")) return "queued";
    if (has("submitting")) return "submitting";
    return states.every((s) => s === "pending") ? "pending" : "running";
  }
  const succeeded = states.filter((s) => s === "succeeded").length;
  if (succeeded === states.length) return "succeeded";
  if (succeeded > 0) return "partial";
  if (has("failed")) return "failed";
  if (has("interrupted")) return "interrupted";
  return "canceled";
}

/** Recomputes a set's status and timestamps from its jobs. Call after any job transition. */
export function refreshJobSetStatus(db: Executor, jobSetId: string, at = nowIso()): JobSetRow | undefined {
  const rows = db
    .select({ status: jobs.status, startedAt: jobs.startedAt })
    .from(jobs)
    .where(eq(jobs.jobSetId, jobSetId))
    .all();
  const status = deriveJobSetStatus(rows.map((r) => r.status));
  const started = rows
    .map((r) => r.startedAt)
    .filter((s): s is string => s !== null)
    .sort()[0];
  return db
    .update(jobSets)
    .set({
      status,
      ...(started ? { startedAt: sql`coalesce(${jobSets.startedAt}, ${started})` } : {}),
      finishedAt: isTerminalState(status) ? sql`coalesce(${jobSets.finishedAt}, ${at})` : null,
    })
    .where(eq(jobSets.id, jobSetId))
    .returning()
    .get();
}

function bundle(db: Executor, sets: JobSetRow[]): JobSetBundle[] {
  if (sets.length === 0) return [];
  const ids = sets.map((s) => s.id);
  const allJobs = db.select().from(jobs).where(inArray(jobs.jobSetId, ids)).orderBy(asc(jobs.idx)).all();
  const allAssets = assetsForJobSets(db, ids);
  return sets.map((jobSet) => ({
    jobSet,
    jobs: allJobs.filter((j) => j.jobSetId === jobSet.id),
    assets: allAssets.filter((a) => a.jobSetId === jobSet.id),
  }));
}

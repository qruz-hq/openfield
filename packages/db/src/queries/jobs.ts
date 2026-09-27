import {
  ACTIVE_JOB_STATES,
  isTerminalState,
  type JobHandle,
  type JobSetState,
  type JobState,
  jobIdempotencyKey,
} from "@openfield/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
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
    | "resumable"
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
 * The estimates of agent runs still going: not in the usage log yet, but spoken for, so an agent
 * can't pass its daily limit by starting many runs at once.
 */
export function pendingAgentEstimateUsd(db: Executor): number {
  const row = db
    .select({ usd: sql<number>`coalesce(sum(${jobSets.costEstimateUsd}), 0)` })
    .from(jobSets)
    .where(and(inArray(jobSets.status, [...ACTIVE_JOB_STATES]), isNotNull(jobSets.agent)))
    .get();
  return row?.usd ?? 0;
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

// Restarts (§0.4, §8.4.5)

/**
 * Stores a resumable call's handle the moment submit() returns, before the first poll (§6.7): the
 * whole handle, the company's id and the state it reported, for every job the call covers, in one
 * statement. Guarded like any transition, so a cancel that got there first stays canceled. Only for
 * jobs sent with `resumable: true`; a blocking call's handle is never stored.
 */
export function storeJobHandle(
  db: Executor,
  jobIds: readonly string[],
  handle: JobHandle,
  state: "queued" | "running" = "running",
  at = nowIso(),
): JobRow[] {
  if (jobIds.length === 0) return [];
  const patch: JobPatch = handle.providerRef ? { providerJobId: handle.providerRef } : {};
  return db
    .update(jobs)
    .set({ ...transitionValues(state, patch, at), handle })
    .where(and(inArray(jobs.id, [...jobIds]), inArray(jobs.status, [...STARTED_STATES])))
    .returning()
    .all();
}

/**
 * A resumable call canceled while its create call was out: the handle that came back is kept on the
 * canceled jobs until the company has been told to stop, so a cancel that doesn't get through before
 * a restart is still sent after it (canceledWithHandle).
 */
export function storeCanceledHandle(
  db: Executor,
  jobIds: readonly string[],
  handle: JobHandle,
  at = nowIso(),
): JobRow[] {
  if (jobIds.length === 0) return [];
  const patch: JobPatch = handle.providerRef ? { providerJobId: handle.providerRef } : {};
  return db
    .update(jobs)
    .set({ ...patch, handle, updatedAt: at })
    .where(and(inArray(jobs.id, [...jobIds]), eq(jobs.status, "canceled"), eq(jobs.resumable, true)))
    .returning()
    .all();
}

/** Which of these jobs ran again after a restart, for the images they made (§0.4). */
export function rerunJobIds(db: Executor, jobIds: readonly (string | null)[]): Set<string> {
  const ids = [...new Set(jobIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Set();
  const rows = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.id, ids), isNotNull(jobs.rerunAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** Marks a job picked up by id after a restart. Its state stays as it was (§0.4). */
export function markJobResumed(db: Executor, id: string, at = nowIso()): JobRow | undefined {
  return db
    .update(jobs)
    .set({ resumedAt: at, updatedAt: at })
    .where(and(eq(jobs.id, id), inArray(jobs.status, [...STARTED_STATES]), isNotNull(jobs.handle)))
    .returning()
    .get();
}

/**
 * Sends a job again after a restart (§8.4.5): back to pending with rerun_at set, attempt 0 and a
 * clean slate, keeping its idempotency key, seed and frozen request. Refuses a job that was
 * resumable, since its work may still be alive at the company, and one that already ran again, so
 * a crash loop can't bill without end. Undefined when the job isn't eligible.
 */
export function rerunJob(db: Executor, id: string, at = nowIso()): JobRow | undefined {
  return db
    .update(jobs)
    .set({
      status: "pending",
      rerunAt: at,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      nextAttemptAt: null,
      progress: null,
      providerJobId: null,
      handle: null,
      latencyMs: null,
      speedUsed: null,
      errorCode: null,
      errorMessage: null,
      errorReason: null,
      errorAction: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(jobs.id, id),
        inArray(jobs.status, [...STARTED_STATES]),
        eq(jobs.resumable, false),
        isNull(jobs.rerunAt),
      ),
    )
    .returning()
    .get();
}

/**
 * A resumable call whose create was cut off before the company's id came back, at a company that
 * honours the idempotency key: back to pending with resumed_at set, so the runner sends the same
 * create with the same key and gets the first call back instead of starting a second one (§0.4).
 * It keeps started_at, so its deadline still runs from the first send, and the attempt the cut-off
 * create spent. Undefined when the job isn't eligible.
 */
export function resendJob(db: Executor, id: string, at = nowIso()): JobRow | undefined {
  return db
    .update(jobs)
    .set({
      status: "pending",
      resumedAt: at,
      attempt: sql`max(${jobs.attempt} - 1, 0)`,
      nextAttemptAt: null,
      finishedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(jobs.id, id),
        inArray(jobs.status, [...STARTED_STATES]),
        eq(jobs.resumable, true),
        isNull(jobs.handle),
      ),
    )
    .returning()
    .get();
}

/** What recovery does with one non-Batch job after a restart (§8.4.5). */
export type RestartPath =
  /** Nothing left this computer: send it as it is. */
  | "requeue"
  /** Picked up by the company's id; nothing is sent again. */
  | "resume"
  /** Its create was cut off before the id came back: sent again with the same key to get it back. */
  | "resend"
  /** Sent again, once: its call couldn't resume. */
  | "rerun"
  /** Couldn't resume and won't run again. */
  | "interrupt";

/**
 * §8.4.5's table for one non-Batch job, from its row and whether its model's create honours the
 * idempotency key (`idempotentSubmit`, from the manifest), so recovery needs no network. Resume
 * first, run again second, interrupt last. Null for a finished job. Batch runs are the batch
 * watcher's and resume from their provider_batches row.
 */
export function restartPath(
  job: Pick<JobRow, "status" | "providerJobId" | "resumable" | "handle" | "rerunAt">,
  opts: { rerunInterrupted: boolean; idempotentSubmit?: boolean },
): RestartPath | null {
  if (isTerminalState(job.status)) return null;
  if (job.status === "pending") return "requeue";
  if (job.resumable && job.handle) return "resume";
  // Never left this computer.
  if (job.status === "queued" && !job.providerJobId) return "requeue";
  // Cut off before the company's id arrived: the company may still have it, so it never runs again
  // as a new call. The same create with the same key only asks for that id again.
  if (job.resumable) return opts.idempotentSubmit ? "resend" : "interrupt";
  return opts.rerunInterrupted && job.rerunAt === null ? "rerun" : "interrupt";
}

/**
 * Resumable calls canceled while nothing was following them (the company off or keyless, or before
 * a restart picked them up), whose cancel hasn't reached the company yet: a canceled job keeps its
 * handle until it has (§0.12). Not Batch runs, whose row carries their cancel.
 */
export function canceledWithHandle(db: Executor): { job: JobRow; jobSet: JobSetRow }[] {
  return db
    .select({ job: jobs, jobSet: jobSets })
    .from(jobs)
    .innerJoin(jobSets, eq(jobSets.id, jobs.jobSetId))
    .where(
      and(
        eq(jobs.status, "canceled"),
        eq(jobs.resumable, true),
        isNotNull(jobs.handle),
        ne(jobSets.speed, "batch"),
      ),
    )
    .all();
}

/** The company has stopped these canceled calls, or no longer has them: nothing is owed there. */
export function clearCanceledHandles(db: Executor, jobIds: readonly string[], at = nowIso()): void {
  if (jobIds.length === 0) return;
  db.update(jobs)
    .set({ handle: null, updatedAt: at })
    .where(and(inArray(jobs.id, [...jobIds]), eq(jobs.status, "canceled")))
    .run();
}

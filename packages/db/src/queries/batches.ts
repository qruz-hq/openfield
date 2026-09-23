import {
  ACTIVE_BATCH_STATES,
  ACTIVE_JOB_STATES,
  batchDisplayName,
  newId,
  type TERMINAL_BATCH_STATES,
} from "@openfield/core";
import type { BatchHandle } from "@openfield/core/schemas";
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { JobRow, JobSetRow, NewProviderBatchRow, ProviderBatchRow } from "../rows";
import { jobSets, jobs, providerBatches } from "../schema";
import { nowIso } from "./_util";

// Provider batches (§0.4, §8.4): one row per job set that runs at the Batch speed. The row is
// written before the create call and holds the company's id the moment it returns, so a restart
// resumes polling instead of sending the run again.

export type TerminalBatchState = (typeof TERMINAL_BATCH_STATES)[number];

export interface ProviderBatchDraft {
  jobSetId: string;
  providerId: string;
  modelId: string;
  itemCount: number;
  /** Last four characters of the key the run is sent with. */
  credentialHint?: string | null;
  id?: string;
  /** Defaults to "openfield-<jobSetId>". */
  displayName?: string;
  createdAt?: string;
}

/** Columns the watcher may change as a batch moves. */
export type ProviderBatchPatch = Partial<
  Pick<
    NewProviderBatchRow,
    | "remoteId"
    | "state"
    | "handle"
    | "submittedAt"
    | "expiresAt"
    | "lastPolledAt"
    | "nextPollAt"
    | "errorCode"
    | "errorMessage"
  >
>;

const active = () => inArray(providerBatches.state, [...ACTIVE_BATCH_STATES]);

/** Writes the row in state 'submitting', before the create call (§0.4). One per job set. */
export function createProviderBatch(db: Executor, draft: ProviderBatchDraft): ProviderBatchRow {
  const at = draft.createdAt ?? nowIso();
  return db
    .insert(providerBatches)
    .values({
      id: draft.id ?? newId(),
      jobSetId: draft.jobSetId,
      providerId: draft.providerId,
      modelId: draft.modelId,
      displayName: draft.displayName ?? batchDisplayName(draft.jobSetId),
      itemCount: draft.itemCount,
      credentialHint: draft.credentialHint ?? null,
      state: "submitting",
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
}

export function getProviderBatch(db: Executor, id: string): ProviderBatchRow | undefined {
  return db.select().from(providerBatches).where(eq(providerBatches.id, id)).get();
}

export function getProviderBatchForJobSet(db: Executor, jobSetId: string): ProviderBatchRow | undefined {
  return db.select().from(providerBatches).where(eq(providerBatches.jobSetId, jobSetId)).get();
}

/** Provider batches for several job sets at once, keyed by job set id. */
export function providerBatchesForJobSets(
  db: Executor,
  jobSetIds: readonly string[],
): Map<string, ProviderBatchRow> {
  if (jobSetIds.length === 0) return new Map();
  const rows = db
    .select()
    .from(providerBatches)
    .where(inArray(providerBatches.jobSetId, [...jobSetIds]))
    .all();
  return new Map(rows.map((r) => [r.jobSetId, r]));
}

export function updateProviderBatch(
  db: Executor,
  id: string,
  patch: ProviderBatchPatch,
  at = nowIso(),
): ProviderBatchRow | undefined {
  return db
    .update(providerBatches)
    .set({ ...patch, updatedAt: at })
    .where(eq(providerBatches.id, id))
    .returning()
    .get();
}

/**
 * The create call returned: store the company's id at once. The id is always kept, even when a
 * cancel landed while the call was in flight, so the run can still be stopped at the company.
 */
export function recordBatchSubmitted(
  db: Executor,
  id: string,
  handle: BatchHandle,
  opts: { nextPollAt: string; state?: "queued" | "running"; submittedAt?: string },
): ProviderBatchRow | undefined {
  const at = opts.submittedAt ?? nowIso();
  const state = opts.state ?? "queued";
  return db
    .update(providerBatches)
    .set({
      remoteId: handle.remoteId,
      handle,
      expiresAt: handle.expiresAt,
      submittedAt: sql`coalesce(${providerBatches.submittedAt}, ${at})`,
      state: sql`CASE WHEN ${providerBatches.state} = 'submitting' THEN ${state} ELSE ${providerBatches.state} END`,
      nextPollAt: opts.nextPollAt,
      updatedAt: at,
    })
    .where(eq(providerBatches.id, id))
    .returning()
    .get();
}

/** One poll's outcome for a batch still waiting. Finished rows are left alone. */
export function recordBatchPoll(
  db: Executor,
  id: string,
  poll: { state?: "queued" | "running"; nextPollAt: string | null; at?: string },
): ProviderBatchRow | undefined {
  const at = poll.at ?? nowIso();
  return db
    .update(providerBatches)
    .set({
      ...(poll.state && { state: poll.state }),
      lastPolledAt: at,
      nextPollAt: poll.nextPollAt,
      updatedAt: at,
    })
    .where(and(eq(providerBatches.id, id), active()))
    .returning()
    .get();
}

/**
 * The final state, once every item is harvested (§0.4), so a crash mid-harvest resumes it. Only
 * the first call counts; returns undefined when the row was already finished.
 */
export function finishProviderBatch(
  db: Executor,
  id: string,
  result: {
    state: TerminalBatchState;
    errorCode?: ProviderBatchRow["errorCode"];
    errorMessage?: string;
    at?: string;
  },
): ProviderBatchRow | undefined {
  const at = result.at ?? nowIso();
  return db
    .update(providerBatches)
    .set({
      state: result.state,
      finishedAt: at,
      lastPolledAt: at,
      nextPollAt: null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      updatedAt: at,
    })
    .where(and(eq(providerBatches.id, id), isNull(providerBatches.finishedAt)))
    .returning()
    .get();
}

/** Every batch still in flight, oldest first: the recovery pass polls each one at boot (§8.4.5). */
export function activeProviderBatches(db: Executor): ProviderBatchRow[] {
  return db.select().from(providerBatches).where(active()).orderBy(asc(providerBatches.createdAt)).all();
}

/** The watcher's tick: batches in flight whose next poll is due. */
export function dueProviderBatches(db: Executor, now = nowIso()): ProviderBatchRow[] {
  return db
    .select()
    .from(providerBatches)
    .where(and(active(), lte(providerBatches.nextPollAt, now)))
    .orderBy(asc(providerBatches.nextPollAt))
    .all();
}

export interface ResumableBatch {
  batch: ProviderBatchRow;
  jobSet: JobSetRow;
  /** Jobs still waiting on the company, in idx order. Their state stays as it is across a restart. */
  jobs: JobRow[];
}

/** Batches to resume after a restart, with their run and the jobs still waiting (§8.4.5). */
export function resumableBatches(db: Executor): ResumableBatch[] {
  const batches = activeProviderBatches(db);
  if (batches.length === 0) return [];
  const setIds = batches.map((b) => b.jobSetId);
  const sets = new Map(
    db
      .select()
      .from(jobSets)
      .where(inArray(jobSets.id, setIds))
      .all()
      .map((s) => [s.id, s]),
  );
  const waiting = db
    .select()
    .from(jobs)
    .where(and(inArray(jobs.jobSetId, setIds), inArray(jobs.status, [...ACTIVE_JOB_STATES])))
    .orderBy(asc(jobs.idx))
    .all();
  return batches.flatMap((batch) => {
    const jobSet = sets.get(batch.jobSetId);
    return jobSet ? [{ batch, jobSet, jobs: waiting.filter((j) => j.jobSetId === batch.jobSetId) }] : [];
  });
}

/** Finished runs whose notice no client has received yet, for the SSE snapshot (§0.6). */
export function unannouncedBatches(db: Executor): ProviderBatchRow[] {
  return db
    .select()
    .from(providerBatches)
    .where(and(isNotNull(providerBatches.finishedAt), isNull(providerBatches.notifiedAt)))
    .orderBy(asc(providerBatches.finishedAt))
    .all();
}

/** Stamps the finish notice as delivered. True only for the first caller, so each run notifies once. */
export function markBatchNotified(db: Executor, id: string, at = nowIso()): boolean {
  const row = db
    .update(providerBatches)
    .set({ notifiedAt: at, updatedAt: at })
    .where(
      and(
        eq(providerBatches.id, id),
        isNotNull(providerBatches.finishedAt),
        isNull(providerBatches.notifiedAt),
      ),
    )
    .returning({ id: providerBatches.id })
    .get();
  return row !== undefined;
}

/** Finished batches the company still holds: cleanup hasn't run (§8.4.5). */
export function uncleanedBatches(db: Executor): ProviderBatchRow[] {
  return db
    .select()
    .from(providerBatches)
    .where(
      and(
        isNotNull(providerBatches.finishedAt),
        isNotNull(providerBatches.remoteId),
        isNull(providerBatches.cleanedAt),
      ),
    )
    .orderBy(asc(providerBatches.finishedAt))
    .all();
}

export function markBatchCleaned(db: Executor, id: string, at = nowIso()): ProviderBatchRow | undefined {
  return db
    .update(providerBatches)
    .set({ cleanedAt: at, updatedAt: at })
    .where(eq(providerBatches.id, id))
    .returning()
    .get();
}

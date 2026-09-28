import { ACTIVE_JOB_STATES, type JobSource } from "@openfield/core/constants";
import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { NewUsageLogRow, UsageLogRow } from "../rows";
import { jobSets, usageLog } from "../schema";
import { type Draft, nowIso } from "./_util";

/**
 * One row per finished job, success, failure and cancel alike (§0.13). A failure is written
 * with cost 0 and cost_source 'unknown'; a cancel after submit at full estimate, discarded.
 * `speed` is the speed billed. In fake mode pass `simulated: true`: the cost is forced to 0.
 * A job that ran again after a restart passes `rerun: true`; the call it replaced writes no row. A
 * rerun cut off again writes one at recovery, failed at no known cost.
 */
export function insertUsage(db: Executor, row: Draft<NewUsageLogRow, "ts">): UsageLogRow {
  const simulated = row.simulated === true;
  return db
    .insert(usageLog)
    .values({ ...row, ts: row.ts ?? nowIso(), ...(simulated && { costUsd: 0 }) })
    .returning()
    .get();
}

export interface UsageRollupRow {
  day: string;
  providerId: string;
  modelId: string;
  runs: number;
  images: number;
  /** Spent on images you have. Failures never count. */
  usd: number;
  /** Canceled after submit: may be billed, no image to show for it. */
  usdDiscarded: number;
  /**
   * Images that ran again after a restart, whatever came of it: succeeded, failed, canceled, or cut
   * off again. The call each one replaced may be billed too.
   */
  reruns: number;
}

// Fake-mode rows count as runs and images but never toward a spend total (§0.13).
const cost = sql`CASE WHEN ${usageLog.simulated} = 1 THEN 0 ELSE coalesce(${usageLog.costUsd}, 0) END`;
const figures = {
  runs: sql<number>`sum(${usageLog.outcome} IN ('succeeded', 'canceled'))`,
  images: sql<number>`sum(${usageLog.outcome} = 'succeeded')`,
  usd: sql<number>`sum(CASE WHEN ${usageLog.outcome} = 'succeeded' THEN ${cost} ELSE 0 END)`,
  usdDiscarded: sql<number>`sum(CASE WHEN ${usageLog.discarded} = 1 THEN ${cost} ELSE 0 END)`,
  reruns: sql<number>`sum(${usageLog.rerun} = 1)`,
};
// A failed run costs nothing, but a failed rerun still counts as one: the call it replaced may be
// billed.
const counted = or(inArray(usageLog.outcome, ["succeeded", "canceled"]), eq(usageLog.rerun, true));

/**
 * The cost panel's rollup by day and model (§8.2.2). Fake-mode rows count as runs and images but
 * never toward any spend total (§0.13).
 */
export function usageRollup(db: Executor, q: { from: string; to?: string }): UsageRollupRow[] {
  const day = sql<string>`substr(${usageLog.ts}, 1, 10)`;
  return db
    .select({ day, providerId: usageLog.providerId, modelId: usageLog.modelId, ...figures })
    .from(usageLog)
    .where(and(gte(usageLog.ts, q.from), q.to ? lt(usageLog.ts, q.to) : undefined, counted))
    .groupBy(day, usageLog.providerId, usageLog.modelId)
    .orderBy(desc(day), desc(figures.usd))
    .all();
}

export interface UsageMinuteRow extends Omit<UsageRollupRow, "day"> {
  /** "2026-09-19T23:41", UTC. The caller moves it onto the viewer's clock. */
  minute: string;
  /** The resolution the run asked for, such as "2K". */
  resolution: string | null;
  quality: string | null;
  /** Where the run was started. Null only for a row whose job set is gone. */
  source: JobSource | null;
  /** Runs canceled after they were sent. */
  canceled: number;
  /** The agent app that asked for the run, or null when a person did. */
  agent: string | null;
}

/**
 * Settings > Spending's raw material (§6.9): the log summed per UTC minute and per everything the
 * chart can split by, so the server can put each minute on the viewer's own day without SQLite
 * knowing any time zone. Same rules as the rollup.
 */
export function usageMinutes(db: Executor, q: { from?: string; to?: string }): UsageMinuteRow[] {
  const minute = sql<string>`substr(${usageLog.ts}, 1, 16)`;
  const resolution = sql<string | null>`json_extract(${jobSets.requestJson}, '$.resolution')`;
  const quality = sql<
    string | null
  >`coalesce(${usageLog.quality}, json_extract(${jobSets.requestJson}, '$.quality'))`;
  return db
    .select({
      minute,
      providerId: usageLog.providerId,
      modelId: usageLog.modelId,
      resolution,
      quality,
      source: jobSets.source,
      agent: jobSets.agent,
      ...figures,
      canceled: sql<number>`sum(${usageLog.outcome} = 'canceled' AND ${usageLog.discarded} = 1)`,
    })
    .from(usageLog)
    .leftJoin(jobSets, eq(jobSets.id, usageLog.jobSetId))
    .where(
      and(q.from ? gte(usageLog.ts, q.from) : undefined, q.to ? lt(usageLog.ts, q.to) : undefined, counted),
    )
    .groupBy(
      minute,
      usageLog.providerId,
      usageLog.modelId,
      resolution,
      quality,
      jobSets.source,
      jobSets.agent,
    )
    .orderBy(minute)
    .all();
}

/** When the first run that counts was logged, or null when none has been. */
export function firstUsageAt(db: Executor): string | null {
  return (
    db
      .select({ at: sql<string | null>`min(${usageLog.ts})` })
      .from(usageLog)
      .where(counted)
      .get()?.at ?? null
  );
}

export interface AgentUsageRow {
  agent: string;
  images: number;
  /** Spent, canceled-after-submit included: it may be billed, so it counts toward the limit. */
  usd: number;
}

/**
 * What each agent app spent since `from`, for Settings > Agents and the agents' daily limit. Same
 * rules as the rollup, except that a canceled run's possible charge counts as spent.
 */
export function agentUsageSince(db: Executor, from: string): AgentUsageRow[] {
  return db
    .select({
      agent: sql<string>`${jobSets.agent}`,
      images: figures.images,
      usd: sql<number>`coalesce(sum(CASE WHEN ${usageLog.outcome} IN ('succeeded', 'canceled') THEN ${cost} ELSE 0 END), 0)`,
    })
    .from(usageLog)
    .innerJoin(jobSets, eq(jobSets.id, usageLog.jobSetId))
    .where(and(gte(usageLog.ts, from), isNotNull(jobSets.agent), counted))
    .groupBy(jobSets.agent)
    .all();
}

/**
 * What each of these canvas runs has spent since `from`, counting its job sets still going at their
 * estimate. The agents' daily limit holds a run's whole estimate while it runs, since its later
 * nodes haven't made their job sets yet, and takes whichever is more.
 */
export function canvasRunSpendSince(
  db: Executor,
  from: string,
  runIds: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>(runIds.map((id) => [id, 0]));
  if (!runIds.length) return out;
  const spent = db
    .select({
      runId: sql<string>`${jobSets.canvasRunId}`,
      usd: sql<number>`coalesce(sum(CASE WHEN ${usageLog.outcome} IN ('succeeded', 'canceled') THEN ${cost} ELSE 0 END), 0)`,
    })
    .from(usageLog)
    .innerJoin(jobSets, eq(jobSets.id, usageLog.jobSetId))
    .where(and(gte(usageLog.ts, from), inArray(jobSets.canvasRunId, [...runIds]), counted))
    .groupBy(jobSets.canvasRunId)
    .all();
  const pending = db
    .select({
      runId: sql<string>`${jobSets.canvasRunId}`,
      usd: sql<number>`coalesce(sum(${jobSets.costEstimateUsd}), 0)`,
    })
    .from(jobSets)
    .where(and(inArray(jobSets.canvasRunId, [...runIds]), inArray(jobSets.status, [...ACTIVE_JOB_STATES])))
    .groupBy(jobSets.canvasRunId)
    .all();
  for (const row of [...spent, ...pending]) out.set(row.runId, (out.get(row.runId) ?? 0) + row.usd);
  return out;
}

export interface CanvasSpendRow {
  images: number;
  /** Spent on the images it made, by the rollup's rules. */
  usd: number;
  /** Canceled after submit: may be billed, no image to show for it. */
  usdDiscarded: number;
}

/**
 * What one canvas's runs have cost so far, for the canvas's spend pill: the rollup's rules (the
 * figure the top nav's Spent today and Settings > Spending use), over the job sets its runs made.
 */
export function canvasSpend(db: Executor, canvasId: string): CanvasSpendRow {
  const row = db
    .select({ images: figures.images, usd: figures.usd, usdDiscarded: figures.usdDiscarded })
    .from(usageLog)
    .innerJoin(jobSets, eq(jobSets.id, usageLog.jobSetId))
    .where(and(eq(jobSets.canvasId, canvasId), counted))
    .get();
  return { images: row?.images ?? 0, usd: row?.usd ?? 0, usdDiscarded: row?.usdDiscarded ?? 0 };
}

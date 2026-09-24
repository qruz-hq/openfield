import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { NewUsageLogRow, UsageLogRow } from "../rows";
import { usageLog } from "../schema";
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

/**
 * The cost panel's rollup by day and model (§8.2.2). Fake-mode rows count as runs and images but
 * never toward any spend total (§0.13).
 */
export function usageRollup(db: Executor, q: { from: string; to?: string }): UsageRollupRow[] {
  const day = sql<string>`substr(${usageLog.ts}, 1, 10)`;
  const cost = sql`CASE WHEN ${usageLog.simulated} = 1 THEN 0 ELSE coalesce(${usageLog.costUsd}, 0) END`;
  const usd = sql<number>`sum(CASE WHEN ${usageLog.outcome} = 'succeeded' THEN ${cost} ELSE 0 END)`;
  return db
    .select({
      day,
      providerId: usageLog.providerId,
      modelId: usageLog.modelId,
      runs: sql<number>`sum(${usageLog.outcome} IN ('succeeded', 'canceled'))`,
      images: sql<number>`sum(${usageLog.outcome} = 'succeeded')`,
      usd,
      usdDiscarded: sql<number>`sum(CASE WHEN ${usageLog.discarded} = 1 THEN ${cost} ELSE 0 END)`,
      reruns: sql<number>`sum(${usageLog.rerun} = 1)`,
    })
    .from(usageLog)
    .where(
      and(
        gte(usageLog.ts, q.from),
        q.to ? lt(usageLog.ts, q.to) : undefined,
        // A failed run costs nothing, but a failed rerun still counts as one: the call it replaced
        // may be billed.
        or(inArray(usageLog.outcome, ["succeeded", "canceled"]), eq(usageLog.rerun, true)),
      ),
    )
    .groupBy(day, usageLog.providerId, usageLog.modelId)
    .orderBy(desc(day), desc(usd))
    .all();
}

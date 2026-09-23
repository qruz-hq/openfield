import { and, desc, gte, inArray, lt, sql } from "drizzle-orm";
import type { Executor } from "../client";
import type { NewUsageLogRow, UsageLogRow } from "../rows";
import { usageLog } from "../schema";
import { type Draft, nowIso } from "./_util";

/**
 * One row per finished job, success, failure and cancel alike (§0.13). A failure is written
 * with cost 0 and cost_source 'unknown'; a cancel after submit at full estimate, discarded.
 */
export function insertUsage(db: Executor, row: Draft<NewUsageLogRow, "ts">): UsageLogRow {
  return db
    .insert(usageLog)
    .values({ ...row, ts: row.ts ?? nowIso() })
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
}

/** The cost panel's rollup by day and model (§8.2.2). */
export function usageRollup(db: Executor, q: { from: string; to?: string }): UsageRollupRow[] {
  const day = sql<string>`substr(${usageLog.ts}, 1, 10)`;
  const usd = sql<number>`sum(CASE WHEN ${usageLog.outcome} = 'succeeded' THEN coalesce(${usageLog.costUsd}, 0) ELSE 0 END)`;
  return db
    .select({
      day,
      providerId: usageLog.providerId,
      modelId: usageLog.modelId,
      runs: sql<number>`count(*)`,
      images: sql<number>`sum(${usageLog.outcome} = 'succeeded')`,
      usd,
      usdDiscarded: sql<number>`sum(CASE WHEN ${usageLog.discarded} = 1 THEN coalesce(${usageLog.costUsd}, 0) ELSE 0 END)`,
    })
    .from(usageLog)
    .where(
      and(
        gte(usageLog.ts, q.from),
        q.to ? lt(usageLog.ts, q.to) : undefined,
        inArray(usageLog.outcome, ["succeeded", "canceled"]),
      ),
    )
    .groupBy(day, usageLog.providerId, usageLog.modelId)
    .orderBy(desc(day), desc(usd))
    .all();
}

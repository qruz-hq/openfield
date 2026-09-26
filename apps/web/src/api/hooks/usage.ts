import type { UsageGrouping, UsageStep } from "@openfield/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, call, queryKeys } from "../client";

/** Spend since local midnight, for the top nav pill. */
export function useSpentToday() {
  return useQuery({
    queryKey: queryKeys.usageToday,
    queryFn: () => {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return call(api.api.usage.$get({ query: { from: midnight.toISOString(), groupBy: "day" } }));
    },
    retry: false,
  });
}

/**
 * What this computer tracked as spent since the start of the month, canceled-but-charged work
 * included: the figure the monthly spending limit is checked against (§6.9).
 */
export async function fetchSpentThisMonth(): Promise<number> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const usage = await call(api.api.usage.$get({ query: { from: start.toISOString(), groupBy: "day" } }));
  return usage.totalUsd + usage.discardedUsd;
}

/** The same figure for Settings > Spending's This month. */
export function useSpentThisMonth() {
  return useQuery({ queryKey: queryKeys.usageMonth, queryFn: fetchSpentThisMonth });
}

export interface SeriesQuery {
  from?: string;
  to?: string;
  tz: string;
  step: UsageStep;
  groupBy: UsageGrouping;
}

/**
 * Settings > Spending's chart, tiles and table. While new dates load, the last answer stays on
 * screen, so nothing jumps. Null asks for nothing.
 */
export function useUsageSeries(query: SeriesQuery | null) {
  const params: Record<string, string> = {};
  if (query) {
    params.tz = query.tz;
    params.step = query.step;
    params.groupBy = query.groupBy;
    if (query.from) params.from = query.from;
    if (query.to) params.to = query.to;
  }
  return useQuery({
    queryKey: queryKeys.usageSeries(params),
    queryFn: () => call(api.api.usage.series.$get({ query: { ...query! } })),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

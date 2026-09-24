import { useQuery } from "@tanstack/react-query";
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

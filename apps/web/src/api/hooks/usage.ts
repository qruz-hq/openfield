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

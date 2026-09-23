import type { ModelListItem } from "@openfield/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

/** The registry with every manifest. It drives every chip in the composer (§3.5). */
export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: () => call(api.api.models.$get({ query: {} })),
    select: (data) => data.models.filter((m) => m.enabled),
    staleTime: 5 * 60_000,
  });
}

export const findModel = (models: readonly ModelListItem[] | undefined, key: string | null | undefined) =>
  key ? models?.find((m) => m.key === key) : undefined;

/** Settings > Models > Check now. */
export function useRefreshModels() {
  return useMutation({
    mutationFn: () => call(api.api.models.refresh.$post({ json: {} })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

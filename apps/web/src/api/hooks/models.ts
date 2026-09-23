import type { ModelListItem } from "@openfield/core";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

/** Every model, enabled or not, as GET /api/models sends it. Shared by hooks and event handlers. */
export const modelsQuery = queryOptions({
  queryKey: queryKeys.models,
  queryFn: () => call(api.api.models.$get({ query: {} })),
  staleTime: 5 * 60_000,
});

/** The registry with every manifest. It drives every chip in the composer (§3.5). */
export function useModels() {
  return useQuery({ ...modelsQuery, select: (data) => data.models.filter((m) => m.enabled) });
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

import type { ModelListItem } from "@openfield/core";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { asksForPrice, usePriceVersion } from "../../lib/remote-price";
import { api, call, queryClient, queryKeys } from "../client";

export type ModelModality = "image" | "video" | "all";

/**
 * Every model, enabled or not, as GET /api/models sends it. Shared by hooks and event handlers.
 * "image" (the default) is what every screen but the Video page and the canvas wants; the canvas
 * needs "all" to see both kinds of model at once (§0.16).
 */
export const modelsQuery = (modality: ModelModality = "image") =>
  queryOptions({
    queryKey: queryKeys.modelsList(modality),
    queryFn: () => call(api.api.models.$get({ query: { modality } })),
    staleTime: 5 * 60_000,
  });

/** The registry with every manifest. It drives every chip in the composer (§3.5). */
export function useModels(modality: ModelModality = "image") {
  const prices = usePriceVersion();
  const query = useQuery({
    ...modelsQuery(modality),
    select: (data) => data.models.filter((m) => m.enabled),
  });
  const data = useMemo(() => repriced(query.data, prices), [query.data, prices]);
  return { ...query, data };
}

/**
 * A price its company answered changes what a model costs, so a model priced per request comes
 * out as a new object each time one lands, and everything that prices it looks again.
 */
function repriced(models: ModelListItem[] | undefined, _version: number): ModelListItem[] | undefined {
  return models?.map((m) => (asksForPrice(m) ? { ...m } : m));
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

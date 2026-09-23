import {
  CONCURRENCY_CAP_FIELD,
  type ModelManifest,
  type ProviderSettingsResponse,
  type ProviderSettingValues,
  type SpeedId,
  speedName,
  t,
} from "@openfield/core";
import { queryOptions, useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { notifyError } from "../../lib/notify";
import { type RunSpeed, runSpeed } from "../../lib/provider-settings";
import { api, call, queryClient, queryKeys } from "../client";
import { useProviders } from "./keys";

// Each company's settings (§0.3): its own panels plus Openfield's Limits panel, with every
// field's current value. They work with or without a key, and each change saves at once.

const route = api.api.providers[":id"].settings;

const settingsQuery = (providerId: string) =>
  queryOptions({
    queryKey: queryKeys.providerSettings(providerId),
    queryFn: () => call(route.$get({ param: { id: providerId } })),
    staleTime: 5 * 60_000,
  });

export function useProviderSettings(providerId: string | undefined) {
  return useQuery({ ...settingsQuery(providerId ?? ""), enabled: !!providerId });
}

/** Every company's settings, keyed by company id. Prices everywhere follow each company's speed. */
export function useAllProviderSettings(): ReadonlyMap<string, ProviderSettingsResponse> {
  const providers = useProviders().data;
  const ids = useMemo(() => providers?.map((p) => p.id) ?? [], [providers]);
  // Stable, so the map only changes when a company's settings do.
  const combine = useCallback(
    (results: { data?: ProviderSettingsResponse }[]) =>
      new Map(results.flatMap((r, i) => (r.data ? [[ids[i]!, r.data] as const] : []))),
    [ids],
  );
  return useQueries({ queries: ids.map(settingsQuery), combine });
}

/** What a run of each model would run at right now. Standard until the settings arrive. */
export function useRunSpeed(): (model: ModelManifest) => RunSpeed {
  const all = useAllProviderSettings();
  return useCallback((model: ModelManifest) => runSpeed(all.get(model.providerId), model), [all]);
}

/** A speed by its company's own name ("Flex"), Openfield's until the settings arrive. */
export function useSpeedName(): (providerId: string, speed: SpeedId) => string {
  const all = useAllProviderSettings();
  return useCallback(
    (providerId: string, speed: SpeedId) => speedName(all.get(providerId)?.schema, speed),
    [all],
  );
}

/**
 * PATCH one or more fields. The change shows at once; a failed save puts the control back and
 * says so (§6.17). Callers pass `onSuccess` to `mutate` for the panel's quiet "Saved".
 */
export function useUpdateProviderSettings(providerId: string) {
  const key = queryKeys.providerSettings(providerId);
  return useMutation({
    mutationKey: key,
    mutationFn: (values: ProviderSettingValues) =>
      call(route.$patch({ param: { id: providerId }, json: { values } })),
    onMutate: async (values) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProviderSettingsResponse>(key);
      if (previous) {
        queryClient.setQueryData<ProviderSettingsResponse>(key, {
          ...previous,
          values: { ...previous.values, ...values },
        });
      }
      return { previous };
    },
    onError: (_error, _values, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      notifyError(t("providerSettings.saveFailed"));
    },
    onSuccess: (settings, values) => {
      // A later change still on its way wins over this answer.
      if (queryClient.isMutating({ mutationKey: key }) <= 1) queryClient.setQueryData(key, settings);
      if (CONCURRENCY_CAP_FIELD in values)
        void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    },
  });
}

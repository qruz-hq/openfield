import type { Settings, SettingsPatch } from "@openfield/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { notifyError } from "../../lib/notify";
import { api, call, queryClient, queryKeys } from "../client";
import { errorMessage } from "../raw";

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => call(api.api.settings.$get()),
  });
}

/**
 * Writes through PATCH /api/settings. The change shows at once, and if it fails it rolls back
 * with a toast saying so, wherever it was made.
 */
export function useUpdateSettings() {
  return useMutation({
    mutationFn: (patch: SettingsPatch) => call(api.api.settings.$patch({ json: patch })),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings });
      const previous = queryClient.getQueryData<Settings>(queryKeys.settings);
      if (previous) queryClient.setQueryData<Settings>(queryKeys.settings, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.settings, context.previous);
      notifyError(errorMessage(error));
    },
    onSuccess: (settings, patch) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      // The server leaves early companies' models off the list until this is on.
      if ("showExperimental" in patch) void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
}

/** The running version (Settings > Updates). One version for the server, the web app and the desktop app. */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => call(api.api.health.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Library size, free space, and whether thumbnails are on (Settings > Storage). */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: () => call(api.api.stats.$get()),
  });
}

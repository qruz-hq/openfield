import type { KeyTestBody } from "@openfield/core";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { api, call, queryClient, queryKeys } from "../client";

// Keys are write-only: the server answers with status and a four-character hint, never the key.

export function useKeys() {
  return useQuery({
    queryKey: queryKeys.keys,
    queryFn: () => call(api.api.settings.keys.$get()),
  });
}

/** Every company, with its name and key status. Shared by hooks and event handlers. */
export const providersQuery = queryOptions({
  queryKey: queryKeys.providers,
  queryFn: () => call(api.api.providers.$get()),
});

export function useProviders() {
  return useQuery(providersQuery);
}

/** Everything that changes when a key does: status, which models are ready, the default model. */
export function refreshAfterKeyChange() {
  for (const key of [queryKeys.keys, queryKeys.providers, queryKeys.models, queryKeys.settings]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

const keyRoute = api.api.settings.keys[":providerId"];

export function useRemoveKey() {
  return useMutation({
    mutationFn: (providerId: string) => call(keyRoute.$delete({ param: { providerId } })),
    onSettled: refreshAfterKeyChange,
  });
}

/**
 * Check key: one cheap authenticated call. With `values`, the server checks that key and saves it
 * only if it works. A failed check is a result, not an exception.
 */
export function useCheckKey() {
  return useMutation({
    mutationFn: ({ providerId, values = {} }: { providerId: string; values?: KeyTestBody }) =>
      call(keyRoute.test.$post({ param: { providerId }, json: values })),
    onSettled: refreshAfterKeyChange,
  });
}

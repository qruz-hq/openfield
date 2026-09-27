import type { AgentsStatus } from "@openfield/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { notifyError } from "../../lib/notify";
import { api, call, queryClient, queryKeys } from "../client";
import { errorMessage } from "../raw";

// Settings > Agents. The connected apps change as they come and go, so the pane checks again every
// ten seconds while it's open.

const REFRESH_MS = 10_000;

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => call(api.api.agents.$get()),
    refetchInterval: REFRESH_MS,
  });
}

const settle = (status: AgentsStatus) => queryClient.setQueryData(queryKeys.agents, status);

/** Turning agents on the first time makes the key; off ends every connection. */
export function useSetAgentsEnabled() {
  return useMutation({
    mutationFn: (enabled: boolean) => call(api.api.agents.$put({ json: { enabled } })),
    onSuccess: settle,
    onError: (error) => notifyError(errorMessage(error)),
  });
}

/** A new key: apps using the old one have to be set up again. */
export function useNewAgentKey() {
  return useMutation({
    mutationFn: () => call(api.api.agents.key.$post()),
    onSuccess: settle,
    onError: (error) => notifyError(errorMessage(error)),
  });
}

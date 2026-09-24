import { errorCopy } from "@openfield/core";
import type { AppType } from "@openfield/server/app-type";
import { QueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import { ApiError, toApiError } from "./raw";
import { sessionHeaders } from "./session";

// The typed client for JSON routes (§8.3.3). The type import is erased at build, so no server
// code reaches the browser bundle.
export const api = hc<AppType>("/", { headers: () => sessionHeaders() });

type Success<R> = R extends { ok: true; json(): Promise<infer T> } ? T : never;

/**
 * Await a typed-client call: the success body, typed by the server's route, or an ApiError
 * carrying its error code. A failed connection is ApiError("network").
 */
export async function call<R extends { ok: boolean; json(): Promise<unknown> }>(
  request: Promise<R>,
): Promise<Success<R>> {
  let res: R;
  try {
    res = await request;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "network", errorCopy("network").reason, true);
  }
  if (!res.ok) throw await toApiError(res as unknown as Response);
  return (await res.json()) as Success<R>;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Only retry what might work a second later; a rejected key won't.
      retry: (count, error) => error instanceof ApiError && error.retryable && count < 2,
    },
    mutations: { retry: false },
  },
});

/** Every cache key in one place, so event handlers and hooks can't drift apart. */
export const queryKeys = {
  settings: ["settings"] as const,
  keys: ["keys"] as const,
  providers: ["providers"] as const,
  providerSettings: (providerId: string) => ["providers", providerId, "settings"] as const,
  models: ["models"] as const,
  assets: (filter: "all" | "favourites") => ["assets", filter] as const,
  allAssets: ["assets"] as const,
  jobSets: ["job-sets"] as const,
  usageToday: ["usage", "today"] as const,
  stats: ["stats"] as const,
  canvases: ["canvases"] as const,
  canvas: (id: string) => ["canvases", id] as const,
  canvasVersions: (id: string) => ["canvases", id, "versions"] as const,
  canvasRuns: (id: string) => ["canvases", id, "runs"] as const,
  canvasTemplates: ["canvas-templates"] as const,
};

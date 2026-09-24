import { type CanvasCreateBody, type CanvasDetail, type CanvasSummary, errorCopy } from "@openfield/core";
import type { CanvasDocument } from "@openfield/core/canvas";
import { useMutation, useQuery } from "@tanstack/react-query";
import { notifyError } from "../../lib/notify";
import { api, call, queryClient, queryKeys } from "../client";
import { ApiError, errorMessage, toApiError } from "../raw";

// The canvas index (§7.3, §8.3): the list, templates, and the card actions. The editor loads and
// saves a canvas on its own (canvas-doc.ts); nothing here writes its copy at queryKeys.canvas(id),
// so the two never trade stale data. List changes invalidate with exact: true, since every canvas
// key starts with "canvases" and a prefix match would reload open editors too.

export type SketchGraph = Pick<CanvasDocument, "nodes" | "edges">;

const invalidateList = () => queryClient.invalidateQueries({ queryKey: queryKeys.canvases, exact: true });

function patchList(update: (list: CanvasSummary[]) => CanvasSummary[]) {
  queryClient.setQueryData<CanvasSummary[]>(queryKeys.canvases, (list) => (list ? update(list) : list));
}

/** Like call(), for replies that may have no body. */
async function send<R extends { ok: boolean }>(request: Promise<R>): Promise<void> {
  let res: R;
  try {
    res = await request;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "network", errorCopy("network").reason, true);
  }
  if (!res.ok) throw await toApiError(res as unknown as Response);
}

export function useCanvases() {
  return useQuery({
    queryKey: queryKeys.canvases,
    queryFn: ({ signal }) => call(api.api.canvases.$get({ query: {} }, { init: { signal } })),
    // The editor changes canvases behind this list's back; coming back to the index shows it.
    staleTime: 0,
  });
}

export function useCanvasTemplates() {
  return useQuery({
    queryKey: queryKeys.canvasTemplates,
    queryFn: ({ signal }) => call(api.api["canvas-templates"].$get(undefined, { init: { signal } })),
    staleTime: 5 * 60_000,
  });
}

/** One canvas, read straight from the server (for export). Not cached. */
export function fetchCanvas(id: string): Promise<CanvasDetail> {
  return call(api.api.canvases[":id"].$get({ param: { id } }));
}

/**
 * The nodes and edges of a canvas with no preview image yet, for the card's sketch. Keyed by the
 * edit time, so a changed canvas redraws and an unchanged one never loads twice.
 */
export function useCanvasSketch(summary: CanvasSummary, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.canvas(summary.id), "sketch", summary.updatedAt] as const,
    queryFn: async ({ signal }): Promise<SketchGraph> => {
      const { graph } = await call(
        api.api.canvases[":id"].$get({ param: { id: summary.id } }, { init: { signal } }),
      );
      return { nodes: graph.nodes, edges: graph.edges };
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** New canvas, from a template, or an imported file. Resolves to the new canvas. */
export function useCreateCanvas() {
  return useMutation({
    mutationFn: (body: CanvasCreateBody) => call(api.api.canvases.$post({ json: body })),
    onSuccess: () => void invalidateList(),
    onError: (error) => notifyError(errorMessage(error)),
  });
}

export function useDuplicateCanvas() {
  return useMutation({
    mutationFn: (id: string) => call(api.api.canvases[":id"].duplicate.$post({ param: { id } })),
    onSuccess: () => void invalidateList(),
    onError: (error) => notifyError(errorMessage(error)),
  });
}

/**
 * Rename from a card. The list carries each canvas's graphVersion, so this needs no load first. If
 * an open editor saved in between, the version moved: read the new one and ask once more.
 */
export function useRenameCanvas() {
  return useMutation({
    mutationFn: async ({ id, name, graphVersion }: { id: string; name: string; graphVersion: number }) => {
      const patch = (version: number) =>
        call(api.api.canvases[":id"].$patch({ param: { id }, json: { name, graphVersion: version } }));
      try {
        return await patch(graphVersion);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "conflict") throw error;
        const fresh = await fetchCanvas(id);
        return patch(fresh.graphVersion);
      }
    },
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.canvases, exact: true });
      const previous = queryClient.getQueryData<CanvasSummary[]>(queryKeys.canvases);
      patchList((list) => list.map((c) => (c.id === id ? { ...c, name } : c)));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.canvases, context.previous);
      notifyError(errorMessage(error));
    },
    onSuccess: ({ graphVersion, updatedAt }, { id }) =>
      patchList((list) => list.map((c) => (c.id === id ? { ...c, graphVersion, updatedAt } : c))),
    onSettled: () => void invalidateList(),
  });
}

/**
 * Delete (§7.3): the canvas, its versions and its card picture. The images it made stay in the
 * library. The card goes once the server agrees.
 */
export function useDeleteCanvas() {
  return useMutation({
    mutationFn: (id: string) => send(api.api.canvases[":id"].$delete({ param: { id } })),
    onError: (error) => notifyError(errorMessage(error)),
    onSuccess: (_data, id) => {
      patchList((list) => list.filter((c) => c.id !== id));
      queryClient.removeQueries({ queryKey: queryKeys.canvas(id) });
    },
    onSettled: () => void invalidateList(),
  });
}

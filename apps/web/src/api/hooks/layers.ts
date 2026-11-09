import type { Asset, JobSetAccepted, LayerStackResponse, LayersBody, StackEntry } from "@openfield/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, call } from "../client";
import { rawFetch, toApiError } from "../raw";
import { saveBlob } from "./library";

// Layer splits (§ layers): ask for one, read the stack a run made, and put it together into a new
// image or hand it out as files. A stack is named by the run that made it.

export const layerKeys = {
  stack: (runId: string) => ["layers", runId] as const,
};

/** GET /api/layers/:runId: the base first, then each layer from the bottom up. */
export const layerStackQuery = (runId: string) =>
  queryOptions({
    queryKey: layerKeys.stack(runId),
    queryFn: ({ signal }): Promise<LayerStackResponse> =>
      call(api.api.layers[":runId"].$get({ param: { runId } }, { init: { signal } })),
  });

export function useLayerStack(runId: string | null) {
  return useQuery({ ...layerStackQuery(runId ?? ""), enabled: runId !== null });
}

/** POST /api/layers: starts a split, answered like any run (202). */
export const separateLayers = (body: LayersBody): Promise<JobSetAccepted> =>
  call(api.api.layers.$post({ json: body }));

/** POST /api/layers/:runId/flatten: the visible entries, bottom first, as one new image. */
export async function flattenStack(runId: string, layers: readonly StackEntry[]): Promise<Asset> {
  const res = await call(
    api.api.layers[":runId"].flatten.$post({ param: { runId }, json: { layers: [...layers] } }),
  );
  return res.asset;
}

/** POST /api/layers/:runId/export: the visible entries as a zip of PNGs or a PSD, saved by its own name. */
export async function exportStack(
  runId: string,
  layers: readonly StackEntry[],
  format: "zip" | "psd",
): Promise<void> {
  const res = await rawFetch(`/api/layers/${encodeURIComponent(runId)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layers, format }),
  });
  if (!res.ok) throw await toApiError(res);
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") ?? "");
  saveBlob(await res.blob(), named?.[1] ? decodeURIComponent(named[1]) : `layers.${format}`);
}

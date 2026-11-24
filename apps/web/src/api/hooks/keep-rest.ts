import type {
  Asset,
  AssetListItem,
  KeepRestApplyBody,
  KeepRestApplyResponse,
  KeepRestAreaQuery,
  KeepRestSaveResponse,
  KeepRestState,
} from "@openfield/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, call, queryClient } from "../client";
import { rawFetch, toApiError } from "../raw";
import { patchAsset, prependAsset } from "./assets";
import { assetDetailQuery } from "./library";

// Keep the rest of the image, after the run (§0.9): an edit's stored model result laid over its
// original again with other settings, for free. The Edit tab and the canvas Edit node both read
// it from here. The POSTs take JSON, or a form when a fix layer goes with them, so they're sent by
// hand rather than through the typed client.

export const keepRestKeys = {
  all: ["keep-rest"] as const,
  state: (assetId: string) => ["keep-rest", assetId] as const,
};

export const keepRestQuery = (assetId: string) =>
  queryOptions({
    queryKey: keepRestKeys.state(assetId),
    queryFn: ({ signal }) =>
      call(api.api.assets[":id"]["keep-rest"].$get({ param: { id: assetId } }, { init: { signal } })),
  });

/** What can be adjusted on a finished edit, or why it can't. Null for none. */
export function useKeepRest(assetId: string | null) {
  return useQuery({ ...keepRestQuery(assetId ?? ""), enabled: assetId !== null });
}

/** The settings a preview or an Apply asks for; anything left out stays as stored. */
export type KeepRestSettings = Pick<KeepRestApplyBody, "keep" | "sensitivity" | "expandPx" | "featherPx">;

/**
 * The decided area for other settings than the stored ones, as the server would make it. The
 * route answers by ETag, so the same settings asked again cost nothing.
 */
export function keepRestAreaUrl(state: KeepRestState, settings: KeepRestAreaQuery): string | null {
  if (!state.areaUrl) return null;
  const url = new URL(state.areaUrl, "http://openfield.local");
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

/** JSON, or a form with the settings as JSON in "settings" and the fix layer in "fixes". */
function bodyOf(settings: Record<string, unknown>, fixes?: Blob): RequestInit {
  if (!fixes) {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    };
  }
  const form = new FormData();
  form.set("settings", JSON.stringify(settings));
  form.set("fixes", new File([fixes], "fixes.png", { type: "image/png" }));
  return { method: "POST", body: form };
}

async function post<T>(path: string, init: RequestInit): Promise<T> {
  const res = await rawFetch(path, init);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** An asset as the lists hold it: no deletedAt unless it's in the Trash. */
function listItem(asset: Asset): AssetListItem {
  const { deletedAt, ...rest } = asset;
  return deletedAt ? { ...rest, deletedAt } : rest;
}

/** The edit's details and every list it's in now show its new file. */
function showUpdated(asset: Asset) {
  patchAsset(listItem(asset));
  // The typed client's JSON shape of the same asset.
  queryClient.setQueryData(assetDetailQuery(asset.id).queryKey, (data) =>
    data ? { ...data, asset: asset as unknown as typeof data.asset } : data,
  );
}

/**
 * Apply: makes the kept version again with these settings and writes it over the edit in place.
 * `fixes` replaces the stored fix layer (an RGBA PNG at the original's size).
 */
export async function applyKeepRest(
  assetId: string,
  settings: KeepRestSettings,
  fixes?: Blob,
): Promise<KeepRestApplyResponse> {
  const out = await post<KeepRestApplyResponse>(`/api/assets/${assetId}/keep-rest`, bodyOf(settings, fixes));
  queryClient.setQueryData(keepRestKeys.state(assetId), out.state);
  showUpdated(out.asset);
  return out;
}

/**
 * Save as new image: the model's own result as an image of its own. A fix layer's "use the
 * original" strokes put the original back there first.
 */
export async function saveKeepRest(assetId: string, fixes?: Blob): Promise<KeepRestSaveResponse> {
  const out = await post<KeepRestSaveResponse>(`/api/assets/${assetId}/keep-rest/save`, bodyOf({}, fixes));
  if (!out.existing) prependAsset(listItem(out.asset));
  // The edit now points at the copy it was saved as.
  void queryClient.invalidateQueries({ queryKey: keepRestKeys.state(assetId) });
  return out;
}

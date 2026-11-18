import {
  assetSchema,
  type KeepRestApplyBody,
  type KeepRestApplyResponse,
  type KeepRestState,
  keepRestApplyResponseSchema,
  keepRestSaveResponseSchema,
} from "@openfield/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, call, queryClient } from "../../../api/client";
import { rawFetch, toApiError } from "../../../api/raw";
import { noteImageVersion } from "../shell/image-versions";

// Keep the rest after an Edit node ran, from the canvas (§0.9): what an image's edit can do now,
// and blending it again in place. The Edit tab has its own; this one serves the Edit node and its
// Touch up window.

export const keepRestKeys = {
  state: (assetId: string) => ["keep-rest", assetId] as const,
};

/** GET /api/assets/:id/keep-rest */
export const keepRestQuery = (assetId: string) =>
  queryOptions({
    queryKey: keepRestKeys.state(assetId),
    queryFn: ({ signal }): Promise<KeepRestState> =>
      call(api.api.assets[":id"]["keep-rest"].$get({ param: { id: assetId } }, { init: { signal } })),
    staleTime: 30_000,
  });

export function useKeepRestState(assetId: string | null) {
  return useQuery({ ...keepRestQuery(assetId ?? ""), enabled: assetId !== null });
}

/**
 * POST /api/assets/:id/keep-rest, for each image: made again with these settings, in place. The
 * answers' versions reach the canvas's thumbnails at once, before the event stream says so.
 */
export async function reblendImages(
  assetIds: readonly string[],
  body: KeepRestApplyBody,
  fixes?: Blob,
): Promise<KeepRestApplyResponse[]> {
  const out: KeepRestApplyResponse[] = [];
  // One at a time: each is a full-size blend on the server, and a refusal stops the rest.
  for (const id of assetIds) {
    const init: RequestInit = { method: "POST" };
    if (fixes) {
      const form = new FormData();
      form.set("settings", JSON.stringify(body));
      form.set("fixes", new File([fixes], "fixes.png", { type: "image/png" }));
      init.body = form;
    } else {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await rawFetch(`/api/assets/${id}/keep-rest`, init);
    if (!res.ok) throw await toApiError(res);
    const answer = keepRestApplyResponseSchema.parse(await res.json());
    noteImageVersion(answer.asset);
    queryClient.setQueryData(keepRestKeys.state(id), answer.state);
    out.push(answer);
  }
  return out;
}

/**
 * POST /api/assets/:id/keep-rest/save, for each image: the model's own result as an image of its
 * own (the same one again when it was saved already). With a fix layer, its "use the original"
 * strokes put the original back first. The saved images' ids, in order.
 */
export async function saveModelResults(assetIds: readonly string[], fixes?: Blob): Promise<string[]> {
  const out: string[] = [];
  for (const id of assetIds) {
    const init: RequestInit = { method: "POST" };
    if (fixes) {
      const form = new FormData();
      form.set("fixes", new File([fixes], "fixes.png", { type: "image/png" }));
      init.body = form;
    }
    const res = await rawFetch(`/api/assets/${id}/keep-rest/save`, init);
    if (!res.ok) throw await toApiError(res);
    out.push(keepRestSaveResponseSchema.parse(await res.json()).asset.id);
  }
  return out;
}

/**
 * The kept edit a saved model result came from (opParams.savedFrom), for a node whose result
 * doesn't say; the image itself when it isn't one.
 */
export async function keptEditOf(assetId: string): Promise<string> {
  const res = await rawFetch(`/api/assets/${assetId}`);
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as { asset: unknown };
  const from = assetSchema.parse(body.asset).opParams?.savedFrom;
  return typeof from === "string" ? from : assetId;
}

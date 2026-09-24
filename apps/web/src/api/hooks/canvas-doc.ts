import {
  type CanvasDetail,
  type CanvasPatchBody,
  type CanvasPreviewTheme,
  type CanvasVersionCreateBody,
  canvasConflictResponseSchema,
  canvasPatchResponseSchema,
} from "@openfield/core";
import { useQuery } from "@tanstack/react-query";
import type { SaveOutcome } from "../../canvas/editor/autosave";
import { api, call, queryClient, queryKeys } from "../client";
import { ApiError, rawFetch, toApiError } from "../raw";

// The open canvas: its document, autosave, versions, and the preview picture (§7.8, §8.3).

/** Loads a canvas when the editor opens it. Always fresh: another tab may have changed it. */
export function useCanvasDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.canvas(id),
    queryFn: ({ signal }) => call(api.api.canvases[":id"].$get({ param: { id } }, { init: { signal } })),
    staleTime: 0,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

/** Browsers cap all keepalive bodies in flight at 64 KiB together; this leaves room for others. */
const KEEPALIVE_LIMIT = 48 * 1024;

/**
 * One autosave. A 409 carries the server's copy for the "changed in another tab" banner; lost
 * connections and server hiccups come back as "retry" so autosave backs off and tries again; a
 * refusal that would only repeat (deleted, too big, not accepted) comes back as "failed".
 */
export async function patchCanvas(
  id: string,
  body: CanvasPatchBody,
  { keepalive }: { keepalive: boolean },
): Promise<SaveOutcome> {
  // Counted in bytes, not characters: text in many languages takes 3 bytes a character. A bigger
  // canvas goes as a normal request.
  const small = keepalive && new TextEncoder().encode(JSON.stringify(body)).length < KEEPALIVE_LIMIT;
  let res: Response;
  try {
    res = (await api.api.canvases[":id"].$patch(
      { param: { id }, json: body },
      { init: { keepalive: small } },
    )) as unknown as Response;
  } catch {
    return { kind: "retry" };
  }
  if (res.ok) {
    const saved = canvasPatchResponseSchema.parse(await res.json());
    return { kind: "saved", graphVersion: saved.graphVersion, updatedAt: saved.updatedAt };
  }
  if (res.status === 409) {
    const conflict = canvasConflictResponseSchema.safeParse(await res.json().catch(() => null));
    if (conflict.success) return { kind: "conflict", server: conflict.data.canvas };
  }
  if (res.status >= 500) return { kind: "retry" };
  // The session token may have been renewed; that's worth one more go.
  const error = await toApiError(res);
  if (error.retryable) return { kind: "retry" };
  if (res.status === 404) return { kind: "failed", failure: "deleted" };
  if (res.status === 413) return { kind: "failed", failure: "too_big" };
  return { kind: "failed", failure: "refused" };
}

export function useCanvasVersions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.canvasVersions(id),
    queryFn: ({ signal }) =>
      call(api.api.canvases[":id"].versions.$get({ param: { id } }, { init: { signal } })),
    enabled,
    staleTime: 0,
  });
}

export const fetchVersion = (id: string, vid: string) =>
  call(api.api.canvases[":id"].versions[":vid"].$get({ param: { id, vid } }));

export async function createVersion(id: string, body: CanvasVersionCreateBody) {
  const version = await call(api.api.canvases[":id"].versions.$post({ param: { id }, json: body }));
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvasVersions(id) });
  return version;
}

/** The server snapshots the current canvas first, so a restore is never lossy. */
export async function restoreVersion(id: string, vid: string): Promise<CanvasDetail> {
  const detail = await call(api.api.canvases[":id"].versions[":vid"].restore.$post({ param: { id, vid } }));
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvasVersions(id) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvases });
  return detail;
}

export async function duplicateCanvas(id: string): Promise<CanvasDetail> {
  const detail = await call(api.api.canvases[":id"].duplicate.$post({ param: { id } }));
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvases });
  return detail;
}

export async function deleteCanvas(id: string): Promise<void> {
  await call(api.api.canvases[":id"].$delete({ param: { id } }));
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvases });
}

/** The index card picture (M4-15) in one theme: a PNG of the graph, never an image in the library. */
export async function putCanvasPreview(id: string, png: Blob, theme: CanvasPreviewTheme): Promise<void> {
  const res = await rawFetch(`/api/canvases/${encodeURIComponent(id)}/preview?theme=${theme}`, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  if (!res.ok) throw await toApiError(res);
  void queryClient.invalidateQueries({ queryKey: queryKeys.canvases });
}

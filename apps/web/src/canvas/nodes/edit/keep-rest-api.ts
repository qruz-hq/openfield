import { assetSchema, type KeepRestApplyBody } from "@openfield/core";
import { queryClient } from "../../../api/client";
import {
  applyKeepRest,
  type KeepRestSettings,
  keepRestQuery,
  saveKeepRest,
} from "../../../api/hooks/keep-rest";
import { rawFetch, toApiError } from "../../../api/raw";
import { noteImageVersion } from "../shell/image-versions";

// What the canvas Edit node adds to the Edit tab's Keep the rest calls (api/hooks/keep-rest.ts):
// several images at once, their new file versions on the canvas's thumbnails at once, and the way
// back from a saved model result to the edit it came from.

/**
 * Each image made again with these settings, in place, one at a time: each is a full-size blend on
 * the server, and a refusal stops the rest. `fixes` is a new fix layer for all of them; "clear" in
 * the body drops the stored one.
 */
export async function reblendImages(
  assetIds: readonly string[],
  body: KeepRestApplyBody,
  fixes?: Blob,
): Promise<void> {
  for (const id of assetIds) {
    // The settings go as sent: the Edit tab's type leaves out mode and fixes, the route takes them.
    const out = await applyKeepRest(id, body as KeepRestSettings, fixes);
    noteImageVersion(out.asset);
  }
}

/**
 * The model's own result for each image, as an image of its own (the same one again when it was
 * saved already). Spots already fixed by hand go with it, the way the Edit tab saves it. The saved
 * images' ids, in order.
 */
export async function saveModelResults(assetIds: readonly string[], given?: Blob): Promise<string[]> {
  const out: string[] = [];
  for (const id of assetIds) {
    const fixes = given ?? (await storedFixes(id));
    out.push((await saveKeepRest(id, fixes)).asset.id);
  }
  return out;
}

/** The fix layer painted on an image's edit, when there is one. */
async function storedFixes(assetId: string): Promise<Blob | undefined> {
  const state = await queryClient.fetchQuery(keepRestQuery(assetId));
  if (!state.fixesUrl) return undefined;
  const res = await rawFetch(state.fixesUrl);
  if (!res.ok) throw await toApiError(res);
  return res.blob();
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

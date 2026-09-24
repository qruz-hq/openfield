import { rawFetch, toApiError } from "../../../api/raw";

// Saving a node's images from the canvas (§7.5 done state). /files needs the session header, so
// each image is fetched and handed to the browser as a file, named after the node.

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** "Storyboard panel 2.png", or "… 3.png" for the third of several. */
export function downloadName(base: string, index: number, count: number, mime: string): string {
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-").trim() || "image";
  const ext = EXTENSIONS[mime] ?? "png";
  return count > 1 ? `${safe} ${index + 1}.${ext}` : `${safe}.${ext}`;
}

export async function downloadAssets(assetIds: readonly string[], base: string): Promise<void> {
  for (const [i, assetId] of assetIds.entries()) {
    const res = await rawFetch(`/files/asset/${encodeURIComponent(assetId)}`);
    if (!res.ok) throw await toApiError(res);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName(base, i, assetIds.length, blob.type);
    document.body.append(link);
    link.click();
    link.remove();
    // The browser has the file once the click is handled; the URL can go on the next task.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

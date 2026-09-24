import { formatBytes, t, UPLOAD_EXTENSIONS, UPLOAD_MAX_BYTES, type UploadResponse } from "@openfield/core";
import { api, call } from "../client";
import { ApiError } from "../raw";

// POST /api/uploads (M1-07): one image per request. The server reads the type from the bytes,
// turns HEIC into PNG and hands back the library image (an existing one for identical bytes).

/** For <input type="file" accept>. */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.join(",");

export function uploadImage(file: File): Promise<UploadResponse> {
  // Checked here too: past the server's limit the request never reaches a route that could say why.
  if (file.size > UPLOAD_MAX_BYTES) {
    const size = formatBytes(UPLOAD_MAX_BYTES);
    return Promise.reject(
      new ApiError(
        413,
        "payload_too_large",
        `The file is ${file.size} bytes`,
        false,
        "file",
        t("uploads.tooLarge", { size }),
      ),
    );
  }
  return call(api.api.uploads.$post({ form: { file } }));
}

/**
 * Uploads in order, one at a time so the library keeps the order they were picked in. Returns the
 * images that made it and the files that didn't, with why.
 */
export async function uploadImages(
  files: readonly File[],
): Promise<{ assetIds: string[]; failed: { file: File; error: unknown }[] }> {
  const assetIds: string[] = [];
  const failed: { file: File; error: unknown }[] = [];
  for (const file of files) {
    try {
      assetIds.push((await uploadImage(file)).asset.id);
    } catch (error) {
      failed.push({ file, error });
    }
  }
  return { assetIds, failed };
}

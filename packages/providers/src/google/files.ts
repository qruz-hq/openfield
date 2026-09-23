import { type CallContext, ProviderError, redactError } from "../types";
import { API_BASE, API_HOST, UPLOAD_BASE } from "./capabilities";
import { mapError } from "./errors";
import { googleFetch } from "./http";
import type { FileRef } from "./map-request";

// The Files API, for batch requests over the 20 MB inline limit: each distinct reference is uploaded
// once and pointed at from every request. Google deletes uploads after 48 hours on its own.

export interface UploadedFile extends FileRef {
  /** "files/abc", what cleanup deletes. */
  name: string;
}

/** Resumable upload in two calls: start, then send the bytes and finalize. */
export async function uploadFile(
  ctx: CallContext,
  file: { bytes: Uint8Array<ArrayBuffer>; mimeType: string; displayName: string },
): Promise<UploadedFile> {
  const start = await googleFetch(ctx, `${UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(file.bytes.byteLength),
      "x-goog-upload-header-content-type": file.mimeType,
    },
    body: JSON.stringify({ file: { display_name: file.displayName } }),
  });
  if (!start.res.ok) throw redactError(await mapError(start.res, start.body), ctx.log);

  const uploadUrl = start.res.headers.get("x-goog-upload-url");
  // The upload address must stay on Google's API host, or the host allow-list would be moot.
  if (!uploadUrl || new URL(uploadUrl).host !== API_HOST) {
    throw new ProviderError("provider_error", {
      message: "Google didn't return an upload address on its own host",
    });
  }

  const sent = await googleFetch(ctx, uploadUrl, {
    method: "POST",
    headers: {
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: file.bytes,
  });
  if (!sent.res.ok) throw redactError(await mapError(sent.res, sent.body), ctx.log);

  const uploaded = (sent.body as { file?: { name?: string; uri?: string; mimeType?: string } } | undefined)
    ?.file;
  if (!uploaded?.name || !uploaded.uri) {
    throw new ProviderError("provider_error", { message: "Google's upload answer had no file name" });
  }
  return { name: uploaded.name, fileUri: uploaded.uri, mimeType: uploaded.mimeType ?? file.mimeType };
}

/** Best effort: a file already gone is fine. */
export async function deleteFile(ctx: CallContext, name: string): Promise<void> {
  const { res, body } = await googleFetch(ctx, `${API_BASE}/${name}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw redactError(await mapError(res, body), ctx.log);
}

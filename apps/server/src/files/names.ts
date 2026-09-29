import type { AssetRow } from "@openfield/db";

// File names for what leaves the library (§2.5, §4.4). Stored files are named by id; a person
// saving one gets a name that sorts by date and says what made it. Dates are this computer's
// local time, which is the person's own: the server runs on their machine.

type Named = Pick<AssetRow, "id" | "createdAt" | "modelId" | "kind" | "mime">;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

const pad = (n: number) => String(n).padStart(2, "0");
const extensionOf = (mime: string) => EXTENSIONS[mime] ?? (mime.split("/")[1]?.replace(/\W+/g, "") || "bin");
/** The ULID's random tail: enough to tell two images from the same minute apart. */
const shortId = (id: string) => id.slice(-6).toLowerCase();
const day = (at: Date) => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;

/** A single download: "openfield_20260924-1432_gemini-3-pro-image_7k2m9q.png", or ".mp4" for a video. */
export function downloadName(asset: Named): string {
  const at = new Date(asset.createdAt);
  const made = (asset.modelId ?? asset.kind).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return `openfield_${day(at)}-${pad(at.getHours())}${pad(at.getMinutes())}_${made || "image"}_${shortId(asset.id)}.${extensionOf(asset.mime)}`;
}

/** Inside a zip: "20260924-143205-7k2m9q.png", so the archive lists in the order they were made. */
export function zipEntryName(asset: Named): string {
  const at = new Date(asset.createdAt);
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${day(at)}-${time}-${shortId(asset.id)}.${extensionOf(asset.mime)}`;
}

/** The zip itself: "openfield-2026-09-24-12.zip" for 12 images. */
export function zipName(count: number, at = new Date()): string {
  return `openfield-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${count}.zip`;
}

/** An attachment header browsers and the web app's own parser both read. Names here are ASCII. */
export const attachment = (name: string) =>
  `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;

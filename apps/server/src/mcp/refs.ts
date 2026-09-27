import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { formatBytes, UPLOAD_MAX_BYTES } from "@openfield/core";
import { type AssetRow, getAsset } from "@openfield/db";
import { saveUpload } from "../files/upload";
import { Refusal, type ToolContext } from "./kit";

// An image an agent points at: an image already in the library (its id), a file on this computer
// (a full path), or a web address. Files and addresses come in as uploads, the same way a
// reference dropped on the composer does, so every check an upload gets applies here too.

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FETCH_TIMEOUT_MS = 30_000;

export const IMAGE_REF_HINT =
  "An image id from the library, a full path to an image file on this computer, or an http(s) address.";

export async function resolveImage(ctx: ToolContext, ref: string): Promise<AssetRow> {
  const value = ref.trim();
  if (ULID_RE.test(value)) {
    const row = getAsset(ctx.svc.db, value);
    if (!row) throw new Refusal(`There's no image with the id ${value} in the library.`);
    return row;
  }
  if (/^https?:\/\//i.test(value)) return upload(ctx, await download(value));
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (isAbsolute(path)) return upload(ctx, readFile(path));
  throw new Refusal(`"${value}" isn't an image Openfield can find. Use ${IMAGE_REF_HINT.toLowerCase()}`);
}

async function upload(ctx: ToolContext, file: Blob): Promise<AssetRow> {
  const saved = await saveUpload(ctx.svc, file);
  const row = getAsset(ctx.svc.db, saved.asset.id);
  if (!row) throw new Refusal("The image was saved but can't be found in the library. Try again.");
  return row;
}

function readFile(path: string): Blob {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Refusal(`There's no file at ${path}.`);
  return Bun.file(path);
}

async function download(url: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new Refusal(`Couldn't download ${url}. Check the address, or save the image and pass its path.`);
  }
  if (!res.ok) throw new Refusal(`Downloading ${url} failed (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > UPLOAD_MAX_BYTES) throw tooBig();
  // Read with a cap, so an address that never ends can't fill the disk.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > UPLOAD_MAX_BYTES) throw tooBig();
    chunks.push(chunk);
  }
  return new Blob(chunks as Uint8Array<ArrayBuffer>[]);
}

const tooBig = () => new Refusal(`That image is too large. The limit is ${formatBytes(UPLOAD_MAX_BYTES)}.`);

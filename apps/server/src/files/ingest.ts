import { mkdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newId } from "@openfield/core";
import { type Db, findLiveAssetBySha256, getAsset } from "@openfield/db";
import {
  type AssetSink,
  ProviderError,
  type StoredAsset,
  type WrittenAsset,
} from "@openfield/providers/server";
import { absolutePath, type HomePaths } from "../config/home";
import { EXTENSION, type Probed, probeImage } from "./probe";

// The one path every byte takes into the library (§8.5.1): stream to tmp/, hash on the way,
// probe the real type, dedupe on sha256, then an atomic rename into place. The row is written
// later, in the same transaction that marks the job succeeded. Originals are never re-encoded.

export interface StagedFile {
  assetId: string;
  /** Relative to the library root, forward slashes. */
  path: string;
  mime: Probed["mime"];
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  /** Identical bytes were already in the library, so this points at that file. */
  duplicate: boolean;
}

const STORED_TYPES = new Set<string>(["image/png", "image/jpeg", "image/webp"]);
const HEAD_BYTES = 256 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;

export class Ingest {
  constructor(
    private readonly paths: HomePaths,
    private readonly db: Db,
  ) {}

  /** Streams bytes into the library and returns what landed. `folder` is assets/ or uploads/. */
  async stage(
    stream: ReadableStream<Uint8Array>,
    opts: { folder?: "assets" | "uploads"; maxBytes?: number } = {},
  ): Promise<StagedFile> {
    const assetId = newId();
    const tmp = join(this.paths.tmp, `${assetId}.part`);
    const hasher = new Bun.CryptoHasher("sha256");
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let bytes = 0;
    const limit = opts.maxBytes ?? MAX_BYTES;

    // Private from the first byte, so an image doesn't rely on the folder's mode alone (§6.11).
    const file = await open(tmp, "wx", 0o600);
    try {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > limit)
          throw new ProviderError("payload_too_large", { message: `Image is over ${limit} bytes` });
        hasher.update(chunk);
        if (headBytes < HEAD_BYTES) {
          head.push(chunk);
          headBytes += chunk.byteLength;
        }
        await file.write(chunk);
      }
      await file.close();
    } catch (err) {
      await file.close().catch(() => {});
      rmSync(tmp, { force: true });
      throw diskError(err);
    }

    try {
      let probed = probeImage(Buffer.concat(head));
      // A JPEG with a large EXIF block keeps its size marker further in.
      if (!probed && headBytes >= HEAD_BYTES) probed = probeImage(await Bun.file(tmp).bytes());
      if (!probed || !STORED_TYPES.has(probed.mime) || !probed.width || !probed.height) {
        throw new ProviderError("provider_error", { message: "The file isn't a PNG, JPEG or WebP image" });
      }
      const sha256 = hasher.digest("hex");
      const base = { assetId, mime: probed.mime, width: probed.width, height: probed.height, bytes, sha256 };

      const existing = findLiveAssetBySha256(this.db, sha256);
      if (existing) {
        rmSync(tmp, { force: true });
        return { ...base, path: existing.path, duplicate: true };
      }

      const relative = `${opts.folder ?? "assets"}/${dayFolder(new Date())}/${assetId}.${EXTENSION[probed.mime]}`;
      const target = absolutePath(this.paths, relative);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(tmp, target);
      return { ...base, path: relative, duplicate: false };
    } catch (err) {
      rmSync(tmp, { force: true });
      throw diskError(err);
    }
  }

  /** Removes a staged file that never got a row. Shared files stay. */
  discard(file: StagedFile): void {
    if (!file.duplicate) rmSync(absolutePath(this.paths, file.path), { force: true });
  }

  /** A stored image's bytes, for a reference, an edit base or a mask (§0.9: ids, never paths). */
  async read(assetId: string): Promise<StoredAsset> {
    const row = getAsset(this.db, assetId);
    if (!row)
      throw new ProviderError("invalid_request", { message: `No image ${assetId}`, field: "references" });
    const bytes = await Bun.file(absolutePath(this.paths, row.path)).bytes();
    return { assetId, mimeType: row.mime, width: row.width, height: row.height, bytes };
  }

  /** The AssetSink for one provider call. It keeps what it staged for the runner to commit or discard. */
  sink(): AttemptSink {
    return new AttemptSink(this);
  }
}

export class AttemptSink implements AssetSink {
  readonly #staged = new Map<string, StagedFile>();
  #closed = false;

  constructor(private readonly ingest: Ingest) {}

  async write(stream: ReadableStream<Uint8Array>): Promise<WrittenAsset> {
    const file = await this.ingest.stage(stream);
    // The run already ended (timeout, cancel): a late image is dropped, never filed.
    if (this.#closed) {
      this.ingest.discard(file);
      throw new ProviderError("canceled", { message: "The run ended before this image arrived" });
    }
    this.#staged.set(file.assetId, file);
    return {
      assetId: file.assetId,
      width: file.width,
      height: file.height,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  }

  read(assetId: string): Promise<StoredAsset> {
    return this.ingest.read(assetId);
  }

  /** Hands a staged file to the caller, who now owns committing or discarding it. */
  take(assetId: string): StagedFile | undefined {
    const file = this.#staged.get(assetId);
    this.#staged.delete(assetId);
    return file;
  }

  /** Drops everything staged and anything that arrives later. */
  discardAll(): void {
    this.#closed = true;
    for (const file of this.#staged.values()) this.ingest.discard(file);
    this.#staged.clear();
  }
}

/** assets/2026/09/23: the day it was made, on this computer's calendar. */
function dayFolder(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

function diskError(err: unknown): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new ProviderError("disk_full", { message: "The disk is full", cause: err });
  }
  return err;
}

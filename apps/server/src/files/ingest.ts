import { mkdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newId } from "@openfield/core";
import { type Db, findLiveAssetBySha256, getAsset } from "@openfield/db";
import {
  type AssetSink,
  looksLikeVideo,
  ProviderError,
  type StoredAsset,
  type WrittenAsset,
} from "@openfield/providers/server";
import { absolutePath, type HomePaths } from "../config/home";
import {
  EXTENSION,
  type Probed,
  type ProbedVideo,
  probeImage,
  probeVideoFile,
  VIDEO_EXTENSION,
} from "./probe";

// The one path every byte takes into the library (§8.5.1): stream to tmp/, hash on the way,
// probe the real type, dedupe on sha256, then an atomic rename into place. The row is written
// later, in the same transaction that marks the job succeeded. Originals are never re-encoded.

export interface StagedFile {
  assetId: string;
  /** Relative to the library root, forward slashes. */
  path: string;
  mime: Probed["mime"] | ProbedVideo["mime"];
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  /** Identical bytes were already in the library, so this points at that file. */
  duplicate: boolean;
  /** Videos only, from the file's own headers. */
  durationMs?: number;
  hasAudio?: boolean;
}

const STORED_TYPES = new Set<string>(["image/png", "image/jpeg", "image/webp"]);
const HEAD_BYTES = 256 * 1024;
const MAX_BYTES = 200 * 1024 * 1024;
/** A 4K clip of half a minute runs to a few hundred MB; this leaves room without inviting abuse. */
const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export const isVideoMime = (mime: string): boolean => mime.startsWith("video/");

/** A poster that hasn't come out by then is stuck on the file; the video lands without one. */
const POSTER_TIMEOUT_MS = 30_000;

export interface IngestOptions {
  /**
   * The ffmpeg that takes a video's first frame for its poster. Default: the one on PATH, if any.
   * Null: never, so the company's own still is the poster.
   */
  ffmpeg?: string | null;
}

export class Ingest {
  readonly #ffmpeg: string | null;

  constructor(
    private readonly paths: HomePaths,
    private readonly db: Db,
    opts: IngestOptions = {},
  ) {
    this.#ffmpeg = opts.ffmpeg === undefined ? Bun.which("ffmpeg") : opts.ffmpeg;
  }

  /**
   * Streams bytes into the library and returns what landed. `folder` is assets/ or uploads/.
   * `video` also takes an MP4 or QuickTime video: only what a model made, never an upload.
   */
  async stage(
    stream: ReadableStream<Uint8Array>,
    opts: { folder?: "assets" | "uploads"; maxBytes?: number; video?: boolean } = {},
  ): Promise<StagedFile> {
    const assetId = newId();
    const tmp = join(this.paths.tmp, `${assetId}.part`);
    const hasher = new Bun.CryptoHasher("sha256");
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let bytes = 0;
    let limit = opts.maxBytes ?? MAX_BYTES;

    // Private from the first byte, so an image doesn't rely on the folder's mode alone (§6.11).
    const file = await open(tmp, "wx", 0o600);
    try {
      for await (const chunk of stream) {
        // The first bytes say whether it's a video, which may be bigger than any image.
        if (bytes === 0 && opts.video && looksLikeVideo(chunk)) limit = Math.max(limit, VIDEO_MAX_BYTES);
        bytes += chunk.byteLength;
        if (bytes > limit)
          throw new ProviderError("payload_too_large", { message: `The file is over ${limit} bytes` });
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
      const first = Buffer.concat(head);
      const video = opts.video && looksLikeVideo(first) ? await probeVideoFile(tmp) : null;
      let probed: Probed | ProbedVideo | null = video ?? probeImage(first);
      // A JPEG with a large EXIF block keeps its size marker further in.
      if (!probed && headBytes >= HEAD_BYTES) probed = probeImage(await Bun.file(tmp).bytes());
      if (!probed || !(video || STORED_TYPES.has(probed.mime)) || !probed.width || !probed.height) {
        throw new ProviderError("provider_error", {
          message: opts.video
            ? "The file isn't a PNG, JPEG or WebP image, or an MP4 or QuickTime video"
            : "The file isn't a PNG, JPEG or WebP image",
        });
      }
      const sha256 = hasher.digest("hex");
      const base = {
        assetId,
        mime: probed.mime,
        width: probed.width,
        height: probed.height,
        bytes,
        sha256,
        ...(video && { durationMs: video.durationMs, hasAudio: video.hasAudio }),
      };

      const existing = findLiveAssetBySha256(this.db, sha256);
      if (existing) {
        rmSync(tmp, { force: true });
        return { ...base, path: existing.path, duplicate: true };
      }

      const extension = video ? VIDEO_EXTENSION[video.mime] : EXTENSION[probed.mime as Probed["mime"]];
      const relative = `${opts.folder ?? "assets"}/${dayFolder(new Date())}/${assetId}.${extension}`;
      const target = absolutePath(this.paths, relative);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(tmp, target);
      return { ...base, path: relative, duplicate: false };
    } catch (err) {
      rmSync(tmp, { force: true });
      throw diskError(err);
    }
  }

  /**
   * A staged video's poster, a still the thumbnails are made from: its first frame when ffmpeg is
   * on this computer, else `still`, the frame the company sent with it (Seedance's last). Kept next
   * to the video as <id>.poster.<ext>. Returns its path, or null when there's neither. Takes
   * ownership of `still`: it's either kept as the poster or discarded.
   */
  async poster(video: StagedFile, still?: StagedFile): Promise<string | null> {
    // The same video again shares the first one's file, and its poster with it.
    if (video.duplicate) {
      const existing = findLiveAssetBySha256(this.db, video.sha256);
      if (existing?.posterPath) {
        if (still) this.discard(still);
        return existing.posterPath;
      }
    }
    const stem = video.duplicate
      ? `${video.path.replace(/\.[^./]+$/, "")}-${video.assetId}`
      : video.path.replace(/\.[^./]+$/, "");
    if (this.#ffmpeg) {
      const relative = `${stem}.poster.jpg`;
      if (await this.#firstFrame(absolutePath(this.paths, video.path), absolutePath(this.paths, relative))) {
        if (still) this.discard(still);
        return relative;
      }
    }
    if (!still) return null;
    const relative = `${stem}.poster.${EXTENSION[still.mime as Probed["mime"]] ?? "jpg"}`;
    try {
      const target = absolutePath(this.paths, relative);
      // A still identical to one already kept is copied, never moved out from under its owner.
      if (still.duplicate) await Bun.write(target, Bun.file(absolutePath(this.paths, still.path)));
      else renameSync(absolutePath(this.paths, still.path), target);
      return relative;
    } catch {
      this.discard(still);
      return null;
    }
  }

  /** ffmpeg's first frame of a video, as a JPEG at `target`. False when it couldn't. */
  async #firstFrame(source: string, target: string): Promise<boolean> {
    const tmp = join(this.paths.tmp, `${newId()}.jpg`);
    try {
      const proc = Bun.spawn(
        [this.#ffmpeg!, "-v", "error", "-nostdin", "-y", "-i", source, "-frames:v", "1", "-q:v", "3", tmp],
        // windowsHide: under the desktop app the server has no console, so Windows would flash one up.
        { stdout: "ignore", stderr: "ignore", windowsHide: true },
      );
      const timer = setTimeout(() => proc.kill(), POSTER_TIMEOUT_MS);
      const code = await proc.exited.finally(() => clearTimeout(timer));
      if (code !== 0 || Bun.file(tmp).size === 0) return false;
      renameSync(tmp, target);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Removes a file this library wrote that no row ended up naming, like an unused poster. */
  discardPath(relative: string): void {
    rmSync(absolutePath(this.paths, relative), { force: true });
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
    const file = await this.ingest.stage(stream, { video: true });
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
      ...(file.durationMs !== undefined && { durationMs: file.durationMs }),
      ...(file.hasAudio !== undefined && { hasAudio: file.hasAudio }),
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

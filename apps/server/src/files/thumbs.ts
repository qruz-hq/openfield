import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { newId, resolveThumbRung, type ThumbEngine, type ThumbRung, thumbCacheKey } from "@openfield/core";
import type SharpModule from "sharp";
import { absolutePath, type HomePaths } from "../config/home";
import type { Logger } from "../log/logger";

// Thumbnails (§0.10, §8.5.2): WebP from sharp, cached by content hash, made on first request.
// If sharp won't load, thumbnails are off and the original is served instead. No WASM fallback.

type Sharp = typeof SharpModule;

export type ThumbSize = { h: ThumbRung; dpr: 1 | 2 } | { p: number };

export interface ThumbSource {
  sha256: string;
  /** Relative to the library root. */
  path: string;
}

/**
 * What an asset's thumbnails are made from: the image itself, or a video's poster frame. Null for
 * a video without a poster, which has nothing to show yet.
 */
export function thumbSourceOf(asset: {
  sha256: string;
  path: string;
  mime: string;
  posterPath: string | null;
}): ThumbSource | null {
  if (!asset.mime.startsWith("video/")) return asset;
  return asset.posterPath ? { sha256: asset.sha256, path: asset.posterPath } : null;
}

/** The type of a still by its extension: what a poster or thumbnail source is served as. */
export function stillMime(path: string): string {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export type ThumbFile =
  | { kind: "thumb"; file: string; etag: string }
  /** Thumbnails are off or this one couldn't be made: send the original, uncached. */
  | { kind: "original"; file: string };

class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

export interface ThumbsOptions {
  paths: HomePaths;
  logger: Logger;
  /** WebP quality, from settings.thumbQuality. */
  quality: () => number;
  /** Skip sharp entirely, e.g. to test the fallback. */
  disabled?: boolean;
}

export class Thumbs {
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #slots = new Slots(Math.max(1, availableParallelism() - 2));

  private constructor(
    private readonly opts: ThumbsOptions,
    private readonly sharp: Sharp | null,
  ) {}

  /** Loads sharp once and proves it can encode WebP. A failure turns thumbnails off. */
  static async create(opts: ThumbsOptions): Promise<Thumbs> {
    if (opts.disabled) return new Thumbs(opts, null);
    try {
      const sharp = (await import("sharp")).default;
      await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } })
        .webp()
        .toBuffer();
      // One libvips thread per image; parallelism comes from the slots above.
      sharp.concurrency(1);
      return new Thumbs(opts, sharp);
    } catch (err) {
      opts.logger.warn("Thumbnails are off: sharp didn't load. The feed will show full-size images.", {
        error: err,
      });
      return new Thumbs(opts, null);
    }
  }

  get engine(): ThumbEngine {
    return this.sharp ? "sharp" : "originals";
  }

  /** Works out the rung from a request, rounding up so odd sizes can't grow the cache. */
  static sizeFor(q: {
    h?: number | undefined;
    dpr?: "1" | "2" | undefined;
    p?: string | undefined;
  }): ThumbSize {
    if (q.p) return { p: Number(q.p) };
    return { h: resolveThumbRung(q.h ?? 456), dpr: q.dpr === "2" ? 2 : 1 };
  }

  async get(source: ThumbSource, size: ThumbSize): Promise<ThumbFile> {
    const original = absolutePath(this.opts.paths, source.path);
    if (!this.sharp) return { kind: "original", file: original };

    const key = thumbCacheKey(source.sha256, size);
    const etag = `"${key.replace(/\.webp$/, "")}"`;
    const file = join(this.opts.paths.thumbs, source.sha256.slice(0, 2), key);
    if (existsSync(file)) return { kind: "thumb", file, etag };

    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#make(original, file, size).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    try {
      return { kind: "thumb", file: await pending, etag };
    } catch (err) {
      this.opts.logger.warn("Couldn't make a thumbnail, sending the original", {
        sha256: source.sha256,
        error: err,
      });
      return { kind: "original", file: original };
    }
  }

  /**
   * A small JPEG for an agent to look at, at most `edge` px on its long side, on white where the
   * image is transparent. Not cached: agents ask for few. Null when sharp is off or fails.
   */
  async jpeg(source: Pick<ThumbSource, "path">, edge: number): Promise<Uint8Array | null> {
    const sharp = this.sharp;
    if (!sharp) return null;
    const original = absolutePath(this.opts.paths, source.path);
    try {
      return await this.#slots.run(() =>
        sharp(original, { failOn: "none" })
          .rotate()
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 80 })
          .toBuffer(),
      );
    } catch (err) {
      this.opts.logger.warn("Couldn't make a preview for an agent", { path: source.path, error: err });
      return null;
    }
  }

  /** Makes the feed's thumbnail ahead of the first request (§8.5.1 step 5). */
  warm(source: ThumbSource, size: ThumbSize): void {
    if (this.sharp) void this.get(source, size).catch(() => {});
  }

  /** Waits for thumbnails being written, for shutdown and tests. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inflight.values()]);
  }

  #make(original: string, file: string, size: ThumbSize): Promise<string> {
    const sharp = this.sharp!;
    return this.#slots.run(async () => {
      if (existsSync(file)) return file;
      mkdirSync(dirname(file), { recursive: true });
      const box =
        "p" in size
          ? { width: size.p, height: size.p }
          : // dpr 2 doubles the height, capped at the original by withoutEnlargement.
            { height: size.h * size.dpr };
      const tmp = join(this.opts.paths.tmp, `${newId()}.webp`);
      try {
        await sharp(original, { failOn: "none" })
          .rotate()
          .resize({ ...box, fit: "inside", withoutEnlargement: true })
          .webp({ quality: this.opts.quality(), effort: 4 })
          .toFile(tmp);
        renameSync(tmp, file);
      } finally {
        rmSync(tmp, { force: true });
      }
      return file;
    });
  }
}

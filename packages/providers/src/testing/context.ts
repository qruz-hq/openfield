import { type CredentialValues, newId, type SettingValue, type SpeedId, sha256Hex } from "@openfield/core";
import { probeMp4 } from "../mp4";
import { redact } from "../redact";
import type { AssetSink, CallContext, FetchLike, RedactingLogger, StoredAsset, WrittenAsset } from "../types";
import { probeImage } from "./png";

// A CallContext for tests: an in-memory asset store, a logger that records redacted lines, and
// whatever fetch the test passes (usually createFakeFetch()).

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: unknown;
}

export interface RecordingLogger extends RedactingLogger {
  readonly lines: LogLine[];
}

export function createRecordingLogger(secrets: () => readonly string[]): RecordingLogger {
  const lines: LogLine[] = [];
  const record = (level: LogLine["level"]) => (msg: string, data?: unknown) => {
    lines.push({
      level,
      msg: redact(msg, secrets()),
      ...(data !== undefined && { data: redact(data, secrets()) }),
    });
  };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    scrub: (value) => redact(value, secrets()),
  };
}

type Kept = StoredAsset & { sha256: string; written: boolean; durationMs?: number; hasAudio?: boolean };

/** What the bytes are, like the real ingest path: a PNG, JPEG or WebP, or an MP4 or QuickTime video. */
function probe(
  bytes: Uint8Array,
): { mimeType: string; width: number; height: number; durationMs?: number; hasAudio?: boolean } | null {
  const image = probeImage(bytes);
  if (image) return image;
  const video = probeMp4(bytes);
  return video && { mimeType: video.mime, ...video };
}

export class MemoryAssetSink implements AssetSink {
  readonly assets = new Map<string, Kept>();

  /** Adds an asset to read back, like an upload. Returns its id. */
  async add(bytes: Uint8Array, mimeType?: string): Promise<string> {
    const probed = probeImage(bytes);
    const assetId = newId();
    this.assets.set(assetId, {
      assetId,
      mimeType: mimeType ?? probed?.mimeType ?? "application/octet-stream",
      width: probed?.width ?? 0,
      height: probed?.height ?? 0,
      bytes,
      sha256: await sha256Hex(bytes),
      written: false,
    });
    return assetId;
  }

  /** Assets an adapter wrote, in order. */
  get written(): Kept[] {
    return [...this.assets.values()].filter((a) => a.written);
  }

  async write(stream: ReadableStream<Uint8Array>, meta: { mimeType: string }): Promise<WrittenAsset> {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    // Like the real ingest path: trust the bytes, not the declared type.
    const probed = probe(bytes);
    const assetId = newId();
    const sha256 = await sha256Hex(bytes);
    const video =
      probed?.durationMs !== undefined
        ? { durationMs: probed.durationMs, hasAudio: probed.hasAudio ?? false }
        : undefined;
    const kept: Kept = {
      assetId,
      mimeType: probed?.mimeType ?? meta.mimeType,
      width: probed?.width ?? 0,
      height: probed?.height ?? 0,
      bytes,
      sha256,
      written: true,
      ...(video && { durationMs: video.durationMs, hasAudio: video.hasAudio }),
    };
    this.assets.set(assetId, kept);
    return {
      assetId,
      width: kept.width,
      height: kept.height,
      bytes: bytes.byteLength,
      sha256,
      ...(video && { durationMs: video.durationMs, hasAudio: video.hasAudio }),
    };
  }

  async read(assetId: string): Promise<StoredAsset> {
    const asset = this.assets.get(assetId);
    if (!asset) throw new Error(`No asset ${assetId}`);
    const { sha256: _, written: __, durationMs: ___, hasAudio: ____, ...stored } = asset;
    return stored;
  }
}

export interface TestContextOptions {
  fetch: FetchLike;
  credentials?: CredentialValues;
  signal?: AbortSignal;
  now?: () => number;
  assets?: MemoryAssetSink;
  /** The run's resolved company settings. Default: none. */
  settings?: Record<string, SettingValue>;
  /** Default: standard. */
  speed?: SpeedId;
}

export interface TestContext extends CallContext {
  assets: MemoryAssetSink;
  log: RecordingLogger;
}

export function createTestContext(opts: TestContextOptions): TestContext {
  const credentials = opts.credentials ?? {};
  return {
    credentials,
    fetch: opts.fetch,
    signal: opts.signal ?? new AbortController().signal,
    log: createRecordingLogger(() => Object.values(credentials)),
    now: opts.now ?? Date.now,
    assets: opts.assets ?? new MemoryAssetSink(),
    settings: opts.settings ?? {},
    speed: opts.speed ?? "standard",
  };
}

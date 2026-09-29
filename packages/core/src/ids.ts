import { decodeTime, isValid, monotonicFactory } from "ulid";
import { DETAIL_PREVIEW_EDGE, THUMB_RUNGS, type ThumbRung } from "./constants";

// Row ids are ULIDs (§0.2). Monotonic, so ids minted in the same millisecond still sort.
const nextUlid = monotonicFactory();

export const newId = (): string => nextUlid();
export const isUlid = (value: string): boolean => isValid(value);
/** Milliseconds since epoch encoded in a ULID. */
export const ulidTime = (id: string): number => decodeTime(id);

export type ProviderId = string;
export type ModelKey = `${ProviderId}:${string}`;

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Model ids may contain colons (a pinned version, say), so a key splits at its first colon.
export const MODEL_ID_RE = /^\S{1,200}$/;

export const isProviderId = (value: string): boolean => PROVIDER_ID_RE.test(value);

export function formatModelKey(providerId: string, modelId: string): ModelKey {
  if (!PROVIDER_ID_RE.test(providerId)) throw new TypeError(`Invalid provider id "${providerId}"`);
  if (!MODEL_ID_RE.test(modelId)) throw new TypeError(`Invalid model id "${modelId}"`);
  return `${providerId}:${modelId}`;
}

export function safeParseModelKey(key: string): { providerId: string; modelId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const providerId = key.slice(0, at);
  const modelId = key.slice(at + 1);
  if (!PROVIDER_ID_RE.test(providerId) || !MODEL_ID_RE.test(modelId)) return null;
  return { providerId, modelId };
}

export function parseModelKey(key: string): { providerId: string; modelId: string } {
  const parsed = safeParseModelKey(key);
  if (!parsed) throw new TypeError(`Invalid model key "${key}". Expected "<providerId>:<modelId>".`);
  return parsed;
}

export const isModelKey = (value: string): value is ModelKey => safeParseModelKey(value) !== null;

/** Per-attempt provider idempotency key, stable across retries (§0.2). */
export const jobIdempotencyKey = (jobSetKey: string, jobIdx: number): string => `${jobSetKey}:${jobIdx}`;

/** The name a job set's provider batch goes by, so batch.find() can recover a lost create (§0.4). */
export const batchDisplayName = (jobSetId: string): string => `openfield-${jobSetId}`;

/** assets.op_params.source for canvas output; drives "Open in Canvas". */
export const canvasSource = (canvasId: string, nodeId: string): string => `canvas:${canvasId}:${nodeId}`;

export function parseCanvasSource(source: string): { canvasId: string; nodeId: string } | null {
  const match = /^canvas:([^:]+):(.+)$/.exec(source);
  return match ? { canvasId: match[1]!, nodeId: match[2]! } : null;
}

// Thumbnails (§0.10)

/** Nearest-or-larger rung, so arbitrary heights can't grow the cache. */
export function resolveThumbRung(height: number): ThumbRung {
  return THUMB_RUNGS.find((rung) => rung >= height) ?? THUMB_RUNGS[THUMB_RUNGS.length - 1]!;
}

/** `<sha256>@h<rung>[@2x].webp`, or `<sha256>@p1440.webp` for the detail preview. */
export function thumbCacheKey(sha256: string, size: { h: ThumbRung; dpr?: 1 | 2 } | { p: number }): string {
  if ("p" in size) return `${sha256}@p${size.p}.webp`;
  return `${sha256}@h${size.h}${size.dpr === 2 ? "@2x" : ""}.webp`;
}

export const assetFileUrl = (assetId: string): string => `/files/asset/${assetId}`;
/** A video's poster frame at full size. */
export const assetPosterUrl = (assetId: string): string => `/files/poster/${assetId}`;

export function assetThumbUrl(assetId: string, size: { h: number; dpr?: 1 | 2 } | "preview"): string {
  if (size === "preview") return `/files/thumb/${assetId}?p=${DETAIL_PREVIEW_EDGE}`;
  const dpr = size.dpr === 2 ? "&dpr=2" : "";
  return `/files/thumb/${assetId}?h=${resolveThumbRung(size.h)}${dpr}`;
}

// Keyset cursor: base64url("<created_at>|<id>") (§8.2.2). Both halves are ASCII.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(ascii: string): string {
  let out = "";
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : -1;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : -1;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    if (b >= 0) out += B64[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    if (c >= 0) out += B64[c & 63];
  }
  return out;
}

function fromBase64Url(input: string): string | null {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = B64.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

export function encodeCursor(createdAt: string, id: string): string {
  return toBase64Url(`${createdAt}|${id}`);
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const raw = fromBase64Url(cursor);
  if (!raw) return null;
  const bar = raw.indexOf("|");
  if (bar <= 0 || bar === raw.length - 1) return null;
  return { createdAt: raw.slice(0, bar), id: raw.slice(bar + 1) };
}

// The §6.11 redaction chain: drop auth headers, hide any loaded key, then regex-scrub common key
// shapes as a second net. Returns a plain-data copy; the input is never changed.

export const HIDDEN = "[hidden]";

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-goog-api-key",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

// Google keys start with AIza, or AQ. for the newer auth keys AI Studio makes by default (§6.11).
const KEY_SHAPES = [/sk-[A-Za-z0-9_-]{16,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /AQ\.[0-9A-Za-z_-]{20,}/g];

/** `shapes: false` skips the regex net, for data that must keep working once saved, like a handle. */
export function redact<T>(value: T, secrets: readonly string[] = [], opts: { shapes?: boolean } = {}): T {
  // Longest first, so a key that contains another is hidden whole. Short strings would hide
  // ordinary words, so anything under 8 characters is left to the regex net.
  const known = [...new Set(secrets.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length);
  const seen = new WeakSet<object>();

  const scrubText = (text: string): string => {
    let out = text;
    for (const secret of known) out = out.split(secret).join(HIDDEN);
    if (opts.shapes !== false) for (const shape of KEY_SHAPES) out = out.replace(shape, HIDDEN);
    return out;
  };

  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return scrubText(input);
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);

    if (input instanceof Headers) {
      const out: Record<string, string> = {};
      input.forEach((v, k) => {
        out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? HIDDEN : scrubText(v);
      });
      return out;
    }
    if (ArrayBuffer.isView(input)) return `[${input.byteLength} bytes]`;
    if (input instanceof Error) {
      const extra = walk({ ...input }) as Record<string, unknown>;
      return { ...extra, name: input.name, message: scrubText(input.message) };
    }
    if (Array.isArray(input)) return input.map(walk);

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(input)) {
      out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? HIDDEN : walk(v);
    }
    return out;
  };

  return walk(value) as T;
}

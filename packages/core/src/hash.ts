// Canonical JSON + SHA-256 (§0.11). The browser and the server must compute the same hash for
// the same value, so this sticks to JSON semantics with sorted keys and uses Web Crypto.

interface WebCrypto {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}
interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

// Typed locally so core needs neither DOM nor Bun type definitions.
const runtime = globalThis as unknown as {
  crypto: WebCrypto;
  TextEncoder: new () => Utf8Encoder;
};

/**
 * JSON.stringify with object keys sorted by UTF-16 code unit (as RFC 8785 does) and no
 * whitespace. Non-finite numbers, bigints and cycles throw instead of hashing to something
 * ambiguous. Strings are hashed as given: no Unicode normalization, since the text sent to a
 * model is exactly what should be fingerprinted.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();

  const encode = (input: unknown, inArray: boolean): string | undefined => {
    let v = input;
    if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
      v = (v as { toJSON: () => unknown }).toJSON();
    }
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new TypeError(`Can't hash a non-finite number (${v})`);
        return JSON.stringify(v);
      case "bigint":
        throw new TypeError("Can't hash a bigint");
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? "null" : undefined;
    }
    if (v === null) return "null";

    const obj = v as object;
    if (seen.has(obj)) throw new TypeError("Can't hash a value with a cycle");
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((item) => encode(item, true)).join(",")}]`;
    } else {
      const record = obj as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const encoded = encode(record[key], false);
        if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      out = `{${parts.join(",")}}`;
    }
    seen.delete(obj);
    return out;
  };

  const result = encode(value, false);
  if (result === undefined) throw new TypeError(`Can't hash a value of type ${typeof value}`);
  return result;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new runtime.TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await runtime.crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += HEX[byte];
  return hex;
}

export const HASH_PREFIX = "sha256:";
export const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<hex>` of the canonical JSON. Used for paramsHash and canvas fingerprints. */
export async function hashCanonical(value: unknown): Promise<string> {
  return HASH_PREFIX + (await sha256Hex(canonicalJson(value)));
}

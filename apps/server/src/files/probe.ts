// Real type and pixel size from the first bytes of a file. The declared type is never trusted
// (§8.5.1). Covers what Openfield stores: PNG, JPEG, WebP, and HEIC uploads (type only).

export interface Probed {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/heic";
  /** 0 when the header doesn't say (HEIC). */
  width: number;
  height: number;
}

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function probeImage(bytes: Uint8Array): Probed | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes, view);

  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8 ") {
      return {
        mime: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
      const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
      return { mime: "image/webp", width, height };
    }
    return null;
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 4))) {
    return { mime: "image/heic", width: 0, height: 0 };
  }
  return null;
}

function probeJpeg(bytes: Uint8Array, view: DataView): Probed | null {
  let pos = 2;
  while (pos + 3 < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1]!;
    // Fill bytes and markers without a length segment.
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const length = view.getUint16(pos + 2);
    // Start-of-frame markers carry the size; C4, C8 and CC are other tables.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && pos + 8 < bytes.length) {
      return { mime: "image/jpeg", width: view.getUint16(pos + 7), height: view.getUint16(pos + 5) };
    }
    pos += 2 + length;
  }
  return null;
}

export const EXTENSION: Record<Probed["mime"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

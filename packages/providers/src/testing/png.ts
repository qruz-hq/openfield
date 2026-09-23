// A tiny PNG encoder and reader for fake responses and tests. RGB, 8 bits, one IDAT.
// Deflate comes from CompressionStream when the runtime has it, else stored (uncompressed) blocks.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream with stored blocks: valid everywhere, just not small. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let pos = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = data.subarray(i * 65535, (i + 1) * 65535);
    out[pos++] = i === blocks - 1 ? 1 : 0;
    view.setUint16(pos, chunk.length, true);
    view.setUint16(pos + 2, ~chunk.length & 0xffff, true);
    pos += 4;
    out.set(chunk, pos);
    pos += chunk.length;
  }
  view.setUint32(pos, adler32(data));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== "function") return zlibStored(data);
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export type Rgb = readonly [number, number, number];

/** Encodes `rgb` (width × height × 3 bytes, row-major) as a PNG. */
export async function encodePng(width: number, height: number, rgb: Uint8Array): Promise<Uint8Array> {
  const stride = width * 3;
  // Filter type 1 (Sub) stores each pixel as the difference from its left neighbour, which turns
  // smooth gradients into long runs that deflate well.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[y * stride + x - 3]! : 0;
      raw[row + 1 + x] = (rgb[y * stride + x]! - left) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** FNV-1a, so the same prompt always picks the same colours. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A diagonal two-colour gradient with a soft glow, coloured by `seed`. Different seeds give
 * clearly different images, so a feed of fakes still reads as a feed.
 */
export async function gradientPng(width: number, height: number, seed: number): Promise<Uint8Array> {
  const hue = seed % 360;
  const from = hslToRgb(hue, 0.55, 0.32);
  const to = hslToRgb((hue + 40 + ((seed >>> 9) % 80)) % 360, 0.6, 0.62);
  const glowX = 0.2 + ((seed >>> 3) % 60) / 100;
  const glowY = 0.2 + ((seed >>> 11) % 60) / 100;
  const radius = 0.35 * Math.min(width, height);

  const rgb = new Uint8Array(width * height * 3);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const dx = x - glowX * width;
      const dy = y - glowY * height;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / radius);
      const lift = glow * glow * 70;
      for (let c = 0; c < 3; c++) {
        rgb[i++] = Math.min(255, Math.round(from[c]! + (to[c]! - from[c]!) * t + lift));
      }
    }
  }
  return encodePng(width, height, rgb);
}

/** Width and height from a PNG or JPEG header, or null for anything else. */
export function probeImage(bytes: Uint8Array): { mimeType: string; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < bytes.length) {
      if (bytes[pos] !== 0xff) return null;
      const marker = bytes[pos + 1]!;
      const length = view.getUint16(pos + 2);
      // Start-of-frame markers carry the size; C4, C8 and CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", width: view.getUint16(pos + 7), height: view.getUint16(pos + 5) };
      }
      pos += 2 + length;
    }
  }
  return null;
}

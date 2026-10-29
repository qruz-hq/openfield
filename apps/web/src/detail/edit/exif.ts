// A JPEG's EXIF orientation, read from its first bytes. Phones save photos as the sensor saw them
// and a tag that says how to turn them; browsers turn them on screen, so a mask painted over what
// shows wouldn't line up with the pixels the server edits. The server refuses those (masks.turned);
// reading the tag first lets the Edit tab say so before anything is painted (design 6YuF99zpGo).

/** How much of the file to read: EXIF sits in the first segment, well inside this. */
export const EXIF_HEAD_BYTES = 128 * 1024;

const ORIENTATION_TAG = 0x0112;

/** The orientation tag (1 to 8) of a JPEG, or null when it has none or isn't a JPEG. */
export function jpegOrientation(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Start of scan: the image data begins and no more segments come.
    if (marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    if (marker === 0xe1 && at + 10 <= bytes.length && exifHeader(bytes, at + 4))
      return tiffOrientation(view, at + 10, Math.min(bytes.length, at + 2 + length));
    at += 2 + length;
  }
  return null;
}

/** "Exif\0\0". */
const exifHeader = (bytes: Uint8Array, at: number) =>
  bytes[at] === 0x45 &&
  bytes[at + 1] === 0x78 &&
  bytes[at + 2] === 0x69 &&
  bytes[at + 3] === 0x66 &&
  bytes[at + 4] === 0 &&
  bytes[at + 5] === 0;

function tiffOrientation(view: DataView, start: number, end: number): number | null {
  if (start + 8 > end) return null;
  const order = view.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const ifd = start + view.getUint32(start + 4, little);
  if (ifd + 2 > end) return null;
  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** Shown turned or mirrored, as the server sees it (apps/server/src/files/mask.ts). */
export const isTurnedOrientation = (orientation: number | null): boolean =>
  orientation !== null && orientation >= 2 && orientation <= 8;

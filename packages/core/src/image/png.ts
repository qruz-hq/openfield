// Reading a PNG's header without decoding it, for checks an adapter makes before sending.

/**
 * Whether a PNG carries transparency: a colour type with alpha (grey or RGB plus alpha), or a
 * tRNS chunk, which has to come before the image data.
 */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colourType = bytes[25];
  if (colourType === 4 || colourType === 6) return true;
  for (let pos = 8; pos + 8 <= bytes.byteLength; ) {
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    pos += 12 + view.getUint32(pos);
  }
  return false;
}

import { coverageFromRgba, createMask, type Mask, writeMaskRgba } from "./mask";

// The mask as the PNG POST /api/masks takes, encoded by the browser the way the detail view's Copy
// image is (../actions.ts), and read back to edit again with it. Kept out of mask.ts so that one
// never touches the DOM.

/** Rows per strip: about 4MB of RGBA, so a 4K mask never needs a second full-size copy. */
const STRIP_PIXELS = 1 << 20;

/**
 * Openfield's canonical mask (§0.9) as a PNG at the mask's exact size. RGB is 0 everywhere, so the
 * canvas's premultiplied alpha loses nothing: 0 × alpha is still 0 when the browser divides it back
 * out, and alpha itself is stored as is.
 */
export function encodeMaskPng(
  mask: Mask,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): Promise<Blob> {
  canvas.width = mask.width;
  canvas.height = mask.height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("PNG encode failed: no 2D canvas"));
  const rows = Math.max(1, Math.min(mask.height, Math.floor(STRIP_PIXELS / mask.width)));
  const strip = context.createImageData(mask.width, rows);
  for (let y = 0; y < mask.height; y += rows) {
    const count = Math.min(rows, mask.height - y);
    writeMaskRgba(mask, strip.data, y, count);
    context.putImageData(strip, 0, y, 0, 0, mask.width, count);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG encode failed"))), "image/png"),
  );
}

/**
 * A saved mask read back as coverage, one byte per pixel in a buffer the size MaskEditor starts
 * from, to edit again with it. Only its alpha counts, and a canvas keeps alpha exactly. Read in
 * strips, as it was written.
 */
export async function decodeMaskPng(
  png: Blob,
  width: number,
  height: number,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(png, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  try {
    if (bitmap.width !== width || bitmap.height !== height)
      throw new RangeError(`The mask is ${bitmap.width}x${bitmap.height}, not ${width}x${height}`);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("PNG decode failed: no 2D canvas");
    context.drawImage(bitmap, 0, 0);
    const coverage = createMask(width, height).data;
    const rows = Math.max(1, Math.min(height, Math.floor(STRIP_PIXELS / width)));
    for (let y = 0; y < height; y += rows) {
      const count = Math.min(rows, height - y);
      const strip = coverageFromRgba(context.getImageData(0, y, width, count).data, width, count);
      coverage.set(strip.data.subarray(0, width * count), y * width);
    }
    return coverage;
  } finally {
    bitmap.close();
  }
}

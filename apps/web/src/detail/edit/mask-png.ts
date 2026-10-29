import { type Mask, writeMaskRgba } from "./mask";

// The mask as the PNG POST /api/masks takes, encoded by the browser the way the detail view's Copy
// image is (../actions.ts). Kept out of mask.ts so that one never touches the DOM.

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

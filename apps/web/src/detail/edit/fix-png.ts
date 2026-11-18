import { fixesFromRgba, fixesToRgba } from "@openfield/core";
import { rawFetch } from "../../api/raw";
import { FixLayer } from "./fix-layer";

// A fix layer to and from the PNG the server keeps (§0.9): RGBA at the original's size, opaque
// white "use the model here", opaque black "use the original here", transparent no opinion.

/** The stored fix layer at `url`, or an empty one when there's none yet. */
export async function readFixes(url: string | null, width: number, height: number): Promise<FixLayer> {
  if (!url) return new FixLayer(width, height);
  const res = await rawFetch(url);
  if (!res.ok) throw new Error(`Fixes ${res.status}`);
  // Exact values, not colour managed or premultiplied: each pixel is a code.
  const bitmap = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new FixLayer(width, height, fixesFromRgba(context.getImageData(0, 0, width, height).data));
}

/** A fix layer as the PNG the server reads, for Apply or Save as new image. */
export async function encodeFixes(fixes: FixLayer): Promise<Blob> {
  const canvas = new OffscreenCanvas(fixes.width, fixes.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  const rgba = fixesToRgba(fixes.codes);
  context.putImageData(
    new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), fixes.width, fixes.height),
    0,
    0,
  );
  return canvas.convertToBlob({ type: "image/png" });
}

// The Edit tab's Difference view (design OthLvkDvWM): where a new image differs from the original.
// Both are drawn at the size they're shown, then compared pixel by pixel. What comes out is a mask,
// white with the change as its alpha, which the view tints with the accent. This file runs in the
// worker (difference.worker.ts) and, where there's no worker, on the page; it never touches the DOM.

/**
 * A channel that moved this little is the previews' own encoding, not a change: they're lossy WebP,
 * and the encoder can treat the same pixels a step differently in two images.
 */
export const NOISE_FLOOR = 12;
/**
 * From this much on (out of 255, about a fifth of the range), a pixel reads as fully changed. Less
 * ramps up from the floor: the feathered edge, where the new image fades into the original.
 */
export const FULL_CHANGE = 48;

/**
 * How much each pixel changed, as RGBA: white, with alpha 0 for the same and 255 for a full change.
 * A pixel's change is its channel that moved most, so a shift in hue counts as much as one in light.
 * In between (the feathered edge, where the new image blends into the original) it ramps.
 */
export function changeAlpha(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  if (before.length !== after.length || before.length % 4 !== 0)
    throw new RangeError("Both images must be RGBA at the same size");
  const out = new Uint8ClampedArray(before.length);
  const span = FULL_CHANGE - NOISE_FLOOR;
  for (let i = 0; i < before.length; i += 4) {
    const moved = Math.max(
      Math.abs(before[i]! - after[i]!),
      Math.abs(before[i + 1]! - after[i + 1]!),
      Math.abs(before[i + 2]! - after[i + 2]!),
      Math.abs(before[i + 3]! - after[i + 3]!),
    );
    out[i] = 255;
    out[i + 1] = 255;
    out[i + 2] = 255;
    out[i + 3] = moved <= NOISE_FLOOR ? 0 : moved >= FULL_CHANGE ? 255 : ((moved - NOISE_FLOOR) * 255) / span;
  }
  return out;
}

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * The size to compare at: the image as it's shown, in device pixels, but never more than the
 * original's preview holds. The shown box already has the image's shape, so it keeps it.
 */
export function compareSize(shown: PixelSize, source: PixelSize): PixelSize {
  const scale = Math.min(1, source.width / shown.width, source.height / shown.height);
  return {
    width: Math.max(1, Math.round(shown.width * scale)),
    height: Math.max(1, Math.round(shown.height * scale)),
  };
}

/** A 2D canvas: an OffscreenCanvas in the worker, a <canvas> on the page. */
export type Surface = OffscreenCanvas | HTMLCanvasElement;

export interface DifferenceRequest {
  before: Blob;
  after: Blob;
  /** The size the image is shown at, in device pixels. */
  shown: PixelSize;
}

type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function context2d(surface: Surface): Context {
  const context = surface.getContext("2d", { willReadFrequently: true }) as Context | null;
  if (!context) throw new Error("No 2D canvas to compare on");
  return context;
}

/** The image drawn at `size`, as RGBA. A new image of another size is stretched onto the original's. */
function pixelsAt(image: ImageBitmap, size: PixelSize, surface: Surface): Uint8ClampedArray {
  surface.width = size.width;
  surface.height = size.height;
  const context = context2d(surface);
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height).data;
}

/**
 * Decodes both images and draws the change mask on a fresh surface from `surface`. Both are drawn
 * with the same scaling at the same size, so the parts that match come out matching.
 */
export async function drawDifference(
  request: DifferenceRequest,
  surface: (width: number, height: number) => Surface,
): Promise<Surface> {
  const [before, after] = await Promise.all([
    createImageBitmap(request.before),
    createImageBitmap(request.after),
  ]);
  try {
    const size = compareSize(request.shown, before);
    const scratch = surface(size.width, size.height);
    const a = pixelsAt(before, size, scratch);
    const b = pixelsAt(after, size, scratch);
    const out = surface(size.width, size.height);
    const mask = new ImageData(changeAlpha(a, b), size.width, size.height);
    context2d(out).putImageData(mask, 0, 0);
    return out;
  } finally {
    before.close();
    after.close();
  }
}

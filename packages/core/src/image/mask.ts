import type { MaskInput } from "../schemas/request";

// Masks, and the composite that puts a masked edit's untouched pixels back exactly as they were
// (§0.9). Pure math over raw pixel buffers, so the server, the browser and tests share one rule.
// A mask's alpha says what to change: 0 changes, 255 keeps, and its colour is ignored.

/**
 * A pixel is marked to change when its alpha is below this. Anything above counts as kept, so
 * faint noise in a mask (a JPEG's black that isn't quite black) never lets the edit through.
 */
export const MASK_CHANGE_BELOW = 128;

/**
 * What a masked edit does with the result when the request doesn't say: put the original back
 * outside the mask, after growing the mask by `expandPx` and softening its edge over `featherPx`.
 */
export const MASK_COMPOSITE_DEFAULTS = { composite: true, expandPx: 4, featherPx: 8 } as const;

export interface CompositeSettings {
  composite: boolean;
  expandPx: number;
  featherPx: number;
}

/** A request's composite settings with the defaults filled in. */
export function compositeSettingsOf(
  mask: Pick<MaskInput, "composite" | "expandPx" | "featherPx"> = {},
): CompositeSettings {
  return {
    composite: mask.composite ?? MASK_COMPOSITE_DEFAULTS.composite,
    expandPx: mask.expandPx ?? MASK_COMPOSITE_DEFAULTS.expandPx,
    featherPx: mask.featherPx ?? MASK_COMPOSITE_DEFAULTS.featherPx,
  };
}

type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array;

/**
 * How much of the edit each pixel takes, 0 to 255, from a mask's alpha (one byte per pixel).
 * Every pixel within `expandPx` of the change area takes all of it; past that the share falls
 * smoothly to nothing over `featherPx`. A pixel farther than expandPx + featherPx from the change
 * area (straight-line distance between pixel centres) is always 0, so it keeps the original.
 */
export function weightsFromAlpha(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  opts: { expandPx: number; featherPx: number },
): Uint8Array {
  checkLength(alpha.length, width, height, 1);
  const { expandPx, featherPx } = opts;
  if (!isCount(expandPx) || !isCount(featherPx) || expandPx + featherPx > MAX_REACH)
    throw new RangeError(
      `expandPx and featherPx must be whole numbers from 0, ${MAX_REACH} together at most`,
    );
  const weights = new Uint8Array(width * height);
  const reach = expandPx + featherPx;

  // Only the change area's bounding box, grown by the reach, can take any of the edit.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x]! < MASK_CHANGE_BELOW) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return weights;
  const left = Math.max(0, minX - reach);
  const top = Math.max(0, minY - reach);
  const boxW = Math.min(width - 1, maxX + reach) - left + 1;
  const boxH = Math.min(height - 1, maxY + reach) - top + 1;

  // The weight for each squared distance, so the inner loop is a lookup.
  const reach2 = reach * reach;
  const ramp = new Uint8Array(reach2 + 1);
  for (let d2 = 0; d2 <= reach2; d2++) {
    const d = Math.sqrt(d2);
    if (d <= expandPx) ramp[d2] = 255;
    else if (d < reach) {
      const t = (d - expandPx) / featherPx;
      ramp[d2] = Math.round(255 * (1 - t * t * (3 - 2 * t)));
    }
  }

  // Exact distances in two passes (Felzenszwalb and Huttenlocher): down each column to the nearest
  // change pixel, then across each row as a lower envelope of parabolas. Columns stop counting
  // past the reach, since nothing farther can matter.
  const far = reach + 1;
  const column = new Uint16Array(boxW * boxH);
  for (let x = 0; x < boxW; x++) {
    let run = far;
    for (let y = 0; y < boxH; y++) {
      run = alpha[(top + y) * width + left + x]! < MASK_CHANGE_BELOW ? 0 : Math.min(far, run + 1);
      column[y * boxW + x] = run;
    }
    run = far;
    for (let y = boxH - 1; y >= 0; y--) {
      const i = y * boxW + x;
      run = column[i] === 0 ? 0 : Math.min(far, run + 1);
      if (run < column[i]!) column[i] = run;
    }
  }

  const vertex = new Int32Array(boxW);
  const bound = new Float64Array(boxW + 1);
  for (let y = 0; y < boxH; y++) {
    const row = y * boxW;
    let k = -1;
    for (let q = 0; q < boxW; q++) {
      const dq = column[row + q]!;
      if (dq > reach) continue;
      const fq = dq * dq + q * q;
      if (k < 0) {
        k = 0;
        vertex[0] = q;
        bound[0] = Number.NEGATIVE_INFINITY;
        bound[1] = Number.POSITIVE_INFINITY;
        continue;
      }
      let s: number;
      for (;;) {
        const v = vertex[k]!;
        const dv = column[row + v]!;
        s = (fq - (dv * dv + v * v)) / (2 * (q - v));
        if (s > bound[k]!) break;
        k--;
      }
      k++;
      vertex[k] = q;
      bound[k] = s;
      bound[k + 1] = Number.POSITIVE_INFINITY;
    }
    if (k < 0) continue;
    const out = (top + y) * width + left;
    let j = 0;
    for (let x = 0; x < boxW; x++) {
      while (bound[j + 1]! < x) j++;
      const v = vertex[j]!;
      const dv = column[row + v]!;
      const d2 = (x - v) * (x - v) + dv * dv;
      if (d2 <= reach2) weights[out + x] = ramp[d2]!;
    }
  }
  return weights;
}

/**
 * The edit laid over the original by `weights` (one per pixel, from weightsFromAlpha). Both images
 * are raw pixels of the same size, layout and depth, `channels` values per pixel. Where the weight
 * is 0 the original's values are copied as they are, and where it's 255 the edit's.
 */
export function blendPixels<T extends Pixels>(base: T, result: T, weights: Uint8Array, channels: number): T {
  checkLength(base.length, weights.length, 1, channels);
  if (result.length !== base.length)
    throw new RangeError(`The edit has ${result.length} values, the original ${base.length}`);
  const out = base.slice() as T;
  for (let p = 0, i = 0; p < weights.length; p++, i += channels) {
    const w = weights[p]!;
    if (w === 0) continue;
    if (w === 255) {
      for (let c = 0; c < channels; c++) out[i + c] = result[i + c]!;
      continue;
    }
    const keep = 255 - w;
    for (let c = 0; c < channels; c++)
      out[i + c] = Math.round((base[i + c]! * keep + result[i + c]! * w) / 255);
  }
  return out;
}

/**
 * Alpha for an opaque black and white mask, by luminance: white changes (alpha 0), black keeps
 * (alpha 255), greys fall between. `channels` is 1 (grey), 2 (grey and alpha), 3 (RGB) or 4 (RGBA);
 * any alpha in the input is ignored.
 */
export function luminanceToAlpha(pixels: ArrayLike<number>, channels: 1 | 2 | 3 | 4): Uint8Array {
  if (pixels.length % channels) throw new RangeError(`${pixels.length} values don't split into ${channels}s`);
  const alpha = new Uint8Array(pixels.length / channels);
  for (let p = 0, i = 0; p < alpha.length; p++, i += channels) {
    // Rec. 709 weights, in whole numbers so every runtime rounds the same way.
    const luma =
      channels < 3
        ? pixels[i]!
        : Math.round((2126 * pixels[i]! + 7152 * pixels[i + 1]! + 722 * pixels[i + 2]!) / 10_000);
    alpha[p] = 255 - luma;
  }
  return alpha;
}

/** The same mask with change and keep swapped. */
export function invertAlpha(alpha: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = 255 - alpha[i]!;
  return out;
}

/** True when a mask marks nothing to change. */
export function isEmptyMask(alpha: ArrayLike<number>): boolean {
  for (let i = 0; i < alpha.length; i++) if (alpha[i]! < MASK_CHANGE_BELOW) return false;
  return true;
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;
// Column distances are kept in 16 bits, and a request allows far less (32 each).
const MAX_REACH = 4096;

function checkLength(length: number, width: number, height: number, channels: number): void {
  if (length !== width * height * channels)
    throw new RangeError(`Expected ${width * height * channels} values, got ${length}`);
}

import { MASK_CHANGE_BELOW, MASK_COMPOSITE_DEFAULTS, MASK_COMPOSITE_MAX_PX, weightsFromAlpha } from "./mask";

// Smart "Keep the rest of the image" (§0.9). The model's result is lined up with the original
// (a small shift and scale), compared with it to find what really changed, and the area taken
// from the model is decided from the mask and those changes: grown into changes that spill out of
// the mask, joined by clear changes anywhere else, and handed back to the original wherever
// nothing really changed, even inside the mask. Pure math over raw pixels, so the server's Apply
// and the browser's live preview decide the same area.
//
// The work comes in two steps, so a slider can move without redoing the slow part:
//   analyzeKeepRest: downscale both images, line them up, measure the difference and its noise.
//   decideKeepRest: from that, the per-pixel weights for one Sensitivity, Feather and Expand.
// Then alignResult moves the model's pixels by the line-up and blendPixels (mask.ts) lays them over
// the original by the weights.

type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array;

/** Raw pixels, row-major. 1 grey, 2 grey and alpha, 3 RGB, 4 RGBA. 16-bit when a Uint16Array. */
export interface PixelImage<T extends Pixels = Pixels> {
  data: T;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/**
 * How readily a change counts as real. Higher keeps more of the model's changes (the cut-off
 * drops), lower keeps fewer. 50 sits at the noise the pair itself shows; each 25 either way halves
 * or doubles the cut-off.
 */
export const KEEP_REST_SENSITIVITY = {
  min: 0,
  max: 100,
  default: MASK_COMPOSITE_DEFAULTS.sensitivity,
} as const;

/** The long edge of the analysis pass. The blend itself is always at full size. */
export const KEEP_REST_ANALYSIS_EDGE = 512;

/**
 * Why a smart decision fell back to the mask alone (mask, Expand and Feather, as before):
 *   no_match       the result couldn't be lined up with the original, or isn't the same picture
 *   other_shape    the model sent a different shape, stretched to fit
 *   too_different  so much changed that real changes can't be told from drift
 */
export const KEEP_REST_FALLBACKS = ["no_match", "other_shape", "too_different"] as const;
export type KeepRestFallback = (typeof KEEP_REST_FALLBACKS)[number];

/** smart: the mask and what really changed; mask: the mask alone (Expand and Feather), as before. */
export const KEEP_REST_MODES = ["smart", "mask"] as const;
export type KeepRestMode = (typeof KEEP_REST_MODES)[number];

/** A fix layer's value per pixel: no opinion, use the model, use the original. */
export const FIX_NONE = 0;
export const FIX_MODEL = 1;
export const FIX_ORIGINAL = 2;

/**
 * Where the model's result is read for each pixel of the original: (u, v) with
 * u = scaleX * (x - cx) + cx + dx and v = scaleY * (y - cy) + cy + dy, where (cx, cy) is the
 * image's centre, (width - 1) / 2 and (height - 1) / 2, all in the original's pixels.
 */
export interface LineUp {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  /**
   * How well the fine detail outside the mask matches once lined up, 0 to 1 (a correlation).
   * Below KEEP_REST_LIMITS.confidence the result is treated as not the same picture.
   */
  confidence: number;
}

/** The fixed limits the decision works within. Exported so tests and docs name them. */
export const KEEP_REST_LIMITS = {
  /** Line-up confidence below this falls back to the mask. */
  confidence: 0.3,
  /** The largest shift looked for, as a share of the long edge. */
  maxShift: 0.05,
  /** The largest scale change looked for, either way. */
  maxScale: 0.06,
  /** A result whose shape differs from the original's by more than this (log ratio) falls back. */
  maxShapeChange: 0.05,
  /** Typical difference (8-bit levels) past which drift can't be told from change. */
  maxNoise: 18,
  /** Share of the picture away from the mask that may come from the model before falling back. */
  maxChangedOutside: 0.5,
  /** The smallest clear change kept away from the mask, as a share of the picture. */
  minClearArea: 0.0004,
  /** The lowest cut-off, in 8-bit levels, so a near-perfect copy doesn't keep rounding noise. */
  minCutoff: 1.5,
  /** How much stronger a change must be to count as clear, away from the mask. */
  clearFactor: 2.5,
} as const;

export interface KeepRestSettings {
  expandPx: number;
  featherPx: number;
  /** KEEP_REST_SENSITIVITY: 0 to 100. */
  sensitivity: number;
}

export interface KeepRestAnalysis {
  width: number;
  height: number;
  /** The analysis pass: each of its pixels is factor x factor of the original's. */
  factor: number;
  analysisWidth: number;
  analysisHeight: number;
  lineUp: LineUp;
  /** Set when the comparison can't be trusted, so every decision uses the mask alone. */
  fallback?: KeepRestFallback;
  /** Per analysis pixel, how different the two are (8-bit levels), after line-up and colour drift. */
  difference: Float32Array;
  /** The pair's typical difference where nothing changed, and its spread (8-bit levels). */
  noise: { median: number; spread: number };
  /** The cut-off at the default sensitivity, before the floor. */
  cutoff: number;
  /** Per analysis pixel, 1 where the mask (plus a margin) is, so it's left out of the measuring. */
  near: Uint8Array;
}

export interface KeepRestDecision {
  /** Per pixel of the original, 0 (original) to 255 (model), for blendPixels. */
  weights: Uint8Array;
  /** Set when the mask alone decided. */
  fallback?: KeepRestFallback;
  /** Share of the picture that comes from the model, 0 to 1. */
  changed: number;
  /** The cut-off used, in 8-bit levels. */
  cutoff: number;
}

/**
 * Lines the model's result up with the original and measures what changed. `area` is the mask's
 * alpha at the original's size (below MASK_CHANGE_BELOW is the area to change, as everywhere).
 * Both images must be the original's size: a result the model sent at another size is stretched
 * to it first, and `sentSize` says what it was, so a different shape can fall back.
 */
export function analyzeKeepRest(
  base: PixelImage,
  result: PixelImage,
  area: ArrayLike<number>,
  opts: { sentSize?: { width: number; height: number } } = {},
): KeepRestAnalysis {
  const { width, height } = base;
  if (result.width !== width || result.height !== height)
    throw new RangeError(`The result is ${result.width}×${result.height}, the original ${width}×${height}`);
  if (area.length !== width * height) throw new RangeError(`Expected ${width * height} mask values`);
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / KEEP_REST_ANALYSIS_EDGE));
  const aw = Math.max(1, Math.floor(width / factor));
  const ah = Math.max(1, Math.floor(height / factor));
  const n = aw * ah;

  const b = downsample(base, factor, aw, ah);
  const r = downsample(result, factor, aw, ah);
  const near = nearMask(area, width, height, factor, aw, ah);
  let far = 0;
  for (let i = 0; i < n; i++) if (!near[i]) far++;

  const identity: LineUp = { dx: 0, dy: 0, scaleX: 1, scaleY: 1, confidence: 0 };
  const empty = (fallback: KeepRestFallback, lineUp = identity): KeepRestAnalysis => ({
    width,
    height,
    factor,
    analysisWidth: aw,
    analysisHeight: ah,
    lineUp,
    fallback,
    difference: new Float32Array(n),
    noise: { median: 0, spread: 0 },
    cutoff: 0,
    near,
  });

  if (opts.sentSize) {
    const shape = Math.abs(Math.log(opts.sentSize.width / opts.sentSize.height / (width / height)));
    if (shape > KEEP_REST_LIMITS.maxShapeChange) return empty("other_shape");
  }
  // Too little of the picture is left to measure against.
  if (far < Math.max(64, n * 0.05)) return empty("no_match");

  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) weight[i] = near[i] ? 0 : 1;
  const found = findLineUp(lumaOf(b, n), lumaOf(r, n), weight, aw, ah);
  // In the original's pixels, about its own centre.
  const lineUp = toFullSize(found, factor, aw, ah, width, height);
  const longEdge = Math.max(width, height);
  if (
    found.confidence < KEEP_REST_LIMITS.confidence ||
    Math.hypot(lineUp.dx, lineUp.dy) > KEEP_REST_LIMITS.maxShift * longEdge ||
    Math.abs(lineUp.scaleX - 1) > KEEP_REST_LIMITS.maxScale ||
    Math.abs(lineUp.scaleY - 1) > KEEP_REST_LIMITS.maxScale
  )
    // Not used, so not reported: a failed search's numbers mean nothing. Its confidence does.
    return empty("no_match", { ...identity, confidence: found.confidence });

  const moved = warpFloat(r, aw, ah, 4, found);
  const difference = differenceOf(blur(b, aw, ah), blur(moved, aw, ah), weight, n);
  const noise = noiseOf(difference, near);
  const analysis: KeepRestAnalysis = {
    width,
    height,
    factor,
    analysisWidth: aw,
    analysisHeight: ah,
    lineUp,
    difference,
    noise,
    cutoff: noise.median + 4 * noise.spread,
    near,
  };
  if (noise.median > KEEP_REST_LIMITS.maxNoise) analysis.fallback = "too_different";
  return analysis;
}

/**
 * The weights for one set of settings: from the mask grown by expandPx, into changes connected to
 * it, plus clear changes anywhere, minus whatever didn't really change, softened outward over
 * featherPx. `fixes` (one per pixel: FIX_NONE, FIX_MODEL, FIX_ORIGINAL) overrides the decision; a
 * pixel fixed to the original always gets weight 0, feathering included. When the analysis can't
 * be trusted, or so much changed that the rest couldn't be kept, the mask alone decides, exactly as
 * weightsFromAlpha does, fixes still on top.
 */
export function decideKeepRest(
  analysis: KeepRestAnalysis,
  area: ArrayLike<number>,
  settings: KeepRestSettings,
  fixes?: Uint8Array,
): KeepRestDecision {
  const { width, height, factor, analysisWidth: aw, analysisHeight: ah, near } = analysis;
  const n = aw * ah;
  if (area.length !== width * height) throw new RangeError(`Expected ${width * height} mask values`);
  if (fixes && fixes.length !== width * height) throw new RangeError(`Expected ${width * height} fixes`);
  const sensitivity = clampSensitivity(settings.sensitivity);
  const cutoff = Math.max(
    KEEP_REST_LIMITS.minCutoff,
    analysis.cutoff * 2 ** ((KEEP_REST_SENSITIVITY.default - sensitivity) / 25),
  );
  const maskOnly = (fallback: KeepRestFallback): KeepRestDecision => {
    const weights = maskOnlyWeights(area, width, height, settings, fixes);
    return { weights, fallback, changed: share(weights), cutoff };
  };

  if (analysis.fallback) return maskOnly(analysis.fallback);

  // The mask grown by expandPx, seen at the analysis size: any pixel of it counts.
  const seeded = coverage(grown(area, width, height, settings.expandPx), width, height, factor, aw, ah);
  const changedLow = new Uint8Array(n);
  const changedHigh = new Uint8Array(n);
  const d = analysis.difference;
  const clear = cutoff * KEEP_REST_LIMITS.clearFactor;
  for (let i = 0; i < n; i++) {
    if (d[i]! > cutoff) changedLow[i] = 1;
    if (d[i]! > clear) changedHigh[i] = 1;
  }
  const minArea = Math.max(6, Math.round(n * KEEP_REST_LIMITS.minClearArea));
  const keep = keptRegions(changedLow, changedHigh, seeded, aw, ah, minArea);
  fillHoles(keep, aw, ah, minArea);
  const kept = dilate(keep, aw, ah);

  let farKept = 0;
  let far = 0;
  for (let i = 0; i < n; i++) {
    if (near[i]) continue;
    far++;
    if (kept[i]) farKept++;
  }
  if (far && farKept / far > KEEP_REST_LIMITS.maxChangedOutside) return maskOnly("too_different");

  const full = upsample(kept, aw, ah, factor, width, height);
  const weights = featheredFrom(fixes ? withFixes(full, fixes) : full, width, height, settings, fixes);
  return { weights, changed: share(weights), cutoff };
}

/**
 * The mask alone decides (Keep the rest as it was before it looked at what changed): the mask grown
 * by expandPx and softened over featherPx, exactly as weightsFromAlpha, with any fixes on top.
 */
export function maskOnlyWeights(
  area: ArrayLike<number>,
  width: number,
  height: number,
  settings: Pick<KeepRestSettings, "expandPx" | "featherPx">,
  fixes?: Uint8Array,
): Uint8Array {
  if (!fixes) return weightsFromAlpha(area, width, height, settings);
  return featheredFrom(
    withFixes(grown(area, width, height, settings.expandPx), fixes),
    width,
    height,
    settings,
    fixes,
  );
}

/** Share of the picture these weights take from the model, 0 to 1. */
export function shareOfModel(weights: Uint8Array): number {
  return share(weights);
}

/**
 * The model's pixels moved by the line-up, in their own layout. Unmoved when the line-up is (near
 * enough) none, so the stored values are blended as they are. With `weights`, only pixels that
 * take any of the model are worked out; the rest are left as they were in `result`.
 */
export function alignResult<T extends Pixels>(
  result: PixelImage<T>,
  lineUp: LineUp,
  weights?: Uint8Array,
): T {
  if (isStill(lineUp)) return result.data;
  const { width, height, channels, data } = result;
  const out = data.slice() as T;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    const v = clamp(lineUp.scaleY * (y - cy) + cy + lineUp.dy, 0, height - 1);
    const y0 = Math.floor(v);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = v - y0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (weights && weights[p] === 0) continue;
      const u = clamp(lineUp.scaleX * (x - cx) + cx + lineUp.dx, 0, width - 1);
      const x0 = Math.floor(u);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = u - x0;
      const a = (y0 * width + x0) * channels;
      const bb = (y0 * width + x1) * channels;
      const c = (y1 * width + x0) * channels;
      const e = (y1 * width + x1) * channels;
      for (let k = 0; k < channels; k++) {
        const top = data[a + k]! + (data[bb + k]! - data[a + k]!) * fx;
        const bottom = data[c + k]! + (data[e + k]! - data[c + k]!) * fx;
        out[p * channels + k] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

/** True when a line-up moves nothing by as much as a quarter of a pixel anywhere in the image. */
export function isStill(lineUp: Pick<LineUp, "dx" | "dy" | "scaleX" | "scaleY">, longEdge = 8192): boolean {
  const reach = longEdge / 2;
  return (
    Math.abs(lineUp.dx) < 0.25 &&
    Math.abs(lineUp.dy) < 0.25 &&
    Math.abs(lineUp.scaleX - 1) * reach < 0.25 &&
    Math.abs(lineUp.scaleY - 1) * reach < 0.25
  );
}

/**
 * A fix layer from RGBA pixels (a PNG the browser painted): transparent is no opinion; opaque
 * white (luma 128 and up) is use the model, opaque black is use the original.
 */
export function fixesFromRgba(rgba: ArrayLike<number>): Uint8Array {
  if (rgba.length % 4) throw new RangeError(`${rgba.length} values don't split into RGBA`);
  const out = new Uint8Array(rgba.length / 4);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    if (rgba[i + 3]! < 128) continue;
    const luma = (2126 * rgba[i]! + 7152 * rgba[i + 1]! + 722 * rgba[i + 2]!) / 10_000;
    out[p] = luma >= 128 ? FIX_MODEL : FIX_ORIGINAL;
  }
  return out;
}

/** A fix layer as RGBA, the way fixesFromRgba reads it back. */
export function fixesToRgba(fixes: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(fixes.length * 4);
  for (let p = 0; p < fixes.length; p++) {
    const f = fixes[p];
    if (f !== FIX_MODEL && f !== FIX_ORIGINAL) continue;
    const v = f === FIX_MODEL ? 255 : 0;
    out.set([v, v, v, 255], p * 4);
  }
  return out;
}

/** True when a fix layer has no opinion anywhere. */
export function isEmptyFixes(fixes: ArrayLike<number>): boolean {
  for (let i = 0; i < fixes.length; i++)
    if (fixes[i] === FIX_MODEL || fixes[i] === FIX_ORIGINAL) return false;
  return true;
}

export const clampSensitivity = (s: number): number =>
  Number.isFinite(s)
    ? clamp(Math.round(s), KEEP_REST_SENSITIVITY.min, KEEP_REST_SENSITIVITY.max)
    : KEEP_REST_SENSITIVITY.default;

// Analysis images: RGBA floats, 0 to 255, each pixel the mean of a factor x factor block.

function downsample(img: PixelImage, factor: number, aw: number, ah: number): Float32Array {
  const { data, width, channels } = img;
  const scale = data instanceof Uint16Array ? 1 / 257 : 1;
  const colour = channels >= 3;
  const alpha = channels === 2 || channels === 4;
  const out = new Float32Array(aw * ah * 4);
  const sums = new Float64Array(aw * 4);
  const per = scale / (factor * factor);
  const opaque = data instanceof Uint16Array ? 65_535 : 255;
  for (let ay = 0; ay < ah; ay++) {
    sums.fill(0);
    for (let dy = 0; dy < factor; dy++) {
      const row = (ay * factor + dy) * width;
      for (let ax = 0; ax < aw; ax++) {
        const s = ax * 4;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + ax * factor + dx) * channels;
          const r = data[i]!;
          sums[s] = sums[s]! + r;
          sums[s + 1] = sums[s + 1]! + (colour ? data[i + 1]! : r);
          sums[s + 2] = sums[s + 2]! + (colour ? data[i + 2]! : r);
          sums[s + 3] = sums[s + 3]! + (alpha ? data[i + channels - 1]! : opaque);
        }
      }
    }
    const o = ay * aw * 4;
    for (let k = 0; k < aw * 4; k++) out[o + k] = sums[k]! * per;
  }
  return out;
}

function lumaOf(rgba: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4)
    out[p] = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
  return out;
}

/**
 * 1 for analysis pixels the mask reaches, grown by a margin past anything Expand and Feather could
 * reach, since a model's changes spill a little: those pixels are left out of lining up and of the
 * noise estimate.
 */
function nearMask(
  area: ArrayLike<number>,
  width: number,
  height: number,
  factor: number,
  aw: number,
  ah: number,
): Uint8Array {
  const touched = coverage(area, width, height, factor, aw, ah);
  const margin = Math.ceil((2 * MASK_COMPOSITE_MAX_PX) / factor) + 1;
  return grow(touched, aw, ah, margin);
}

/** 1 for analysis pixels with any full-size pixel marked to change in `alpha`. */
function coverage(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  factor: number,
  aw: number,
  ah: number,
): Uint8Array {
  const out = new Uint8Array(aw * ah);
  for (let y = 0; y < height; y++) {
    const ay = Math.min(ah - 1, Math.floor(y / factor));
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x]! < MASK_CHANGE_BELOW) out[ay * aw + Math.min(aw - 1, Math.floor(x / factor))] = 1;
    }
  }
  return out;
}

/** `alpha` with its change area grown by `px` (exactly as weightsFromAlpha grows it). */
function grown(alpha: ArrayLike<number>, width: number, height: number, px: number): Uint8Array {
  if (px <= 0) {
    const out = new Uint8Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) out[i] = alpha[i]! < MASK_CHANGE_BELOW ? 0 : 255;
    return out;
  }
  const w = weightsFromAlpha(alpha, width, height, { expandPx: px, featherPx: 0 });
  for (let i = 0; i < w.length; i++) w[i] = w[i] === 255 ? 0 : 255;
  return w;
}

/** A square grown around each set pixel, `r` pixels each way (Chebyshev), in two passes. */
function grow(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const across = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (src[row + x]) last = x;
      if (x - last <= r) across[row + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (src[row + x]) last = x;
      if (last - x <= r) across[row + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (across[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (across[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

// Lining up: a coarse search for the shift, then Gauss-Newton on shift, scale, and a gain and
// offset for brightness, level by level, with robust weights so the changes themselves don't pull.

interface Fit {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  confidence: number;
}

interface Level {
  w: number;
  h: number;
  base: Float32Array;
  result: Float32Array;
  weight: Float32Array;
}

function findLineUp(
  base: Float32Array,
  result: Float32Array,
  weight: Float32Array,
  w: number,
  h: number,
): Fit {
  const levels: Level[] = [{ w, h, base, result, weight }];
  while (levels.length < 5) {
    const last = levels[levels.length - 1]!;
    if (Math.min(last.w, last.h) < 48) break;
    levels.push(half(last));
  }
  const top = levels[levels.length - 1]!;
  let fit = coarseShift(top, Math.max(2, Math.ceil(KEEP_REST_LIMITS.maxShift * Math.max(top.w, top.h)) + 1));
  for (let l = levels.length - 1; l >= 0; l--) {
    if (l < levels.length - 1) fit = { ...fit, tx: fit.tx * 2, ty: fit.ty * 2 };
    fit = refine(levels[l]!, fit);
  }
  const level = levels[0]!;
  const lined = { ...fit, confidence: detailMatch(level, fit) };
  const still = {
    tx: 0,
    ty: 0,
    sx: 1,
    sy: 1,
    confidence: detailMatch(level, { tx: 0, ty: 0, sx: 1, sy: 1 }),
  };
  // A line-up that doesn't match the detail better than leaving it isn't worth the resampling.
  return lined.confidence > still.confidence + 0.002 ? lined : still;
}

function half(l: Level): Level {
  const w = Math.floor(l.w / 2);
  const h = Math.floor(l.h / 2);
  const pick = (src: Float32Array) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = 2 * y * l.w + 2 * x;
        out[y * w + x] = (src[i]! + src[i + 1]! + src[i + l.w]! + src[i + l.w + 1]!) / 4;
      }
    return out;
  };
  const weight = pick(l.weight);
  // Only blocks wholly away from the mask count.
  for (let i = 0; i < weight.length; i++) weight[i] = weight[i]! > 0.99 ? 1 : 0;
  return { w, h, base: pick(l.base), result: pick(l.result), weight };
}

/** The whole-pixel shift with the best correlation, scale left at 1. */
function coarseShift(l: Level, radius: number): Fit {
  let best = { tx: 0, ty: 0, sx: 1, sy: 1, confidence: -2 };
  for (let ty = -radius; ty <= radius; ty++)
    for (let tx = -radius; tx <= radius; tx++) {
      let n = 0;
      let sb = 0;
      let sr = 0;
      let sbb = 0;
      let srr = 0;
      let sbr = 0;
      for (let y = Math.max(0, -ty); y < Math.min(l.h, l.h - ty); y++)
        for (let x = Math.max(0, -tx); x < Math.min(l.w, l.w - tx); x++) {
          const i = y * l.w + x;
          if (!l.weight[i]) continue;
          const b = l.base[i]!;
          const r = l.result[(y + ty) * l.w + x + tx]!;
          n++;
          sb += b;
          sr += r;
          sbb += b * b;
          srr += r * r;
          sbr += b * r;
        }
      if (n < 16) continue;
      const cov = sbr - (sb * sr) / n;
      const vb = sbb - (sb * sb) / n;
      const vr = srr - (sr * sr) / n;
      const ncc = vb > 0 && vr > 0 ? cov / Math.sqrt(vb * vr) : 0;
      // Ties go to the smaller shift.
      if (ncc > best.confidence + 1e-6) best = { tx, ty, sx: 1, sy: 1, confidence: ncc };
    }
  return best;
}

/** Shift, scale, gain and offset, as refine() moves them. */
type Params = [tx: number, ty: number, sx: number, sy: number, gain: number, offset: number];

/**
 * Gauss-Newton with Tukey's biweight, so residuals past the cut (the changes) count for nothing.
 * Each step is kept only when it lowers the robust cost; otherwise it's halved, and the fit stops
 * once halving no longer helps. That keeps a picture with little detail from sending it anywhere.
 */
function refine(l: Level, start: Fit): Fit {
  const { w, h } = l;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const span = Math.max(w, h) / 2;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = (l.result[y * w + Math.min(w - 1, x + 1)]! - l.result[y * w + Math.max(0, x - 1)]!) / 2;
      gy[i] = (l.result[Math.min(h - 1, y + 1) * w + x]! - l.result[Math.max(0, y - 1) * w + x]!) / 2;
    }
  const H = new Float64Array(36);
  const g = new Float64Array(6);
  const J = new Float64Array(6);
  const hist = new Uint32Array(512);

  /** The mean robust cost at `p`; with `solve`, also the normal equations for a step. */
  const pass = (p: Params, cut: number, solve: boolean): { cost: number; count: number } => {
    const [tx, ty, sx, sy, gain, offset] = p;
    if (solve) {
      H.fill(0);
      g.fill(0);
    }
    hist.fill(0);
    let cost = 0;
    let count = 0;
    let outside = 0;
    const c2 = (cut * cut) / 6;
    for (let y = 0; y < h; y++) {
      const v = sy * (y - cy) + cy + ty;
      const rowOut = v < 0 || v > h - 1;
      const y0 = Math.min(h - 2, Math.floor(v));
      const fy = v - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const wt = l.weight[i]!;
        if (!wt) continue;
        const u = sx * (x - cx) + cx + tx;
        if (rowOut || u < 0 || u > w - 1) {
          outside++;
          continue;
        }
        const x0 = Math.min(w - 2, Math.floor(u));
        const fx = u - x0;
        const a = y0 * w + x0;
        const R = bilerp(l.result, a, w, fx, fy);
        const r = gain * R + offset - l.base[i]!;
        const mag = Math.abs(r);
        hist[Math.min(511, Math.floor(mag * 4))]!++;
        count++;
        if (mag >= cut) {
          cost += c2;
          continue;
        }
        const t = r / cut;
        const s = 1 - t * t;
        cost += c2 * (1 - s * s * s);
        if (!solve) continue;
        const rw = wt * s * s;
        const ex = gain * bilerp(gx, a, w, fx, fy);
        const ey = gain * bilerp(gy, a, w, fx, fy);
        J[0] = ex;
        J[1] = ey;
        J[2] = (ex * (x - cx)) / span;
        J[3] = (ey * (y - cy)) / span;
        J[4] = R;
        J[5] = 1;
        for (let k = 0; k < 6; k++) {
          const jk = rw * J[k]!;
          g[k] = g[k]! + jk * r;
          for (let q = k; q < 6; q++) H[k * 6 + q] = H[k * 6 + q]! + jk * J[q]!;
        }
      }
    }
    // Pixels read from outside the result count as the worst, so the fit can't run off the edge.
    const all = count + outside;
    return { cost: count ? (cost + outside * c2) / all : Number.POSITIVE_INFINITY, count };
  };

  let p: Params = [start.tx, start.ty, start.sx, start.sy, 1, 0];
  // The cut comes from the residuals where the fit starts, and holds for this level.
  const first = pass(p, Number.POSITIVE_INFINITY, false);
  if (first.count < 16) return { ...start, confidence: 0 };
  const cut = 4.685 * Math.max(1, 1.4826 * histMedian(hist, first.count) * 0.25);
  let current = pass(p, cut, true).cost;
  for (let iter = 0; iter < 20; iter++) {
    for (let k = 0; k < 6; k++) for (let q = 0; q < k; q++) H[k * 6 + q] = H[q * 6 + k]!;
    for (let k = 0; k < 6; k++) H[k * 6 + k] = H[k * 6 + k]! * 1.01 + 1e-6;
    const step = solve6(H, g);
    if (!step) break;
    // No more than two pixels of movement anywhere per step.
    const reach = Math.max(Math.abs(step[0]!) + Math.abs(step[2]!), Math.abs(step[1]!) + Math.abs(step[3]!));
    const limit = reach > 2 ? 2 / reach : 1;
    let accepted = false;
    for (let shrink = limit; shrink > limit / 16; shrink /= 2) {
      const next: Params = [
        p[0] - step[0]! * shrink,
        p[1] - step[1]! * shrink,
        p[2] - (step[2]! * shrink) / span,
        p[3] - (step[3]! * shrink) / span,
        p[4] - step[4]! * shrink,
        p[5] - step[5]! * shrink,
      ];
      const tried = pass(next, cut, true);
      if (tried.cost < current) {
        p = next;
        current = tried.cost;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
    if (reach * limit < 0.005) break;
  }
  return { tx: p[0], ty: p[1], sx: p[2], sy: p[3], confidence: 0 };
}

const bilerp = (src: Float32Array, a: number, w: number, fx: number, fy: number): number => {
  const top = src[a]! + (src[a + 1]! - src[a]!) * fx;
  const bottom = src[a + w]! + (src[a + w + 1]! - src[a + w]!) * fx;
  return top + (bottom - top) * fy;
};

function histMedian(hist: Uint32Array, count: number): number {
  let seen = 0;
  for (let k = 0; k < hist.length; k++) {
    seen += hist[k]!;
    if (seen * 2 >= count) return k + 0.5;
  }
  return hist.length;
}

/** Solves the 6x6 system by Gaussian elimination with partial pivoting; null when singular. */
function solve6(H: Float64Array, g: Float64Array): Float64Array | null {
  const m = new Float64Array(42);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) m[r * 7 + c] = H[r * 6 + c]!;
    m[r * 7 + 6] = g[r]!;
  }
  for (let c = 0; c < 6; c++) {
    let pivot = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(m[r * 7 + c]!) > Math.abs(m[pivot * 7 + c]!)) pivot = r;
    if (Math.abs(m[pivot * 7 + c]!) < 1e-12) return null;
    if (pivot !== c)
      for (let k = 0; k < 7; k++) {
        const t = m[c * 7 + k]!;
        m[c * 7 + k] = m[pivot * 7 + k]!;
        m[pivot * 7 + k] = t;
      }
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const f = m[r * 7 + c]! / m[c * 7 + c]!;
      if (!f) continue;
      for (let k = c; k < 7; k++) m[r * 7 + k] = m[r * 7 + k]! - f * m[c * 7 + k]!;
    }
  }
  const out = new Float64Array(6);
  for (let r = 0; r < 6; r++) out[r] = m[r * 7 + 6]! / m[r * 7 + r]!;
  return out;
}

/**
 * Correlation of the detail (a band: each image lightly blurred, less a wider blur) away from the
 * mask, once moved. The band skips the finest grain, which a model never copies, and the broad
 * shading, which a colour cast moves.
 */
function detailMatch(l: Level, fit: Omit<Fit, "confidence">): number {
  const moved = warpFloat(l.result, l.w, l.h, 1, fit);
  const db = detail(l.base, l.w, l.h);
  const dr = detail(moved, l.w, l.h);
  let sbb = 0;
  let srr = 0;
  let sbr = 0;
  for (let i = 0; i < db.length; i++) {
    if (!l.weight[i]) continue;
    sbb += db[i]! * db[i]!;
    srr += dr[i]! * dr[i]!;
    sbr += db[i]! * dr[i]!;
  }
  return sbb > 0 && srr > 0 ? sbr / Math.sqrt(sbb * srr) : 0;
}

function detail(src: Float32Array, w: number, h: number): Float32Array {
  const fine = blurPlane(src, w, h);
  let wide = fine;
  for (let k = 0; k < 4; k++) wide = blurPlane(wide, w, h);
  for (let i = 0; i < fine.length; i++) fine[i] = fine[i]! - wide[i]!;
  return fine;
}

/** A 3x3 binomial blur of one plane, edges held. */
function blurPlane(src: Float32Array, w: number, h: number): Float32Array {
  const across = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++)
      across[row + x] =
        (src[row + Math.max(0, x - 1)]! + 2 * src[row + x]! + src[row + Math.min(w - 1, x + 1)]!) / 4;
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const row = y * w;
    const down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++)
      out[row + x] = (across[up + x]! + 2 * across[row + x]! + across[down + x]!) / 4;
  }
  return out;
}

/** `src` (channels per pixel) read at each pixel's lined-up place, edges held. */
function warpFloat(src: Float32Array, w: number, h: number, channels: number, fit: Omit<Fit, "confidence">) {
  const out = new Float32Array(src.length);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const v = clamp(fit.sy * (y - cy) + cy + fit.ty, 0, h - 1);
    const y0 = Math.min(Math.max(0, h - 2), Math.floor(v));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = v - y0;
    for (let x = 0; x < w; x++) {
      const u = clamp(fit.sx * (x - cx) + cx + fit.tx, 0, w - 1);
      const x0 = Math.min(Math.max(0, w - 2), Math.floor(u));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = u - x0;
      for (let k = 0; k < channels; k++) {
        const a = src[(y0 * w + x0) * channels + k]!;
        const b = src[(y0 * w + x1) * channels + k]!;
        const c = src[(y1 * w + x0) * channels + k]!;
        const d = src[(y1 * w + x1) * channels + k]!;
        const top = a + (b - a) * fx;
        out[(y * w + x) * channels + k] = top + (c + (d - c) * fx - top) * fy;
      }
    }
  }
  return out;
}

/** The analysis fit in the original's pixels, about the original's centre. */
function toFullSize(fit: Fit, f: number, aw: number, ah: number, width: number, height: number): LineUp {
  // An analysis pixel's centre sits at f * a + (f - 1) / 2 in the original, so its centre does too.
  const acx = (f * aw - 1) / 2;
  const acy = (f * ah - 1) / 2;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  return {
    dx: f * fit.tx + (1 - fit.sx) * (acx - cx),
    dy: f * fit.ty + (1 - fit.sy) * (acy - cy),
    scaleX: fit.sx,
    scaleY: fit.sy,
    confidence: Math.max(0, Math.min(1, fit.confidence)),
  };
}

// What changed.

/** A 3x3 binomial blur of RGBA floats, so fine grain and sharpening halos don't count as change. */
function blur(src: Float32Array, w: number, h: number): Float32Array {
  const across = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = (y * w + Math.max(0, x - 1)) * 4;
      const c = (y * w + x) * 4;
      const r = (y * w + Math.min(w - 1, x + 1)) * 4;
      for (let k = 0; k < 4; k++) across[c + k] = (src[l + k]! + 2 * src[c + k]! + src[r + k]!) / 4;
    }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (Math.max(0, y - 1) * w + x) * 4;
      const c = (y * w + x) * 4;
      const b = (Math.min(h - 1, y + 1) * w + x) * 4;
      for (let k = 0; k < 4; k++) out[c + k] = (across[t + k]! + 2 * across[c + k]! + across[b + k]!) / 4;
    }
  return out;
}

/**
 * Per pixel, the colour distance between the result and the original after a per-channel gain and
 * offset fitted away from the mask take out the model's overall colour drift.
 */
function differenceOf(
  base: Float32Array,
  result: Float32Array,
  weight: Float32Array,
  n: number,
): Float32Array {
  const gain = [1, 1, 1, 1];
  const offset = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    // Least squares, then twice more with residuals past a cut given less say (Huber).
    let cut = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < 3; pass++) {
      let sw = 0;
      let sb = 0;
      let sr = 0;
      let sbb = 0;
      let sbr = 0;
      let abs = 0;
      for (let p = 0; p < n; p++) {
        if (!weight[p]) continue;
        const b = base[p * 4 + k]!;
        const r = result[p * 4 + k]!;
        const e = Math.abs(gain[k]! * b + offset[k]! - r);
        abs += e;
        const wt = e > cut ? cut / e : 1;
        sw += wt;
        sb += wt * b;
        sr += wt * r;
        sbb += wt * b * b;
        sbr += wt * b * r;
      }
      if (sw < 1) break;
      const vb = sbb - (sb * sb) / sw;
      const g = vb > sw * 1e-3 ? (sbr - (sb * sr) / sw) / vb : 1;
      gain[k] = clamp(g, 0.7, 1.4);
      offset[k] = (sr - gain[k]! * sb) / sw;
      cut = Math.max(1, (1.5 * abs) / Math.max(1, sw));
    }
  }
  const out = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const e = result[i + k]! - (gain[k]! * base[i + k]! + offset[k]!);
      sum += e * e;
    }
    const a = result[i + 3]! - (gain[3]! * base[i + 3]! + offset[3]!);
    out[p] = Math.sqrt(sum / 3) + 0.5 * Math.abs(a);
  }
  return out;
}

/** The median difference away from the mask, and its spread (1.4826 x the median absolute deviation). */
function noiseOf(difference: Float32Array, near: Uint8Array): { median: number; spread: number } {
  const bins = 2560;
  const step = 0.1;
  const hist = new Uint32Array(bins);
  let count = 0;
  for (let i = 0; i < difference.length; i++) {
    if (near[i]) continue;
    hist[Math.min(bins - 1, Math.floor(difference[i]! / step))]!++;
    count++;
  }
  if (!count) return { median: 0, spread: 0 };
  const median = (histMedian(hist, count) - 0.5 + 0.5) * step;
  hist.fill(0);
  for (let i = 0; i < difference.length; i++) {
    if (near[i]) continue;
    hist[Math.min(bins - 1, Math.floor(Math.abs(difference[i]! - median) / step))]!++;
  }
  const mad = histMedian(hist, count) * step;
  return { median, spread: 1.4826 * mad };
}

// Deciding the area.

/** Changes reaching the mask smaller than this many analysis pixels are grain, not change. */
const MIN_TOUCHING = 4;

/**
 * The changed regions to keep: each connected run of changes (8 neighbours) is kept when it reaches
 * the grown mask and is more than a speck, or when it holds at least `minArea` clear changes.
 */
function keptRegions(
  low: Uint8Array,
  high: Uint8Array,
  seeded: Uint8Array,
  w: number,
  h: number,
  minArea: number,
): Uint8Array {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const keep = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members: number[] = [];
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (!low[start] || label[start] !== -1) continue;
    const id = next++;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    let touches = false;
    let clear = 0;
    members.length = 0;
    while (top) {
      const p = stack[--top]!;
      members.push(p);
      if (seeded[p]) touches = true;
      if (high[p]) clear++;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (!dx && !dy)) continue;
          const q = yy * w + xx;
          if (low[q] && label[q] === -1) {
            label[q] = id;
            stack[top++] = q;
          }
        }
      }
    }
    if ((touches && members.length >= MIN_TOUCHING) || clear >= minArea) for (const p of members) keep[p] = 1;
  }
  return keep;
}

/** Fills holes in the kept area (4 neighbours, not reaching the edge) smaller than `maxArea`. */
function fillHoles(keep: Uint8Array, w: number, h: number, maxArea: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (keep[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let edge = false;
    members.length = 0;
    while (top) {
      const p = stack[--top]!;
      if (members.length <= maxArea) members.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      const around = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of around) {
        if (q < 0 || keep[q] || seen[q]) continue;
        seen[q] = 1;
        stack[top++] = q;
      }
    }
    if (!edge && members.length <= maxArea) for (const p of members) keep[p] = 1;
  }
}

/** One pixel more all round, so a change's soft edge comes with it. */
function dilate(src: Uint8Array, w: number, h: number): Uint8Array {
  return grow(src, w, h, 1);
}

/** The analysis decision at full size: bilinear, then halfway, so its edges follow the shapes. */
function upsample(
  keep: Uint8Array,
  aw: number,
  ah: number,
  f: number,
  width: number,
  height: number,
): Uint8Array {
  // Alpha as everywhere: 0 takes the model, 255 keeps the original.
  const out = new Uint8Array(width * height).fill(255);
  const x0s = new Int32Array(width);
  const x1s = new Int32Array(width);
  const fxs = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const ax = clamp((x + 0.5) / f - 0.5, 0, aw - 1);
    x0s[x] = Math.floor(ax);
    x1s[x] = Math.min(aw - 1, x0s[x]! + 1);
    fxs[x] = ax - x0s[x]!;
  }
  for (let y = 0; y < height; y++) {
    const ay = clamp((y + 0.5) / f - 0.5, 0, ah - 1);
    const y0 = Math.floor(ay);
    const y1 = Math.min(ah - 1, y0 + 1);
    const fy = ay - y0;
    const r0 = y0 * aw;
    const r1 = y1 * aw;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = keep[r0 + x0s[x]!]!;
      const b = keep[r0 + x1s[x]!]!;
      const c = keep[r1 + x0s[x]!]!;
      const d = keep[r1 + x1s[x]!]!;
      if (a + b + c + d === 0) continue;
      if (a & b & c & d) {
        out[row + x] = 0;
        continue;
      }
      const fx = fxs[x]!;
      const top = a + (b - a) * fx;
      const v = top + (c + (d - c) * fx - top) * fy;
      if (v >= 0.5) out[row + x] = 0;
    }
  }
  return out;
}

/** An alpha with fixes painted in: the model's pixels change (0), the original's keep (255). */
function withFixes(alpha: Uint8Array, fixes: Uint8Array): Uint8Array {
  for (let i = 0; i < alpha.length; i++) {
    if (fixes[i] === FIX_MODEL) alpha[i] = 0;
    else if (fixes[i] === FIX_ORIGINAL) alpha[i] = 255;
  }
  return alpha;
}

function featheredFrom(
  alpha: Uint8Array,
  width: number,
  height: number,
  settings: Pick<KeepRestSettings, "featherPx">,
  fixes?: Uint8Array,
): Uint8Array {
  const weights = weightsFromAlpha(alpha, width, height, { expandPx: 0, featherPx: settings.featherPx });
  if (fixes) for (let i = 0; i < weights.length; i++) if (fixes[i] === FIX_ORIGINAL) weights[i] = 0;
  return weights;
}

function share(weights: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i]!;
  return weights.length ? sum / (255 * weights.length) : 0;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

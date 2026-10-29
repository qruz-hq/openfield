import sharp from "sharp";

// Images for masked edit tests, and the check that an edit kept the original outside its mask.

/**
 * Coarse seeded noise. A value may match the base by chance, but the checks compare against the
 * base directly, so chance matches can't hide a pixel copied from the wrong place. 16 levels
 * keep a 4K PNG under the upload limit; `cell` repeats each value over a square of pixels, for
 * bigger images still.
 */
export async function texture(
  width: number,
  height: number,
  opts: { format?: "png" | "jpeg"; cell?: number } = {},
): Promise<Uint8Array> {
  const cell = opts.cell ?? 1;
  const cols = Math.ceil(width / cell);
  const noise = new Uint8Array(cols * Math.ceil(height / cell) * 3);
  let s = width ^ height;
  for (let i = 0; i < noise.length; i++) {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    noise[i] = (s >>> 28) * 17;
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / cell) * cols + Math.floor(x / cell)) * 3;
      rgb.set(noise.subarray(from, from + 3), (y * width + x) * 3);
    }
  const image = sharp(rgb, { raw: { width, height, channels: 3 } });
  return new Uint8Array(await (opts.format === "jpeg" ? image.jpeg() : image.png()).toBuffer());
}

/** An RGBA PNG mask, transparent (the area to change) in its top-left quarter. */
export async function quarterMask(width: number, height: number): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) rgba[(y * width + x) * 4 + 3] = 0;
  return new Uint8Array(
    await sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

export interface Kept {
  /** Both decode to the same width, height and channel count. */
  sameShape: boolean;
  /** Pixels farther than `reach` from the quarter that differ from the base. Must be 0. */
  outside: number;
  /** Pixels inside the quarter that differ from the base. */
  inside: number;
  /** Pixels inside the quarter. */
  quarter: number;
}

/**
 * Compares two image files' decoded pixels around the top-left quarter that quarterMask marks:
 * every value farther than `reach` (expand plus feather) from it must be the base's own.
 */
export async function keptOutside(baseFile: string, resultFile: string, reach: number): Promise<Kept> {
  const decode = (file: string) => sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { data: base, info } = await decode(baseFile);
  const { data: made, info: madeInfo } = await decode(resultFile);
  const { width, height, channels } = info;
  const sameShape = madeInfo.width === width && madeInfo.height === height && madeInfo.channels === channels;
  const holeW = Math.ceil(width / 2);
  const holeH = Math.ceil(height / 2);
  const kept: Kept = { sameShape, outside: 0, inside: 0, quarter: holeW * holeH };
  if (!sameShape) return kept;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      let same = true;
      for (let c = 0; c < channels; c++)
        if (base[i + c] !== made[i + c]) {
          same = false;
          break;
        }
      if (same) continue;
      const dx = Math.max(0, x - (holeW - 1));
      const dy = Math.max(0, y - (holeH - 1));
      if (dx === 0 && dy === 0) kept.inside++;
      else if (dx * dx + dy * dy > reach * reach) kept.outside++;
    }
  return kept;
}

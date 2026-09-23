import {
  type AspectRatio,
  type Capabilities,
  type PixelSize,
  RESOLUTION_TIER_PX,
  type ResolutionTier,
} from "@openfield/core";

// Size resolution (§6.5 step 3). Pure, shared by normalize(), adapters and the composer.

/** "3:4" as width over height. "auto" has no shape of its own, so it reads as square. */
export function ratioValue(ratio: AspectRatio): number {
  if (ratio === "auto") return 1;
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  return w / h;
}

export interface ResolveSizeOptions {
  multipleOf?: number;
  minEdge?: number;
  maxEdge?: number;
}

/**
 * Long edge = the tier's pixels, short edge = long × ratio, snapped down to `multipleOf`, then
 * clamped for free-size models. 3:4 at 2K → 1536×2048.
 */
export function resolveSize(
  ratio: AspectRatio,
  tier: ResolutionTier,
  opts: ResolveSizeOptions = {},
): PixelSize {
  const multiple = opts.multipleOf ?? 1;
  const clamp = (edge: number) =>
    Math.min(opts.maxEdge ?? Number.POSITIVE_INFINITY, Math.max(opts.minEdge ?? multiple, edge));
  const snap = (edge: number) => Math.max(multiple, Math.floor(edge / multiple) * multiple);

  const long = clamp(snap(RESOLUTION_TIER_PX[tier]));
  const value = ratioValue(ratio);
  const short = clamp(snap(long * Math.min(value, 1 / value)));
  return value >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/** The declared ratio closest in shape to a width and height. Ties go to the wider one. */
export function nearestRatio(
  width: number,
  height: number,
  ratios: readonly AspectRatio[],
): AspectRatio | undefined {
  const target = Math.log(width / height);
  let best: AspectRatio | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of ratios) {
    if (ratio === "auto") continue;
    const distance = Math.abs(Math.log(ratioValue(ratio)) - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best && ratioValue(ratio) > ratioValue(best))
    ) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The pixel size a run will roughly come out at, so placeholders reserve the right shape before
 * any provider call. Aspect-mode models report exact pixels only in their output.
 */
export function placeholderSize(
  caps: Capabilities,
  size: PixelSize | { aspect: AspectRatio },
  tier?: ResolutionTier,
): PixelSize {
  if ("width" in size) return { width: size.width, height: size.height };
  const resolvedTier = tier ?? caps.resolution?.default ?? "1K";
  return resolveSize(size.aspect, resolvedTier);
}

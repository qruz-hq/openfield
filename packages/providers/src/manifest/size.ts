import {
  type AspectRatio,
  type Capabilities,
  type ModelManifest,
  type PixelRules,
  type PixelSize,
  RESOLUTION_TIER_PX,
  type ResolutionTier,
  type SizeSpec,
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

/** Whether a model with these rules takes exactly this size. */
export function fitsPixelRules(width: number, height: number, rules: PixelRules): boolean {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return (
    width % rules.multipleOf === 0 &&
    height % rules.multipleOf === 0 &&
    long <= rules.maxEdge &&
    long / short <= rules.maxRatio &&
    width * height >= rules.minPixels &&
    width * height <= rules.maxPixels
  );
}

/**
 * The size a model with these rules takes that's closest to `width` × `height`: the size itself
 * when it's allowed, else the same shape (no wider than the rules allow), grown or shrunk into the
 * pixel limits and snapped to the grid, changing either edge as little as it can. Ties go to the
 * larger size, so an edit is scaled down to fit back, not up.
 */
export function fitPixels(width: number, height: number, rules: PixelRules): PixelSize {
  if (fitsPixelRules(width, height, rules)) return { width, height };
  const m = rules.multipleOf;
  const shape = Math.min(rules.maxRatio, Math.max(1 / rules.maxRatio, width / height));
  const area = Math.min(rules.maxPixels, Math.max(rules.minPixels, width * height));
  let targetW = Math.sqrt(area * shape);
  let targetH = Math.sqrt(area / shape);
  const over = Math.max(targetW, targetH) / rules.maxEdge;
  if (over > 1) {
    targetW /= over;
    targetH /= over;
  }
  const cols = Math.round(targetW / m);
  const rows = Math.round(targetH / m);
  // The legal grid sizes nearby. A wider search only matters for odd rules.
  for (let span = 2; span <= 64; span *= 2) {
    let best: PixelSize | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let dc = -span; dc <= span; dc++) {
      for (let dr = -span; dr <= span; dr++) {
        const w = (cols + dc) * m;
        const h = (rows + dr) * m;
        if (w <= 0 || h <= 0 || !fitsPixelRules(w, h, rules)) continue;
        const cost = Math.max(Math.abs(Math.log(w / targetW)), Math.abs(Math.log(h / targetH)));
        const tie = Math.abs(cost - bestCost) < 1e-12;
        if ((cost < bestCost && !tie) || (tie && best && w * h > best.width * best.height)) {
          best = { width: w, height: h };
          bestCost = cost;
        }
      }
    }
    if (best) return best;
  }
  throw new RangeError(`No size fits these rules near ${width}×${height}`);
}

/**
 * What an edit of an image this size asks a model for, so the result lines up with the base and
 * its mask: the base's shape, at its own pixels where the model takes exact sizes, else its
 * nearest shape. With no `tier`, the smallest that covers the base's long edge, so the edited area
 * isn't scaled down. With one, the base's shape is scaled so its long edge is the tier's, as a run
 * at that tier would come out, and the size sent is the size priced.
 */
export function editSizeFor(
  manifest: Pick<ModelManifest, "capabilities">,
  base: PixelSize,
  tier?: ResolutionTier,
): { size: SizeSpec; resolution?: ResolutionTier } {
  const caps = manifest.capabilities;
  const long = Math.max(base.width, base.height);
  const resolution = tier ?? (caps.resolution && coveringTier(caps.resolution.tiers, long));
  const withTier = resolution ? { resolution } : {};
  // The shape to fit: the base itself, or the base scaled to the tier asked for.
  const scale = tier ? RESOLUTION_TIER_PX[tier] / long : 1;
  const width = Math.max(1, Math.round(base.width * scale));
  const height = Math.max(1, Math.round(base.height * scale));
  const size = caps.size;
  if (size.mode === "aspect") {
    if (size.pixels)
      return { size: { kind: "pixels", ...fitPixels(width, height, size.pixels) }, ...withTier };
    const blocked = caps.partial?.aspect?.unavailable ?? [];
    const ratio = nearestRatio(
      width,
      height,
      size.ratios.filter((r) => !blocked.includes(r)),
    );
    return { size: ratio ? { kind: "aspect", ratio } : { kind: "auto" }, ...withTier };
  }
  if (size.mode === "enum") {
    // The listed size nearest in shape, then in pixel count.
    const target = Math.log(width / height);
    const area = Math.log(width * height);
    const scored = size.sizes.map((s) => ({
      s,
      shape: Math.abs(Math.log(s.width / s.height) - target),
      area: Math.abs(Math.log(s.width * s.height) - area),
    }));
    scored.sort((a, b) => a.shape - b.shape || a.area - b.area);
    const hit = scored[0]!.s;
    return { size: { kind: "pixels", width: hit.width, height: hit.height }, ...withTier };
  }
  // Free size: the shape, scaled into the edges the model takes and snapped to its grid.
  const fit = Math.min(1, size.maxEdge / Math.max(width, height));
  const grow = Math.max(1, size.minEdge / Math.min(width * fit, height * fit));
  const snap = (edge: number) =>
    Math.min(size.maxEdge, Math.max(size.minEdge, Math.round(edge / size.multipleOf) * size.multipleOf));
  return {
    size: { kind: "pixels", width: snap(width * fit * grow), height: snap(height * fit * grow) },
    ...withTier,
  };
}

/** The smallest tier at least `edge` pixels long, else the largest. */
function coveringTier(tiers: readonly ResolutionTier[], edge: number): ResolutionTier | undefined {
  const sorted = [...tiers].sort((a, b) => RESOLUTION_TIER_PX[a] - RESOLUTION_TIER_PX[b]);
  return sorted.find((t) => RESOLUTION_TIER_PX[t] >= edge) ?? sorted.at(-1);
}

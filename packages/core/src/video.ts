import type { VideoResolution } from "./constants";
import type { PriceModel } from "./schemas/cost";

// Video price math (§0.13), shared by estimate() and by an adapter reconciling what a company billed.

/** Output tokens for a video, as the company counts them: width × height × fps × seconds / 1024. */
export const videoTokens = (size: { width: number; height: number }, fps: number, seconds: number): number =>
  (size.width * size.height * fps * seconds) / 1024;

/** The rate for a run: the first row whose resolution and sound match, or that names neither. */
export function videoRate(
  price: Extract<PriceModel, { kind: "video_tokens" }>,
  resolution: VideoResolution,
  audio: boolean | undefined,
): number | undefined {
  return price.rates.find(
    (r) =>
      (r.resolution === undefined || r.resolution === resolution) &&
      (r.audio === undefined || r.audio === (audio ?? false)),
  )?.perMTok;
}

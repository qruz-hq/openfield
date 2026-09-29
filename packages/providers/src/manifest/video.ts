import {
  type AspectRatio,
  type MessageKey,
  type ModelManifest,
  type PixelSize,
  t,
  VIDEO_RESOLUTION_PX,
  type VideoCapability,
  type VideoRequest,
  type VideoResolution,
} from "@openfield/core";
import { ratioValue } from "./size";

// Video settings (§0.3), pure and browser-safe: normalize() freezes a run with them, estimate()
// prices it, and the composer shows the same choices before anything is sent.

/** A video run's settings after the model's rules: every field the model has, filled. */
export interface ResolvedVideo {
  video: VideoRequest & { seconds: number; resolution: VideoResolution };
  /** The ratio to send. A start frame can force "auto" (the frame's own shape). */
  aspect: AspectRatio;
  /** Settings the model can't honour, dropped or moved to the nearest it can. */
  notes: { field: string; message: string; level: "error" | "warning" }[];
}

/**
 * Applies a video model's rules to what was asked. `aspect` is the ratio already checked against
 * the model's ratios. Pure, so the composer can call it on every change.
 */
export function resolveVideo(
  manifest: Pick<ModelManifest, "displayName" | "capabilities">,
  asked: VideoRequest | undefined,
  aspect: AspectRatio,
): ResolvedVideo {
  const caps = manifest.capabilities.video;
  if (!caps) throw new RangeError(`${manifest.displayName} doesn't make videos`);
  const model = manifest.displayName;
  const notes: ResolvedVideo["notes"] = [];
  const warn = (field: string, message: string) => notes.push({ field, message, level: "warning" });
  const unsupported = (field: string, label: MessageKey) =>
    warn(field, t("composer.unsupported", { model, setting: t(label) }));

  let seconds = caps.defaultDuration;
  if (asked?.seconds !== undefined) {
    seconds = nearestDuration(caps.durations, asked.seconds);
    if (seconds !== asked.seconds) unsupported("video.seconds", "video.chips.duration.label");
  }

  let resolution = caps.defaultResolution;
  if (asked?.resolution) {
    if (caps.resolutions.includes(asked.resolution)) resolution = asked.resolution;
    else unsupported("video.resolution", "video.chips.resolution.label");
  }

  const video: ResolvedVideo["video"] = { seconds, resolution };

  if (caps.audio.supported) video.audio = asked?.audio ?? caps.audio.default;
  else if (asked?.audio) warn("video.audio", t("video.chips.sound.unsupported", { model }));

  if (caps.cameraFixed) video.cameraFixed = asked?.cameraFixed ?? false;
  else if (asked?.cameraFixed) warn("video.cameraFixed", t("video.chips.cameraFixed.unsupported", { model }));

  if (asked?.startFrame) {
    if (caps.frames.start) video.startFrame = asked.startFrame;
    else unsupported("video.startFrame", "video.chips.startFrame.label");
  }
  if (asked?.endFrame) {
    if (!video.startFrame) {
      notes.push({
        field: "video.endFrame",
        message: t("video.chips.endFrame.needsStart"),
        level: "error",
      });
    } else if (caps.frames.end) {
      video.endFrame = asked.endFrame;
    } else {
      warn("video.endFrame", t("video.chips.endFrame.unsupported", { model }));
    }
  }

  let ratio = aspect;
  if (video.startFrame && caps.startFrameForcesAuto) {
    ratio = "auto";
  } else if (ratio === "auto" && caps.autoAspect === "with_start_frame" && !video.startFrame) {
    // Without a frame to take the shape from, the model needs a ratio of its own.
    const size = manifest.capabilities.size;
    ratio = size.mode === "aspect" && size.default !== "auto" ? size.default : "16:9";
    warn("size", t("video.autoNeedsFrame", { model }));
  }
  return { video, aspect: ratio, notes };
}

/** The closest duration the model makes; a tie goes to the longer one. */
export function nearestDuration(durations: readonly number[], seconds: number): number {
  let best = durations[0]!;
  for (const d of durations) {
    if (
      Math.abs(d - seconds) < Math.abs(best - seconds) ||
      (Math.abs(d - seconds) === Math.abs(best - seconds) && d > best)
    ) {
      best = d;
    }
  }
  return best;
}

/** The exact pixels a resolution and ratio come out at, or undefined for "auto" and unknown pairs. */
export function videoSize(
  caps: VideoCapability,
  resolution: VideoResolution,
  aspect: AspectRatio,
): PixelSize | undefined {
  const hit = caps.sizes.find((s) => s.resolution === resolution && s.aspect === aspect);
  return hit && { width: hit.width, height: hit.height };
}

/** Every size the resolution can come out at: what "auto" could be. */
export const videoSizes = (caps: VideoCapability, resolution: VideoResolution): PixelSize[] =>
  caps.sizes.filter((s) => s.resolution === resolution).map((s) => ({ width: s.width, height: s.height }));

/**
 * Roughly the size a video comes out at before the exact table is known, for placeholders: the
 * resolution's short edge, and the ratio's long one. "auto" reads as 16:9.
 */
export function plannedVideoSize(aspect: AspectRatio, resolution: VideoResolution): PixelSize {
  const short = VIDEO_RESOLUTION_PX[resolution];
  const value = aspect === "auto" ? 16 / 9 : ratioValue(aspect);
  const long = Math.round(short * Math.max(value, 1 / value));
  return value >= 1 ? { width: long, height: short } : { width: short, height: long };
}

export { videoRate, videoTokens } from "@openfield/core";

import { type NormalizedRequest, VIDEO_JOB_DEADLINE_MS } from "@openfield/core";
import { SEED_RANGE, type SeedanceSpec, wireRatio } from "./capabilities";

// NormalizedRequest to the body of POST /contents/generations/tasks. Pure, so golden tests can
// snapshot it. Frames arrive already read, as data URLs, because the request only names their ids.

export type SeedanceContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" };

export interface SeedanceBody {
  model: string;
  content: SeedanceContent[];
  resolution: string;
  ratio: string;
  duration: number;
  seed?: number;
  camera_fixed?: boolean;
  generate_audio?: boolean;
  watermark: false;
  return_last_frame: true;
  execution_expires_after: number;
}

/** The frames' data URLs, in the order the body lists them. */
export interface FrameUrls {
  start?: string;
  end?: string;
}

/**
 * BytePlus drops a task still waiting after this long, so one Openfield stopped waiting for is
 * never made and billed later. Seconds, within BytePlus's [3600, 259200].
 */
export const EXPIRES_AFTER_S = Math.min(259_200, Math.max(3_600, Math.round(VIDEO_JOB_DEADLINE_MS / 1000)));

export function toSeedanceBody(spec: SeedanceSpec, req: NormalizedRequest, frames: FrameUrls): SeedanceBody {
  const video = req.video;
  if (!video?.seconds || !video.resolution)
    throw new RangeError("A video request needs its seconds and resolution");
  const content: SeedanceContent[] = [];
  const prompt = req.promptAfterPreset.trim();
  if (prompt) content.push({ type: "text", text: prompt });
  if (frames.start)
    content.push({ type: "image_url", image_url: { url: frames.start }, role: "first_frame" });
  if (frames.start && frames.end && spec.endFrame) {
    content.push({ type: "image_url", image_url: { url: frames.end }, role: "last_frame" });
  }

  const aspect = "aspect" in req.size ? req.size.aspect : "auto";
  const body: SeedanceBody = {
    model: spec.modelId,
    content,
    resolution: video.resolution,
    ratio: wireRatio(aspect) ?? "adaptive",
    duration: video.seconds,
    watermark: false,
    // The poster, when Openfield can't take the first frame itself (no ffmpeg).
    return_last_frame: true,
    execution_expires_after: EXPIRES_AFTER_S,
  };
  if (spec.audio && typeof video.audio === "boolean") body.generate_audio = video.audio;
  if (spec.seedAndCamera) {
    if (typeof req.seed === "number") {
      // Openfield's random seeds run to 2^32; folding keeps them spread instead of piling on the top.
      const [low, high] = SEED_RANGE;
      body.seed = low + (Math.trunc(Math.abs(req.seed)) % (high - low + 1));
    }
    body.camera_fixed = video.cameraFixed ?? false;
  }
  return body;
}

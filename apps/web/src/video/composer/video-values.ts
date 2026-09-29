import {
  type AspectRatio,
  type CostEstimate,
  type GenerateBody,
  type ModelListItem,
  type PixelSize,
  type SpeedId,
  t,
  VIDEO_RESOLUTION_PX,
  type VideoResolution,
} from "@openfield/core";
import {
  aspectLabel,
  estimate,
  isPricePending,
  nearestDuration,
  nearestRatio,
  plannedVideoSize,
  type ResolvedVideo,
  resolveVideo,
} from "@openfield/providers/manifest";

// Pure video composer logic (mirrors @openfield/providers/manifest's image controls.ts): which
// value each chip shows, what a run sends, and what it costs. No React, so it's unit tested like
// the image composer's. Unset values mean "the model's own default" (§0.3).

export interface VideoComposerValues {
  aspect?: AspectRatio;
  resolution?: VideoResolution;
  seconds?: number;
  sound?: boolean;
  startFrame?: { assetId: string };
  endFrame?: { assetId: string };
}

/** The aspect ratio to resolve against: the person's choice when this model offers it, else its default. */
function pickAspect(model: ModelListItem, aspect: AspectRatio | undefined): AspectRatio {
  const size = model.capabilities.size;
  if (size.mode !== "aspect") return "16:9";
  return aspect && size.ratios.includes(aspect) ? aspect : size.default;
}

/** What each chip shows and a run sends for this model, after its rules (auto-aspect, unsupported settings). */
export function resolveFor(model: ModelListItem, values: VideoComposerValues): ResolvedVideo {
  return resolveVideo(
    model,
    {
      ...(values.seconds !== undefined && { seconds: values.seconds }),
      ...(values.resolution && { resolution: values.resolution }),
      ...(values.sound !== undefined && { audio: values.sound }),
      ...(values.startFrame && { startFrame: values.startFrame }),
      ...(values.endFrame && { endFrame: values.endFrame }),
    },
    pickAspect(model, values.aspect),
  );
}

/** About how big the video comes out, so its placeholder reserves the right shape. */
export function expectedVideoSize(resolved: ResolvedVideo): PixelSize {
  return plannedVideoSize(resolved.aspect, resolved.video.resolution);
}

export function videoGenerateBody(
  model: ModelListItem,
  resolved: ResolvedVideo,
  prompt: string,
  idempotencyKey: string,
): GenerateBody {
  const { video, aspect } = resolved;
  return {
    idempotencyKey,
    model: model.key,
    op: "generate",
    prompt: prompt.trim(),
    size: aspect === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: aspect },
    batch: 1,
    seed: null,
    video,
    source: "composer",
  };
}

/** One video's price at this model's settings and company speed. */
export function estimateVideoRun(
  model: ModelListItem,
  resolved: ResolvedVideo,
  prompt: string,
  speed: SpeedId = "standard",
): CostEstimate {
  const { video, aspect } = resolved;
  return estimate(model, {
    batch: 1,
    size: aspect === "auto" ? { aspect: "auto" } : { aspect },
    video,
    prompt,
    speed,
  });
}

export type VideoGenerateState =
  | { kind: "no-key" }
  | { kind: "needs-key"; model: ModelListItem }
  | { kind: "blocked"; reason: string; estimate?: CostEstimate }
  | { kind: "ready"; estimate?: CostEstimate | undefined };

export function videoGenerateState(input: {
  model: ModelListItem | undefined;
  anyReady: boolean;
  prompt: string;
  resolved: ResolvedVideo | undefined;
  speed?: SpeedId;
}): VideoGenerateState {
  const { model, anyReady, prompt, resolved, speed } = input;
  if (!model)
    return anyReady ? { kind: "blocked", reason: t("composer.generate.noModel") } : { kind: "no-key" };
  if (!model.ready) return { kind: "needs-key", model };
  const asked = resolved ? estimateVideoRun(model, resolved, prompt, speed) : undefined;
  const cost = isPricePending(asked) ? undefined : asked;
  // An end frame with no start frame is refused server-side; the chip stops it here first.
  const endWithoutStart = resolved?.notes.some((n) => n.field === "video.endFrame" && n.level === "error");
  if (endWithoutStart)
    return { kind: "blocked", reason: t("video.chips.endFrame.needsStart"), estimate: cost };
  if (!prompt.trim() && !resolved?.video.startFrame) {
    return { kind: "blocked", reason: t("composer.generate.emptyPromptVideo"), estimate: cost };
  }
  return { kind: "ready", estimate: cost };
}

export interface VideoAdjustment {
  from: string;
  to: string;
}

/**
 * Carry, then clamp (§3.5.1, like the image composer's carryValues): only values the person set
 * explicitly move to a new model, and one it can't take moves to its nearest. Frames always carry
 * (whether they still fit is checked when the run is sent, the same as any other model switch).
 */
export function carryVideoValues(
  to: ModelListItem,
  values: VideoComposerValues,
): { values: VideoComposerValues; adjusted: VideoAdjustment[] } {
  const caps = to.capabilities.video;
  const next: VideoComposerValues = {};
  const adjusted: VideoAdjustment[] = [];
  if (!caps) return { values: next, adjusted };

  if (values.aspect) {
    const ratios = to.capabilities.size.mode === "aspect" ? to.capabilities.size.ratios : [];
    if (ratios.includes(values.aspect)) next.aspect = values.aspect;
    else if (values.aspect !== "auto") {
      const [w, h] = values.aspect.split(":").map(Number) as [number, number];
      const clamped = nearestRatio(w, h, ratios);
      if (clamped) {
        next.aspect = clamped;
        adjusted.push({ from: aspectLabel(values.aspect), to: aspectLabel(clamped) });
      }
    }
  }

  if (values.resolution) {
    if (caps.resolutions.includes(values.resolution)) next.resolution = values.resolution;
    else {
      const px = VIDEO_RESOLUTION_PX[values.resolution];
      const below = caps.resolutions
        .filter((r) => VIDEO_RESOLUTION_PX[r] <= px)
        .sort((a, b) => VIDEO_RESOLUTION_PX[b] - VIDEO_RESOLUTION_PX[a]);
      const clamped = below[0] ?? caps.resolutions[0]!;
      next.resolution = clamped;
      adjusted.push({ from: values.resolution, to: clamped });
    }
  }

  if (values.seconds !== undefined) {
    const clamped = nearestDuration(caps.durations, values.seconds);
    next.seconds = clamped;
    if (clamped !== values.seconds) {
      adjusted.push({
        from: t("video.duration", { seconds: values.seconds }),
        to: t("video.duration", { seconds: clamped }),
      });
    }
  }

  if (values.sound !== undefined && caps.audio.supported) next.sound = values.sound;

  return { values: next, adjusted };
}

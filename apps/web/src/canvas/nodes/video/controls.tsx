import type { VideoParams } from "@openfield/canvas/nodes/video/spec";
import { type AspectRatio, type ModelListItem, t } from "@openfield/core";
import { aspectLabel, resolveControl } from "@openfield/providers/manifest";
import { AspectGlyph } from "@openfield/ui";
import { aspectChoices } from "../../../lib/control-choices";
import type { SizeControl } from "../generate/controls";

// The Video inspector's size chips: Aspect (shared plumbing with images, resolveControl()), then
// Resolution and Length, read straight from the model's own video capabilities (§0.3), never a
// house list. Sound, Still camera and Seed live in Advanced (video-inspector.tsx): they're
// switches and a seed field, not option lists, so they don't belong here.

const sizeFromAspect = (aspect: string): VideoParams["size"] =>
  aspect === "auto" ? { kind: "auto" } : { kind: "aspect", ratio: aspect as AspectRatio };

export function videoControls(model: ModelListItem | undefined, params: VideoParams): SizeControl[] {
  const caps = model?.capabilities.video;
  if (!model || !caps) return [];
  const out: SizeControl[] = [];

  const aspectControl = resolveControl(model.capabilities, "aspect");
  if (aspectControl.state !== "absent" && aspectControl.state !== "unsupported") {
    const asked: AspectRatio =
      params.size?.kind === "aspect" ? params.size.ratio : params.size?.kind === "auto" ? "auto" : "16:9";
    const ratios = model.capabilities.size.mode === "aspect" ? model.capabilities.size.ratios : [];
    const value = ratios.includes(asked)
      ? asked
      : model.capabilities.size.mode === "aspect"
        ? model.capabilities.size.default
        : "16:9";
    out.push({
      id: "aspect",
      label: t("composer.chips.aspect.label"),
      value,
      valueLabel: aspectLabel(value),
      options: aspectChoices(aspectControl).map((choice) => ({
        ...choice,
        leading: <AspectGlyph ratio={choice.value} />,
      })),
      patch: (value): Partial<VideoParams> => ({ size: sizeFromAspect(value) }),
    });
  }

  const resolution =
    params.resolution && caps.resolutions.includes(params.resolution)
      ? params.resolution
      : caps.defaultResolution;
  out.push({
    id: "resolution",
    label: t("composer.chips.resolution.label"),
    value: resolution,
    valueLabel: resolution,
    options: caps.resolutions.map((r) => ({ value: r, title: r })),
    patch: (value): Partial<VideoParams> => ({ resolution: value as VideoParams["resolution"] }),
  });

  const seconds =
    params.seconds !== undefined && caps.durations.includes(params.seconds)
      ? params.seconds
      : caps.defaultDuration;
  out.push({
    id: "duration",
    label: t("video.chips.duration.label"),
    value: String(seconds),
    valueLabel: t("video.chips.duration.value", { seconds }),
    options: caps.durations.map((s) => ({
      value: String(s),
      title: t("video.chips.duration.value", { seconds: s }),
    })),
    patch: (value): Partial<VideoParams> => ({ seconds: Number(value) }),
  });

  return out;
}

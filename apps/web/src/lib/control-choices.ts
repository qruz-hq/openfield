import { type AspectRatio, type ModelListItem, type ResolutionTier, type SpeedId, t } from "@openfield/core";
import type { ControlResolution } from "@openfield/providers/manifest";
import { aspectLabel, estimateRun, type Resolved } from "./controls";
import { tightCost } from "./cost";

// The rows a resolution, quality or aspect chip opens, built once for the composer and the canvas
// nodes so the two never disagree: the model's own options in its order, what can't be picked
// greyed with the reason, and each row's price for one image at the company's speed (§0.3, §3.3).

export interface ControlChoice<V extends string = string> {
  value: V;
  title: string;
  subtitle?: string;
  /** One image at this option, "~$0.13". */
  price?: string;
  disabled?: boolean;
}

const off = (control: ControlResolution, value: string) => control.unavailable?.includes(value) ?? false;

export function resolutionChoices(
  model: ModelListItem,
  control: ControlResolution,
  resolved: Resolved,
  speed: SpeedId = "standard",
): ControlChoice<ResolutionTier>[] {
  return ((control.options ?? []) as ResolutionTier[]).map((tier) => ({
    value: tier,
    title: tier,
    subtitle: off(control, tier) ? control.reason : t(`composer.chips.resolution.tiers.${tier}`),
    price: tightCost(estimateRun(model, { ...resolved, resolution: tier, batch: 1 }, "", speed)),
    disabled: off(control, tier),
  }));
}

export function qualityChoices(
  model: ModelListItem,
  control: ControlResolution,
  resolved: Resolved,
  speed: SpeedId = "standard",
): ControlChoice[] {
  return (model.capabilities.quality?.levels ?? []).map((level) => ({
    value: level.id,
    title: level.label,
    subtitle: off(control, level.id) ? control.reason : level.hint,
    price: tightCost(estimateRun(model, { ...resolved, quality: level.id, batch: 1 }, "", speed)),
    disabled: off(control, level.id),
  }));
}

/** Aspect rows carry no price: every ratio costs the same. The caller adds each row's glyph. */
export function aspectChoices(control: ControlResolution): ControlChoice<AspectRatio>[] {
  return ((control.options ?? []) as AspectRatio[]).map((ratio) => ({
    value: ratio,
    title: aspectLabel(ratio),
    subtitle: off(control, ratio) ? control.reason : undefined,
    disabled: off(control, ratio),
  }));
}

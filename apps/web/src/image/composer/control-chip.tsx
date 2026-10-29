import { type AspectRatio, type Capabilities, type ModelListItem, type SpeedId, t } from "@openfield/core";
import {
  aspectLabel,
  type ComposerValues,
  type ControlResolution,
  qualityLabel,
  type Resolved,
} from "@openfield/providers/manifest";
import { AspectGlyph, StepperChip, Tooltip } from "@openfield/ui";
import {
  Dices,
  Gauge,
  Gem,
  type LucideIcon,
  RectangleHorizontal,
  RectangleVertical,
  Scan,
  Square,
} from "lucide-react";
import { aspectChoices, qualityChoices, resolutionChoices } from "../../lib/control-choices";
import { DisabledChip, OptionChip } from "./option-chip";

// One setting chip in the composer's toolbar (§3.3): aspect, resolution, quality, the batch
// stepper, or Seed's reason when the model has none. It holds no state: the caller passes the
// resolved values and takes changes back, so the Edit view can show the same chips over its own
// settings.

function aspectIcon(ratio: AspectRatio | undefined): LucideIcon {
  if (!ratio || ratio === "auto") return Scan;
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  return w === h ? Square : w > h ? RectangleHorizontal : RectangleVertical;
}

export function ControlChip({
  control,
  caps,
  resolved,
  model,
  speed,
  onValues,
  onBatch,
}: {
  control: ControlResolution & { id: string };
  caps: Capabilities;
  resolved: Resolved;
  /** Prices each option. None picked yet: the lists stay empty, the chip only keeps the bar's shape. */
  model: ModelListItem | undefined;
  speed: SpeedId;
  onValues: (values: ComposerValues) => void;
  onBatch: (batch: number) => void;
}) {
  const unsupported = control.state === "unsupported";
  switch (control.id) {
    case "aspect": {
      const icon = aspectIcon(resolved.aspect);
      const label = resolved.aspect ? aspectLabel(resolved.aspect) : "";
      if (unsupported) return <DisabledChip icon={icon} value={label} reason={control.reason ?? ""} />;
      return (
        <OptionChip
          icon={icon}
          label={t("composer.chips.aspect.label")}
          value={resolved.aspect}
          valueLabel={label}
          width="w-240"
          emulated={control.state === "emulated"}
          options={aspectChoices(control).map((choice) => ({
            ...choice,
            leading: <AspectGlyph ratio={choice.value} />,
          }))}
          onChange={(aspect) => onValues({ aspect })}
        />
      );
    }
    case "resolution": {
      const value = resolved.resolution ?? "";
      if (unsupported) return <DisabledChip icon={Gauge} value={value} reason={control.reason ?? ""} />;
      return (
        <OptionChip
          icon={Gauge}
          label={t("composer.chips.resolution.label")}
          value={resolved.resolution}
          valueLabel={value}
          width="w-240"
          options={model ? resolutionChoices(model, control, resolved, speed) : []}
          onChange={(resolution) => onValues({ resolution })}
        />
      );
    }
    case "quality": {
      const value = resolved.quality ? qualityLabel(caps, resolved.quality) : "";
      if (unsupported) return <DisabledChip icon={Gem} value={value} reason={control.reason ?? ""} />;
      return (
        <OptionChip
          icon={Gem}
          label={t("composer.chips.quality.label")}
          value={resolved.quality}
          valueLabel={value}
          width="w-300"
          options={model ? qualityChoices(model, control, resolved, speed) : []}
          onChange={(quality) => onValues({ quality })}
        />
      );
    }
    case "batch": {
      const emulated = control.state === "emulated";
      const stepper = (
        <StepperChip
          emulated={emulated}
          value={resolved.batch}
          min={1}
          max={control.max ?? caps.batch.max}
          onValueChange={onBatch}
          label={t("composer.chips.batch.label")}
          decrementLabel={t("composer.chips.batch.fewer")}
          incrementLabel={t("composer.chips.batch.more")}
        />
      );
      return emulated ? <Tooltip content={t("composer.chips.batch.emulated")}>{stepper}</Tooltip> : stepper;
    }
    case "seed":
      return unsupported ? (
        <DisabledChip icon={Dices} value={t("composer.chips.seed.label")} reason={control.reason ?? ""} />
      ) : null;
    default:
      // Enhance, Avoid, Background, Advanced and the rest have no popover yet, so no chip.
      return null;
  }
}

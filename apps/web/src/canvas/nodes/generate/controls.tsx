import {
  composerValues,
  resolveFor,
  type SizeParams,
  sizeFromAspect,
} from "@openfield/canvas/nodes/generate/settings";
import { formatLocale, type ModelListItem, type ResolutionTier, type SpeedId, t } from "@openfield/core";
import { aspectLabel, carryValues, qualityLabel, visibleControls } from "@openfield/providers/manifest";
import { AspectGlyph, GroupLabel, Popover, PopoverContent, PopoverTrigger } from "@openfield/ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import {
  aspectChoices,
  type ControlChoice,
  qualityChoices,
  resolutionChoices,
} from "../../../lib/control-choices";
import { focusSelected, Listbox, Option } from "../../../lib/listbox";
import { notify } from "../../../lib/notify";
import { useCanvasStoreApi } from "../../store/context";

// The size chips a node shows, straight from the model's manifest through resolveControl() (§0.3):
// resolution, quality and aspect, never a house list, with the rows the composer's chips open
// (lib/control-choices). Resolution and quality come before aspect, as the canvas designs have it
// (Y5jjx, f6eUuJ: "2K · 3:4"). Shared by the Generate and Variations nodes and the inspector.

/** The canvas order of the size chips (design Y5jjx), whatever order the manifest lists them in. */
const CANVAS_ORDER: readonly SizeControlId[] = ["resolution", "quality", "aspect"];

export type SizeControlId = "resolution" | "quality" | "aspect";

/** A chip's option: the composer's own choice, with an optional glyph in front (the aspect shape). */
export type SizeOption = ControlChoice & { leading?: ReactNode };

export interface SizeControl {
  id: SizeControlId;
  label: string;
  value: string;
  valueLabel: string;
  options: SizeOption[];
  /** The patch that picks an option. */
  patch: (value: string) => Partial<SizeParams>;
}

/** `speed`: what the company's settings resolve to, so each row's price follows it (§0.3). */
export function sizeControls(
  model: ModelListItem | undefined,
  params: SizeParams,
  batch = 1,
  speed: SpeedId = "standard",
): SizeControl[] {
  if (!model) return [];
  const caps = model.capabilities;
  const resolved = resolveFor(model, params, batch);
  const out: SizeControl[] = [];
  for (const control of visibleControls(caps)) {
    // Unsupported core controls stay off the node: there's nothing to pick.
    if (control.state === "unsupported") continue;
    if (control.id === "resolution" && resolved.resolution) {
      out.push({
        id: "resolution",
        label: t("composer.chips.resolution.label"),
        value: resolved.resolution,
        valueLabel: resolved.resolution,
        options: resolutionChoices(model, control, resolved, speed),
        patch: (value) => ({ resolution: value as ResolutionTier }),
      });
    } else if (control.id === "quality" && resolved.quality && caps.quality) {
      out.push({
        id: "quality",
        label: t("composer.chips.quality.label"),
        value: resolved.quality,
        valueLabel: qualityLabel(caps, resolved.quality),
        options: qualityChoices(model, control, resolved, speed),
        patch: (value) => ({ quality: value }),
      });
    } else if (control.id === "aspect" && resolved.aspect) {
      out.push({
        id: "aspect",
        label: t("composer.chips.aspect.label"),
        value: resolved.aspect,
        valueLabel: aspectLabel(resolved.aspect),
        options: aspectChoices(control).map((choice) => ({
          ...choice,
          leading: <AspectGlyph ratio={choice.value} />,
        })),
        patch: (value) => ({ size: sizeFromAspect(value) }),
      });
    }
  }
  return out.sort((a, b) => CANVAS_ORDER.indexOf(a.id) - CANVAS_ORDER.indexOf(b.id));
}

/** The option list a chip or badge opens (Popover / Option rows, as in the composer). */
export function ControlOptions({
  control,
  onPick,
  listRef,
}: {
  control: SizeControl;
  onPick: (value: string) => void;
  listRef: { current: HTMLDivElement | null };
}) {
  return (
    <div ref={listRef} className="flex flex-col gap-2">
      <GroupLabel>{control.label}</GroupLabel>
      <Listbox label={control.label} className="flex flex-col gap-2">
        {control.options.map((option) => (
          <Option
            key={option.value}
            title={option.title}
            subtitle={option.subtitle}
            leading={option.leading}
            price={option.price}
            disabled={option.disabled}
            selected={option.value === control.value}
            onPick={() => onPick(option.value)}
          />
        ))}
      </Listbox>
    </div>
  );
}

/** Badge / Neutral over the preview (design vrrsC: "2K", "3:4"), opening its options. */
export function SizeBadge({
  control,
  onChange,
  disabled,
}: {
  control: SizeControl;
  onChange: (patch: Partial<SizeParams>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t("composer.chips.value", { label: control.label, value: control.valueLabel })}
          className="nodrag flex h-18 cursor-pointer items-center rounded-6 bg-elevated-2 px-6 inset-ring inset-ring-border text-micro font-medium text-text-secondary transition-colors data-[state=open]:inset-ring-accent-line disabled:cursor-default"
        >
          {control.valueLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className={control.id === "quality" ? "w-300" : "w-240"}
        onOpenAutoFocus={focusSelected(list)}
      >
        <ControlOptions
          control={control}
          listRef={list}
          onPick={(value) => {
            onChange(control.patch(value));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const listOf = (items: string[]) =>
  new Intl.ListFormat(formatLocale(), { style: "short", type: "unit" }).format(items);

interface Switchable extends SizeParams {
  model?: string;
  batch?: number;
}

/**
 * A model switch on a node (§3.5.1, like the composer): values the person set carry over, the rest
 * follow the new model, anything it can't do clamps down, and a toast says what changed, with Undo.
 */
export function useModelSwitch(id: string) {
  const store = useCanvasStoreApi();
  return useCallback(
    (from: ModelListItem | undefined, to: ModelListItem, params: Switchable) => {
      const before = {
        model: params.model,
        size: params.size,
        resolution: params.resolution,
        quality: params.quality,
        ...(params.batch !== undefined && { batch: params.batch }),
      };
      const carried = carryValues(
        to.capabilities,
        composerValues(params),
        params.batch ?? 1,
        { quality: qualityLabel },
        from?.capabilities,
      );
      const patch = {
        model: to.key,
        size: carried.values.aspect ? sizeFromAspect(carried.values.aspect) : params.size,
        resolution: carried.values.resolution,
        quality: carried.values.quality,
        ...(params.batch !== undefined && { batch: carried.batch }),
      };
      const { actions } = store.getState();
      actions.apply([{ op: "setParams", id, patch }], { label: "model" });
      if (!carried.adjusted.length) return;
      const changes = listOf(carried.adjusted.map((a) => t("composer.change", { from: a.from, to: a.to })));
      notify(t("composer.adjusted", { count: carried.adjusted.length, model: to.displayName, changes }), {
        duration: 8000,
        action: {
          label: t("actions.undo"),
          onClick: () => store.getState().actions.apply([{ op: "setParams", id, patch: before }]),
        },
      });
    },
    [store, id],
  );
}

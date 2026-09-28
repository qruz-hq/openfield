import { ToggleGroup } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

export const segmentedTrackClass = "flex w-full gap-4 rounded-10 bg-surface p-3";
export const segmentedItemClass =
  "flex h-30 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-8 text-caption font-medium text-text-tertiary transition-colors disabled:cursor-default disabled:opacity-40";

export interface SegmentedProps
  extends Omit<ComponentProps<typeof ToggleGroup.Root>, "type" | "value" | "defaultValue" | "onValueChange"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Can't be changed, but looks as it is. */
  readOnly?: boolean;
}

/** Segmented / 2 and / 3: pick one of a few options (Theme, period, Soft/Hard). One is always picked. */
export function Segmented({ value, onValueChange, readOnly = false, className, ...props }: SegmentedProps) {
  const field = useFieldControl({
    "aria-describedby": props["aria-describedby"],
    "aria-labelledby": props["aria-labelledby"],
  });
  return (
    <ToggleGroup.Root
      {...props}
      disabled={props.disabled || readOnly}
      type="single"
      value={value}
      // Radix lets you unpick the active item; a segmented control always keeps one.
      onValueChange={(next) => next && onValueChange(next)}
      aria-labelledby={props["aria-label"] ? undefined : field["aria-labelledby"]}
      aria-describedby={field["aria-describedby"]}
      className={cn(
        segmentedTrackClass,
        readOnly && !props.disabled && "pointer-events-none *:disabled:opacity-100",
        className,
      )}
    />
  );
}

/** Segmented / Item / Active and / Idle. */
export function SegmentedItem({ className, ...props }: ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      className={cn(
        segmentedItemClass,
        "data-[state=off]:hover:text-text-secondary data-[state=on]:bg-segment-on data-[state=on]:font-semibold data-[state=on]:text-text-primary data-[state=on]:inset-ring data-[state=on]:inset-ring-segment-on-line",
        className,
      )}
      {...props}
    />
  );
}

import { Minus, Plus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";
import { IconButton } from "./icon-button";

export interface StepperProps extends Omit<ComponentProps<"fieldset">, "children" | "onChange"> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** How the number reads, if not plain. */
  format?: (value: number) => ReactNode;
  decrementLabel: string;
  incrementLabel: string;
  disabled?: boolean;
}

/** Stepper / M: 38px box, minus, a 44px mono value, plus. */
export function Stepper({
  value,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  onValueChange,
  format,
  decrementLabel,
  incrementLabel,
  disabled = false,
  className,
  ...props
}: StepperProps) {
  const field = useFieldControl({
    "aria-describedby": props["aria-describedby"],
    "aria-labelledby": props["aria-labelledby"],
  });
  return (
    <fieldset
      disabled={disabled}
      {...props}
      aria-labelledby={props["aria-label"] ? undefined : field["aria-labelledby"]}
      aria-describedby={field["aria-describedby"]}
      className={cn(
        "inline-flex h-38 min-w-0 shrink-0 items-center gap-2 rounded-10 bg-surface px-4 inset-ring inset-ring-border",
        disabled && "opacity-40",
        className,
      )}
    >
      <IconButton
        icon={Minus}
        label={decrementLabel}
        disabled={disabled || value <= min}
        onClick={() => onValueChange(Math.max(min, value - step))}
      />
      <output
        aria-live="polite"
        className="flex h-28 w-44 items-center justify-center text-mono-13 text-text-primary"
      >
        {format ? format(value) : value}
      </output>
      <IconButton
        icon={Plus}
        label={incrementLabel}
        disabled={disabled || value >= max}
        onClick={() => onValueChange(Math.min(max, value + step))}
      />
    </fieldset>
  );
}

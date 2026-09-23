import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export interface ProgressBarProps extends Omit<ComponentProps<"div">, "children"> {
  /** 0 to 1. Leave it out while there's no telling how far along the work is. */
  value?: number;
  /** Accessible name, such as "Packing images". */
  label?: string;
}

/** Progress / Bar: a 2px line, done part in text-primary. Set the height for the 8px storage meter. */
export function ProgressBar({ value, label, className, ...props }: ProgressBarProps) {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn("relative h-2 w-full overflow-hidden bg-border", className)}
      {...props}
    >
      {pct === undefined ? (
        <div className="h-full w-1/3 bg-text-primary motion-safe:animate-progress-indeterminate" />
      ) : (
        <div
          className="absolute inset-y-0 left-0 bg-text-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

import { Grid2x2, LayoutGrid } from "lucide-react";
import { Slider as RadixSlider } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

export interface SliderProps extends ComponentProps<typeof RadixSlider.Root> {
  /** Accessible name for the thumb, when there's no Field label. */
  thumbLabel?: string;
}

/** Slider / Track: 4px track with a 12px thumb that sits proud of it, 140 wide unless you say otherwise. */
export function Slider({ className, thumbLabel, ...props }: SliderProps) {
  const field = useFieldControl({ "aria-labelledby": props["aria-labelledby"] });
  const thumbs = (props.value ?? props.defaultValue ?? [0]).length;
  return (
    <RadixSlider.Root
      {...props}
      className={cn(
        "relative flex h-4 w-140 shrink-0 cursor-pointer touch-none select-none items-center data-disabled:cursor-default data-disabled:opacity-40",
        className,
      )}
    >
      <RadixSlider.Track className="relative h-4 grow rounded-full bg-elevated-2">
        <RadixSlider.Range className="absolute h-full rounded-full bg-border-strong" />
      </RadixSlider.Track>
      {Array.from({ length: thumbs }, (_, i) => (
        <RadixSlider.Thumb
          // biome-ignore lint/suspicious/noArrayIndexKey: thumbs are positional
          key={i}
          aria-label={thumbLabel}
          aria-labelledby={thumbLabel ? undefined : field["aria-labelledby"]}
          className="block size-12 rounded-full bg-text-primary"
        />
      ))}
    </RadixSlider.Root>
  );
}

export interface SliderRowProps extends SliderProps {
  /** The value as people read it, such as "0.6" or "82". */
  valueLabel: ReactNode;
}

/** The control row of Form / Field / Slider: the track and its value in mono. */
export function SliderRow({ valueLabel, className, ...props }: SliderRowProps) {
  return (
    <div className="flex h-18 w-full items-center gap-12">
      <Slider {...props} className={cn("w-auto flex-1", className)} />
      <span className="shrink-0 text-mono-12 text-text-primary">{valueLabel}</span>
    </div>
  );
}

/** Slider / Zoom: the grid size slider in the feed and library headers. */
export function ZoomSlider({ className, ...props }: SliderProps) {
  return (
    <div className={cn("inline-flex items-center gap-10", className)}>
      <Grid2x2 size={14} aria-hidden className="shrink-0 text-text-tertiary" />
      <Slider {...props} />
      <LayoutGrid size={14} aria-hidden className="shrink-0 text-text-tertiary" />
    </div>
  );
}

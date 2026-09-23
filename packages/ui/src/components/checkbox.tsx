import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

export interface CheckboxProps extends ComponentProps<typeof RadixCheckbox.Root> {
  /** Checkbox / On image: a dark, light-edged box that reads on any photo. */
  onImage?: boolean;
}

/** Checkbox / Off, On, Mixed (checked="indeterminate") and On image. 18px, radius 5. */
export function Checkbox({ onImage = false, className, ...props }: CheckboxProps) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  return (
    <RadixCheckbox.Root
      {...props}
      id={field.id}
      aria-describedby={field["aria-describedby"]}
      className={cn(
        "peer inline-flex size-18 shrink-0 cursor-pointer items-center justify-center rounded-5 inset-ring transition-colors disabled:cursor-default disabled:opacity-40",
        onImage
          ? "bg-overlay-check inset-ring-[1.5px] inset-ring-overlay-fg shadow-check"
          : "inset-ring-control-line",
        "data-[state=checked]:bg-accent data-[state=checked]:inset-ring-0 data-[state=checked]:shadow-none",
        "data-[state=indeterminate]:bg-accent data-[state=indeterminate]:inset-ring-1 data-[state=indeterminate]:inset-ring-accent data-[state=indeterminate]:shadow-none",
        className,
      )}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-accent-fg">
        <Check size={12} aria-hidden className="in-data-[state=indeterminate]:hidden" />
        <Minus size={12} aria-hidden className="in-data-[state=checked]:hidden" />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

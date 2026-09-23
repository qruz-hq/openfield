import { Switch as RadixSwitch } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { useFieldControl } from "./field";

/** Toggle / On and / Off: 32×18 track, 14px knob two pixels in from the edge. */
export function Switch({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) {
  const field = useFieldControl({ id: props.id, "aria-describedby": props["aria-describedby"] });
  return (
    <RadixSwitch.Root
      {...props}
      id={field.id}
      aria-describedby={field["aria-describedby"]}
      className={cn(
        "relative inline-flex h-18 w-32 shrink-0 cursor-pointer rounded-full bg-elevated-2 inset-ring inset-ring-border transition-colors data-[state=checked]:bg-accent data-[state=checked]:inset-ring-0 disabled:cursor-default disabled:opacity-40",
        className,
      )}
    >
      <RadixSwitch.Thumb className="absolute top-2 left-2 size-14 rounded-full bg-text-secondary transition-transform data-[state=checked]:translate-x-14 data-[state=checked]:bg-accent-fg" />
    </RadixSwitch.Root>
  );
}

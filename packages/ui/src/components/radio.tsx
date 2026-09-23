import { RadioGroup as RadixRadioGroup } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadixRadioGroup.Root>) {
  return <RadixRadioGroup.Root className={cn("flex flex-col gap-8", className)} {...props} />;
}

/** Radio / On and / Off: 18px circle, 8px dot. Pair it with a <label htmlFor>. */
export function Radio({ className, ...props }: ComponentProps<typeof RadixRadioGroup.Item>) {
  return (
    <RadixRadioGroup.Item
      className={cn(
        "inline-flex size-18 shrink-0 cursor-pointer items-center justify-center rounded-full inset-ring inset-ring-control-line transition-colors data-[state=checked]:bg-accent data-[state=checked]:inset-ring-0 disabled:cursor-default disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <RadixRadioGroup.Indicator className="size-8 rounded-full bg-accent-fg" />
    </RadixRadioGroup.Item>
  );
}

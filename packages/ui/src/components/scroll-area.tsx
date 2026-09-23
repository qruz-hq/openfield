import { ScrollArea as RadixScrollArea } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** A scroll container with a thin overlay scrollbar, for popover lists and panels. */
export function ScrollArea({ className, children, ...props }: ComponentProps<typeof RadixScrollArea.Root>) {
  return (
    <RadixScrollArea.Root className={cn("relative overflow-hidden", className)} {...props}>
      <RadixScrollArea.Viewport className="size-full rounded-[inherit]">{children}</RadixScrollArea.Viewport>
      <RadixScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-8 touch-none select-none p-2 transition-colors"
      >
        <RadixScrollArea.Thumb className="relative flex-1 rounded-full bg-border-strong" />
      </RadixScrollArea.Scrollbar>
    </RadixScrollArea.Root>
  );
}

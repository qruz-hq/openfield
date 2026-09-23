import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { surfaceVariants } from "./surface";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/**
 * Surface / Popover. Composer popovers sit 12px from their chip; pass side="top" above the composer.
 * Set the width per use (aspect 240, quality 260, model picker 402).
 */
export function PopoverContent({
  className,
  sideOffset = 12,
  align = "start",
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          surfaceVariants({ variant: "popover" }),
          "z-50 max-h-(--radix-popover-content-available-height) outline-none data-[state=open]:animate-pop-in",
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}

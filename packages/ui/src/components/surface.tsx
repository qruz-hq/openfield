import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

// Surface / *: empty shells. Composites put their own children inside.
export const surfaceVariants = cva("flex", {
  variants: {
    variant: {
      card: "flex-col gap-14 rounded-14 bg-elevated p-16 inset-ring inset-ring-border",
      block: "flex-col gap-8 rounded-14 bg-surface p-12",
      "block-list": "flex-col gap-2 rounded-14 bg-surface px-4 py-8",
      popover:
        "flex-col gap-2 overflow-hidden rounded-16 bg-elevated p-8 inset-ring inset-ring-border shadow-popover",
      "floating-bar":
        "h-56 items-center gap-12 rounded-16 bg-elevated py-8 pr-8 pl-16 inset-ring inset-ring-border shadow-popover",
      panel: "w-352 flex-col gap-12 overflow-hidden rounded-20 bg-elevated p-12 inset-ring inset-ring-border",
    },
  },
  defaultVariants: { variant: "card" },
});

export interface SurfaceProps extends ComponentProps<"div">, VariantProps<typeof surfaceVariants> {
  asChild?: boolean;
}

/** Surface / Card, Block, Popover, Floating bar and Panel / Side. */
export function Surface({ variant, asChild = false, className, ...props }: SurfaceProps) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp className={cn(surfaceVariants({ variant }), className)} {...props} />;
}

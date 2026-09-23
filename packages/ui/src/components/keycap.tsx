import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Text / Keycap: a key hint such as "⌘K" or "F". */
export function Keycap({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-20 shrink-0 items-center justify-center rounded-6 bg-elevated-2 px-6 inset-ring inset-ring-border text-mono-12 font-medium text-text-secondary",
        className,
      )}
      {...props}
    />
  );
}

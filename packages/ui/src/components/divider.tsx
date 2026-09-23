import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export interface DividerProps extends Omit<ComponentProps<"hr">, "children"> {
  orientation?: "horizontal" | "vertical";
  /** Horizontal: pad 4 above and below and 8 at the sides, as between menu groups. */
  inset?: boolean;
  /** Vertical height: 24 (selection bar) or 20 inside a 9×36 slot (toolbars). */
  size?: 20 | 24;
}

const line = "shrink-0 border-0 bg-border";

/** Divider / Horizontal, / Horizontal / Inset, / Vertical / 20 and / Vertical / 24. */
export function Divider({
  orientation = "horizontal",
  inset = false,
  size = 24,
  className,
  ...props
}: DividerProps) {
  if (orientation === "vertical") {
    const rule = (
      <hr
        aria-orientation="vertical"
        className={cn(line, size === 20 ? "h-20 w-px" : "h-24 w-px")}
        {...props}
      />
    );
    return size === 20 ? (
      <div className={cn("flex h-36 w-9 shrink-0 items-center justify-center", className)}>{rule}</div>
    ) : (
      <hr aria-orientation="vertical" className={cn(line, "h-24 w-px", className)} {...props} />
    );
  }
  if (inset) {
    return (
      <div className={cn("w-full shrink-0 px-8 py-4", className)}>
        <hr className={cn(line, "h-px w-full")} {...props} />
      </div>
    );
  }
  return <hr className={cn(line, "h-px w-full", className)} {...props} />;
}

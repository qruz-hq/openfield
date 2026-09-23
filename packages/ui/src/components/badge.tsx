import { cva, type VariantProps } from "class-variance-authority";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

// Badge / {Accent, Neutral, Danger, Count}: 18px labels. Accent is always caps ("New").
export const badgeVariants = cva("inline-flex h-18 shrink-0 items-center whitespace-nowrap px-6", {
  variants: {
    variant: {
      accent: "rounded-6 bg-accent-soft inset-ring inset-ring-accent-line text-caps text-accent",
      neutral:
        "rounded-6 bg-elevated-2 inset-ring inset-ring-border text-micro font-medium text-text-secondary",
      danger: "rounded-6 bg-danger-soft text-micro font-medium text-danger",
      count:
        "min-w-18 justify-center rounded-full bg-elevated-2 text-mono-11 font-medium text-text-secondary",
    },
    /** Small caps, as on the model picker's "Edit" and "2K" badges. */
    caps: { true: "text-caps font-semibold" },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ variant, caps, className, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, caps }), className)} {...props} />;
}

/** Badge / Check / 22: the round check on a selected card. */
export function CheckBadge({ className, ...props }: Omit<ComponentProps<"span">, "children">) {
  return (
    <span
      className={cn(
        "inline-flex size-22 shrink-0 items-center justify-center rounded-full bg-accent",
        className,
      )}
      {...props}
    >
      <Check size={14} aria-hidden className="text-accent-fg" />
    </span>
  );
}
